import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {mkdtemp,writeFile,rm,chmod,symlink} from 'node:fs/promises';
import {join} from 'node:path';
const modulePath='../../src/control/admission.js';
const module=await import(modulePath).catch(()=>undefined);
async function fixture(handler:(req:IncomingMessage,res:ServerResponse)=>void){
 const root=await mkdtemp('/tmp/jev-console-admission-');const tokenFile=join(root,'token'),config=join(root,'config.json');await writeFile(tokenFile,'a'.repeat(64),{mode:0o600});
 const server=createServer(handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 await writeFile(config,JSON.stringify({url,tokenFile,publicMcpUrl:'https://example.invalid/mcp'}),{mode:0o600});
 return {root,tokenFile,config,url,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}};
}
const connection={id:'one',name:'Our AI',type:'ai',state:'enabled',enabled:true,generation:1,firstSeen:1,lastSeen:2,owner:'PRIVATE_OWNER',grantDevice:'PRIVATE_GRANT',localInstance:'PRIVATE_INSTANCE'};
test('unified console has a private server-side admission adapter',()=>assert.equal(typeof module?.loadAdmissionAdapter,'function'));
if(module){
 test('actual loopback upstream receives fixed requests, rotating private token and no browser capability leaks',async()=>{
  const requests:{url:string|undefined;token:string|undefined;origin:string|undefined;body:string}[]=[];
  const f=await fixture((req,res)=>{let body='';req.on('data',part=>body+=part);req.on('end',()=>{requests.push({url:req.url,token:req.headers['x-jev-control-token'] as string,origin:req.headers.origin,body});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/api/status'?{connections:[connection]}:{connection:{...connection,enabled:false,state:'stopping'}}));});});
  try{const adapter=await module.loadAdmissionAdapter(f.config);const listed=await adapter.list();assert.equal(listed.publicMcpUrl,'https://example.invalid/mcp');assert.equal(listed.connections[0].name,'Our AI');assert.ok(!JSON.stringify(listed).includes('PRIVATE_'));await writeFile(f.tokenFile,'b'.repeat(64),{mode:0o600});const changed=await adapter.setEnabled('one',false);assert.equal(changed.state,'stopping');assert.deepEqual(requests,[{url:'/api/status',token:'a'.repeat(64),origin:f.url,body:'{}'},{url:'/api/admission',token:'b'.repeat(64),origin:f.url,body:JSON.stringify({id:'one',enabled:false})}]);assert.ok(!JSON.stringify(changed).includes('PRIVATE_'));}
  finally{await f.close();}
 });
 test('unsafe config, non-loopback endpoints and redirected upstreams cannot become credential destinations',async()=>{
  let redirectTargetHits=0;const f=await fixture((req,res)=>{if(req.url==='/api/status'){res.writeHead(302,{location:'/stolen'});res.end();}else{redirectTargetHits++;res.end('{}');}});
  try{assert.equal(typeof module.loadAdmissionAdapter,'function');for(const url of ['https://evil.invalid','http://localhost:1234','http://127.0.0.1:1234/path','http://u:p@127.0.0.1:1234','http://127.0.0.1:1234/?token=x']){await writeFile(f.config,JSON.stringify({url,tokenFile:f.tokenFile}),{mode:0o600});await assert.rejects(module.loadAdmissionAdapter(f.config),/INVALID_ADMISSION_CONFIGURATION/);}await writeFile(f.config,JSON.stringify({url:f.url,tokenFile:f.tokenFile}),{mode:0o600});const adapter=await module.loadAdmissionAdapter(f.config);await assert.rejects(adapter.list(),/CONTROL_ADMISSION_UNAVAILABLE/);assert.equal(redirectTargetHits,0);await chmod(f.config,0o644);await assert.rejects(module.loadAdmissionAdapter(f.config),/UNSAFE_PRIVATE_FILE/);await chmod(f.config,0o600);const link=join(f.root,'linked-token');await symlink(f.tokenFile,link);await writeFile(f.config,JSON.stringify({url:f.url,tokenFile:link}),{mode:0o600});const bad=await module.loadAdmissionAdapter(f.config);await assert.rejects(bad.list(),/CONTROL_ADMISSION_UNAVAILABLE/);}
  finally{await f.close();}
 });
 test('malformed upstream and private errors remain safe while known business rejection survives',async()=>{
  let mode='broken';const f=await fixture((_req,res)=>{res.setHeader('content-type','application/json');if(mode==='broken'){res.end('{PRIVATE_SECRET');return;}res.statusCode=409;res.end(JSON.stringify({error:{code:mode==='known'?'REVOCATION_PENDING':'PRIVATE_SECRET'}}));});
  try{const adapter=await module.loadAdmissionAdapter(f.config);await assert.rejects(adapter.list(),/^Error: CONTROL_ADMISSION_UNAVAILABLE$/);mode='known';await assert.rejects(adapter.setEnabled('one',true),/^Error: REVOCATION_PENDING$/);mode='secret';await assert.rejects(adapter.setEnabled('one',true),/^Error: CONTROL_ADMISSION_UNAVAILABLE$/);}
  finally{await f.close();}
 });
}
