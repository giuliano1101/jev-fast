import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const modulePath='../../src/control/server.js';
const panel=await import(modulePath).catch(()=>undefined);
test('control panel exports the loopback server and direct lifecycle adapter',()=>{
 assert.equal(typeof panel?.startControlPanel,'function','missing local control panel server');
 assert.equal(typeof panel?.LifecycleControlAdapter,'function');
});
function http(url:string,method='GET',headers:Record<string,string>={},body=''):Promise<{status:number;headers:Record<string,string|string[]|undefined>;body:string}>{return new Promise((resolve,reject)=>{const req=request(url,{method,headers},res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:data}));});req.on('error',reject);req.end(body);});}
if(panel){
 test('startup parses only fixed runtime/config/port arguments',()=>{
  assert.deepEqual(panel.parseControlArgs([]),{runtime:panel.defaultRuntime(),port:47831,help:false});
  assert.equal(panel.parseControlArgs(['--open']).open,true);
  assert.deepEqual(panel.browserLaunch('darwin','http://127.0.0.1:47831/#token'),{file:'/usr/bin/open',args:['http://127.0.0.1:47831/#token']});
  assert.throws(()=>panel.browserLaunch('win32','http://127.0.0.1:47831'),/CONTROL_BROWSER_OPEN_UNSUPPORTED/);
  assert.equal(panel.parseControlArgs(['--port','0','--runtime','/tmp/one','--config','/tmp/profile']).port,0);
  for(const args of [['--port','-1'],['--port','65536'],['--port','1.2'],['--host','0.0.0.0'],['--runtime'],['--config',''],['--token-file',''],['extra'],['--help','--port','1']])assert.throws(()=>panel.parseControlArgs(args),/INVALID_ARGUMENTS/);
 });
 test('server serves a Chinese scoped UI without invoking lifecycle and requires exact host origin token',async()=>{
  const calls:string[]=[];const adapter={status:async()=>{calls.push('status');return {state:'unavailable',mode:'unknown',remoteReachable:null};},start:async()=>{calls.push('start');},stop:async()=>{calls.push('stop');}};
  const server=await panel.startControlPanel({runtime:'/tmp/control-unit',port:0,adapter});
  try{
   assert.equal(calls.length,0);assert.match(server.url,/^http:\/\/127\.0\.0\.1:\d+\/#/);
   const origin=new URL(server.url).origin,token=new URL(server.url).hash.slice(1),auth={'x-jev-control-token':token,origin};
   const root=await http(origin+'/');assert.equal(root.status,200);assert.match(root.body,/启动服务/);assert.match(root.body,/运行能力以实际服务检查为准/);assert.doesNotMatch(root.body,/MCP|CLI|连接管理/);const script=await http(origin+'/app.js');assert.match(script.body,/sessionStorage/);assert.match(script.body,/history.replaceState/);assert.match(root.headers['content-security-policy'] as string,/default-src 'none'/);assert.equal(root.headers['cache-control'],'no-store');assert.equal(root.headers['referrer-policy'],'no-referrer');
   assert.equal((await http(origin+'/api/status')).status,403);
   assert.equal((await http(origin+'/api/status','GET',{'x-jev-control-token':token})).status,403);
   assert.equal((await http(origin+'/api/status','GET',{...auth,origin:'http://evil.example'})).status,403);
   assert.equal((await http(origin+'/api/status','GET',{...auth,'x-jev-control-token':'é'.repeat(64)})).status,403);
   assert.equal((await http(origin+'/api/status','GET',{...auth,host:'localhost:'+new URL(origin).port})).status,403);
   assert.equal((await http(origin+'/api/status','GET',{...auth,host:'127.0.0.1'})).status,403);
   assert.equal((await http(origin+'/api/status','GET',{...auth,'sec-fetch-site':'cross-site'})).status,403);
   const status=await http(origin+'/api/status','GET',auth);assert.equal(status.status,200);assert.equal(JSON.parse(status.body).state,'unavailable');
   assert.equal((await http(origin+'/api/start','POST',auth,'{"runtime":"/tmp/evil"}')).status,400);
   assert.equal((await http(origin+'/api/start','POST',auth,'x'.repeat(2049))).status,413);
   assert.equal((await http(origin+'/api/start','GET',auth)).status,405);
   assert.equal((await http(origin+'/api/stop','OPTIONS',auth)).status,405);
   assert.equal((await http(origin+'/api/unknown','POST',auth)).status,404);
   assert.equal((await http(origin+'/api/status?config=evil','GET',auth)).status,404);
   assert.equal((await http(origin+'/api/start','POST',auth)).status,200);assert.ok(calls.includes('start'));
   assert.equal((await http(origin+'/api/stop','POST',auth)).status,200);assert.ok(calls.includes('stop'));
   assert.equal(root.headers['access-control-allow-origin'],undefined);
  }finally{await server.close();}
  assert.equal(calls.filter(x=>x==='stop').length,1,'closing panel must not stop coordinator');
 });
 test('slow status does not block operator stop, while mutations serialize and errors are redacted',async()=>{
  let finishStatus:()=>void=()=>{},releaseStart:()=>void=()=>{};const calls:string[]=[];
  const adapter={status:()=>new Promise(resolve=>{finishStatus=()=>resolve({state:'blocked',mode:'unknown',remoteReachable:null});}),start:()=>new Promise<void>(resolve=>{calls.push('start');releaseStart=resolve;}),stop:async()=>{calls.push('stop');throw new Error('SECRET /private/key');}};
  const server=await panel.startControlPanel({runtime:'/tmp/serial-control',port:0,adapter});const origin=new URL(server.url).origin,auth={origin,'x-jev-control-token':new URL(server.url).hash.slice(1)};
  try{
   const status=http(origin+'/api/status','GET',auth);await new Promise(resolve=>setTimeout(resolve,20));
   const stopped=await http(origin+'/api/stop','POST',auth);assert.equal(stopped.status,503);assert.deepEqual(JSON.parse(stopped.body),{error:{code:'CONTROL_ACTION_FAILED'}});assert.ok(!stopped.body.includes('SECRET'));
   const started=http(origin+'/api/start','POST',auth);await new Promise(resolve=>setTimeout(resolve,20));const nextStop=http(origin+'/api/stop','POST',auth);await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(calls,['stop','start']);releaseStart();await started;await nextStop;finishStatus();await status;
  }finally{finishStatus();releaseStart();await server.close();}
 });
 test('completed request bodies do not impose a five-second deadline on lifecycle or status commands',{timeout:10000},async()=>{
  const delay=()=>new Promise<void>(resolve=>setTimeout(resolve,5600));
  const adapter={status:async()=>{await delay();return {state:'running',mode:'mock',remoteReachable:null};},start:delay,stop:async()=>{}};
  const server=await panel.startControlPanel({runtime:'/tmp/slow-command-control',port:0,adapter});
  const origin=new URL(server.url).origin,auth={origin,'x-jev-control-token':new URL(server.url).hash.slice(1)};
  try{
   const [started,status]=await Promise.all([http(origin+'/api/start','POST',auth),http(origin+'/api/status','POST',auth)]);
   assert.equal(started.status,200);assert.equal(status.status,200);assert.equal(JSON.parse(status.body).state,'running');
  }finally{await server.close();}
 });
 test('unfinished request bodies retain their own bounded read deadline',{timeout:8000},async()=>{
  let invoked=false;const adapter={status:async()=>({state:'unavailable',mode:'unknown',remoteReachable:null}),start:async()=>{invoked=true;},stop:async()=>{}};
  const server=await panel.startControlPanel({runtime:'/tmp/slow-body-control',port:0,adapter});
  const origin=new URL(server.url).origin,auth={origin,'x-jev-control-token':new URL(server.url).hash.slice(1)};
  try{
   const started=Date.now();await new Promise<void>((resolve,reject)=>{
    const req=request(origin+'/api/start',{method:'POST',headers:{...auth,'content-length':'2'}},()=>reject(new Error('incomplete body must not execute')));
    req.once('error',()=>resolve());req.write('x');
   });
   assert.ok(Date.now()-started>=4500);assert.equal(invoked,false);
  }finally{await server.close();}
 });
 test('adapter calls direct lifecycle functions and projects allowlisted installation data',async()=>{
  const calls:unknown[]=[];const response={ready:true,provider:'jev',transport:'remote',remoteReachable:false,routeCompatible:false,identity:{secret:'SECRET'},installation:{node:{supported:true},runtime:{status:'private'},socket:{status:'private'}}};
  const adapter=new panel.LifecycleControlAdapter({runtime:'/tmp/fixed-runtime',config:'/tmp/fixed-config',lifecycle:{inspectService:async(runtime:string)=>{calls.push(runtime);return response;},startService:async(options:unknown)=>{calls.push(options);},stopService:async(runtime:string)=>{calls.push(runtime);}}});
  assert.deepEqual(await adapter.status(),{state:'running',mode:'remote',decisionProvider:'jev',remoteReachable:false,routeCompatible:false,installation:{nodeSupported:true,chromiumAvailable:null,runtime:'private',socket:'private'}});
  await adapter.start();await adapter.stop();assert.deepEqual(calls,['/tmp/fixed-runtime',{runtime:'/tmp/fixed-runtime',configFile:'/tmp/fixed-config'},'/tmp/fixed-runtime']);
 });
}

if(panel)test('retired admission routes are absent from the per-host panel',async()=>{
 const server=await panel.startControlPanel({runtime:'/tmp/no-admission',port:0,adapter:{status:async()=>({state:'unavailable',mode:'unknown',remoteReachable:null}),start:async()=>{},stop:async()=>{}}});
 try{const origin=new URL(server.url).origin,auth={origin,'x-jev-control-token':new URL(server.url).hash.slice(1)};for(const path of ['connections','admission'])assert.equal((await http(origin+'/api/'+path,'POST',auth)).status,404);}finally{await server.close();}
});
if(panel)test('fixed private panel token keeps the same console capability across restart',async()=>{const root=await mkdtemp('/tmp/jev-panel-token-'),tokenFile=join(root,'token');await writeFile(tokenFile,'a'.repeat(64),{mode:0o600});const adapter={status:async()=>({state:'unavailable',mode:'unknown',decisionProvider:'unknown',remoteReachable:null}),start:async()=>{},stop:async()=>{}};let server=await panel.startControlPanel({runtime:root,port:0,tokenFile,adapter});try{const token=new URL(server.url).hash;await server.close();server=await panel.startControlPanel({runtime:root,port:0,tokenFile,adapter});assert.equal(new URL(server.url).hash,token);const origin=new URL(server.url).origin;assert.equal((await http(origin+'/api/status','POST',{origin,'x-jev-control-token':token.slice(1)})).status,200);}finally{await server.close();await rm(root,{recursive:true,force:true});}});
