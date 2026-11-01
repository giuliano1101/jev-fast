import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHostMcpClient} from '../../src/host/service.js';
const contractPath='../../src/desktop/contracts.js',driverPath='../../src/desktop/driver.js';
const contracts=await import(contractPath).catch(()=>undefined),driver=await import(driverPath).catch(()=>undefined);
test('native desktop exposes a platform-neutral grounded tool contract and native process adapter',()=>{assert.equal(typeof contracts?.parseDesktopTool,'function');assert.equal(typeof driver?.NativeDesktopDriver,'function');});
if(contracts&&driver){
 test('arbitrary native applications and unrestricted text are accepted without application policies',()=>{
  assert.equal(contracts.desktopToolDefinitions.length,14);
  for(const app of ['com.apple.TextEdit','Example Password Tool','C:\\Apps\\Custom.exe','/Applications/Custom.app',4321])assert.equal(contracts.parseDesktopTool('desktop_get_state',{app}).app,app);
  assert.deepEqual(contracts.parseDesktopTool('desktop_click',{app:'Any App',observation_id:'seen',element_id:'real-element'}),{app:'Any App',observation_id:'seen',element_id:'real-element'});
  for(const params of [{app:'Any App',element_id:'old'},{app:'Any App',observation_id:'seen',x:1},{app:'Any App',observation_id:'seen',element_id:'node',x:1,y:2}])assert.throws(()=>contracts.parseDesktopTool('desktop_click',params));
  assert.equal(contracts.parseDesktopTool('desktop_type_text',{app:'App',observation_id:'seen',text:'中文🙂'.repeat(10000)}).text.length,40000);
  assert.throws(()=>contracts.parseDesktopTool('desktop_shell',{command:'ignored'}));
  assert.deepEqual(contracts.parseDesktopTool('desktop_screenshot',{full_display:true}),{full_display:true});
  assert.throws(()=>contracts.parseDesktopTool('desktop_screenshot',{}));
 });
 test('platform launcher chooses native OS backend and never disguises a missing OS',()=>{
  const mac=driver.nativeLaunchSpec('darwin');assert.match(mac.command,/jev-desktop-macos$/);assert.deepEqual(mac.args,[]);
  const win=driver.nativeLaunchSpec('win32');assert.match(win.command,/powershell\.exe$/i);assert.ok(win.args.some((arg:string)=>arg.endsWith('desktop-windows.ps1')));assert.ok(!win.args.includes('Bypass'));
  assert.throws(()=>driver.nativeLaunchSpec('linux'),/DESKTOP_PLATFORM_UNSUPPORTED/);
 });
 async function fixture(){const root=await mkdtemp('/tmp/jev-desktop-driver-'),file=join(root,'native.mjs'),log=join(root,'calls.jsonl');await writeFile(file,`import fs from 'node:fs';import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const r=JSON.parse(line);fs.appendFileSync(process.env.NATIVE_TEST_LOG,JSON.stringify(r)+'\\n');if(r.method==='crash'){process.exit(3);}if(r.method==='hold'){continue;}const result=r.method==='get_state'?{observation_id:'native-snapshot',app:{pid:1,name:r.params.app},elements:[{element_id:'e1',role:'button',label:'Open'}]}:r.method==='screenshot'?{image:{data:'iVBORw0KGgo=',mimeType:'image/png'},image_metadata:{scale:2}}:{method:r.method,params:r.params,status:'input_submitted'};process.stdout.write(JSON.stringify({id:r.id,ok:true,result})+'\\n');}`);return {root,file,log,async close(){await rm(root,{recursive:true,force:true});}};}
 test('native process serializes exact JSON requests, supports fresh restart after crash and never replays old input',async()=>{
  const f=await fixture(),native=new driver.NativeDesktopDriver({command:process.execPath,args:[f.file],env:{NATIVE_TEST_LOG:f.log}});
  try{const result=await native.call('click',{app:'Non-whitelisted',observation_id:'seen',element_id:'real'});assert.equal(result.params.app,'Non-whitelisted');await assert.rejects(native.call('crash',{}),/DESKTOP_NATIVE_UNKNOWN/);await native.call('status',{});const calls=(await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(calls.map(x=>x.method),['click','crash','status']);assert.equal(new Set(calls.map(x=>x.id)).size,3);}
  finally{await native.close();await f.close();}
 });
 test('native shutdown drains its own process and rejects queued work instead of sending late inputs',async()=>{
  const f=await fixture(),native=new driver.NativeDesktopDriver({command:process.execPath,args:[f.file],env:{NATIVE_TEST_LOG:f.log}});
  try{const held=native.call('hold',{});void held.catch(()=>{});for(let i=0;i<100;i++){if((await readFile(f.log,'utf8').catch(()=>'' )).includes('hold'))break;await new Promise(resolve=>setTimeout(resolve,5));}const queued=native.call('click',{app:'later'});void queued.catch(()=>{});await native.close();await assert.rejects(held);await assert.rejects(queued);assert.deepEqual((await readFile(f.log,'utf8')).trim().split('\n').map(line=>JSON.parse(line).method),['hold']);await assert.rejects(native.call('status',{}),/DESKTOP_NATIVE_CLOSED/);}
  finally{await native.close();await f.close();}
 });
 test('actual desktop MCP stdio advertises native tools and separates screenshot pixels from text metadata',async()=>{
  const f=await fixture();const client=await createHostMcpClient({serverCommand:process.execPath,serverArgs:[resolve('dist/src/desktop/main.js'),'--native-command',process.execPath,'--native-arg='+f.file],serverEnv:{NATIVE_TEST_LOG:f.log}});
  try{assert.equal((await client.listTools()).tools.length,14);const seen=await client.callTool({name:'desktop_get_state',arguments:{app:'Arbitrary real app'}});assert.equal(JSON.parse((seen.content[0] as {text:string}).text).app.name,'Arbitrary real app');const screenshot=await client.callTool({name:'desktop_screenshot',arguments:{app:'Any'}});assert.equal(screenshot.content.length,2);assert.equal(screenshot.content[1]!.type,'image');assert.ok(!(screenshot.content[0] as {text:string}).text.includes('iVBOR'));const invalid=await client.callTool({name:'desktop_click',arguments:{app:'Any',x:1,y:2}});assert.equal(invalid.isError,true);}
  finally{await client.close();await f.close();}
 });
 test('normal native shutdown allows paired input release before helper exit',async()=>{
  const root=await mkdtemp('/tmp/jev-desktop-pair-'),file=join(root,'pair.mjs'),log=join(root,'events');
  await writeFile(file,`import fs from 'node:fs';import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const r=JSON.parse(line);fs.appendFileSync(process.env.NATIVE_TEST_LOG,'down\\n');await new Promise(resolve=>setTimeout(resolve,200));fs.appendFileSync(process.env.NATIVE_TEST_LOG,'up\\n');process.stdout.write(JSON.stringify({id:r.id,ok:true,result:{released:true}})+'\\n');}`);
  const native=new driver.NativeDesktopDriver({command:process.execPath,args:[file],env:{NATIVE_TEST_LOG:log}});
  try{const action=native.call('drag',{});void action.catch(()=>{});while(!(await readFile(log,'utf8').catch(()=>'')))await new Promise(resolve=>setTimeout(resolve,5));await native.close();assert.equal((await action).released,true);assert.equal(await readFile(log,'utf8'),'down\nup\n');}
  finally{await native.close();await rm(root,{recursive:true,force:true});}
 });
}
