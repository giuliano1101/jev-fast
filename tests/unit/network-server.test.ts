import test from 'node:test';
import assert from 'node:assert/strict';
import {networkToolDefinitions,MAX_BODY} from '../../src/network/protocol.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:https';
import {randomBytes} from 'node:crypto';
import {makeRemoteCertificates} from '../helpers/remote-fixture.js';
test('HTTPS relay uses actual stateless MCP with strict host, origin, roles, expiry and bounds',async()=>{
 const path='../../src/network/server.js';const api=await import(path).catch(()=>({}));assert.equal(typeof api.startNetworkServer,'function','HTTPS network MCP server is missing');
 const certs=makeRemoteCertificates(),dir=mkdtempSync(join(tmpdir(),'network-server-'));
 const token={token:randomBytes(32).toString('hex'),expiresAt:Date.now()+60000},connector={...token,token:randomBytes(32).toString('hex')};
 const relay=await api.startNetworkServer({host:'127.0.0.1',port:0,allowedOrigins:['https://trusted.invalid'],deviceId:'d',agentId:'a',storeDir:dir,tls:certs.server,mcpToken:token,connectorToken:connector});
 const post=(body:unknown,headers:Record<string,string>={},path='/mcp')=>new Promise<{status:number;body:string}>((resolve,reject)=>{
  const req=request(relay.url+path,{method:'POST',servername:'localhost',ca:certs.ca,headers:{authorization:'Bearer '+token.token,'content-type':'application/json',accept:'application/json, text/event-stream',...headers}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode!,body}));});req.on('error',reject);req.end(typeof body==='string'?body:JSON.stringify(body));
 });
 try{
  const init=await post({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}});assert.equal(init.status,200);
  const listed=await post({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});assert.equal(listed.status,200);assert.equal(JSON.parse(listed.body).result.tools.length,networkToolDefinitions.length);
  assert.equal((await post({}, {authorization:'Bearer '+connector.token})).status,401);
  assert.equal((await post({}, {},'/connector/sync')).status,401);
  assert.equal((await post({}, {origin:'https://evil.invalid'})).status,403);
  assert.equal((await post({}, {host:'evil.invalid'})).status,403);
  assert.equal((await post('x'.repeat(MAX_BODY+1))).status,413);
  const duplicateAuth=await new Promise<number>((done,fail)=>{const req=request(relay.url+'/mcp',{method:'POST',servername:'localhost',ca:certs.ca,headers:['Host',new URL(relay.url).host,'Authorization','Bearer '+token.token,'Authorization','Bearer '+connector.token,'Content-Type','application/json','Accept','application/json, text/event-stream']},res=>{res.resume();res.once('end',()=>done(res.statusCode!));});req.on('error',fail);req.end(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list',params:{}}));});
  assert.equal(duplicateAuth,401,'duplicate authorization headers must not choose the first credential');
  token.expiresAt=Date.now()-1;assert.equal((await post({})).status,401);
 }finally{await relay.close();certs.close();rmSync(dir,{recursive:true,force:true});}
});
test('failed TLS startup releases only its own relay ownership and preserves the audit',async()=>{
 const path='../../src/network/server.js';const {startNetworkServer}=await import(path);
 const certs=makeRemoteCertificates(),dir=mkdtempSync(join(tmpdir(),'network-tls-failure-'));
 const options={host:'127.0.0.1',port:0,allowedOrigins:[],deviceId:'d',agentId:'a',storeDir:dir,tls:certs.server,mcpToken:{token:randomBytes(32).toString('hex'),expiresAt:Date.now()+60000},connectorToken:{token:randomBytes(32).toString('hex'),expiresAt:Date.now()+60000}};
 const storePath='../../src/network/store.js';const {RelayStore}=await import(storePath);const seeded=new RelayStore({directory:dir,deviceId:'d',agentId:'a'});seeded.submit('jev.open_session',{request_id:'audit',params:{fixture_id:'standard'}});seeded.close();
 try{
  await assert.rejects(startNetworkServer({...options,tls:{key:Buffer.from('invalid private key'),cert:certs.server.cert}}));
  const healthy=await startNetworkServer(options);try{assert.equal(healthy.store.get('audit').delivery_status,'REJECTED');}finally{await healthy.close();}
 }finally{certs.close();rmSync(dir,{recursive:true,force:true});}
});
test('relay close releases storage even when the HTTPS server is already closed',async()=>{
 const path='../../src/network/server.js';const {startNetworkServer}=await import(path);
 const certs=makeRemoteCertificates(),dir=mkdtempSync(join(tmpdir(),'network-close-failure-'));
 const options={host:'127.0.0.1',port:0,allowedOrigins:[],deviceId:'d',agentId:'a',storeDir:dir,tls:certs.server,mcpToken:{token:randomBytes(32).toString('hex'),expiresAt:Date.now()+60000},connectorToken:{token:randomBytes(32).toString('hex'),expiresAt:Date.now()+60000}};
 const relay=await startNetworkServer(options);
 try{
  await new Promise<void>((done,fail)=>relay.server.close((error:Error|undefined)=>error?fail(error):done()));
  await assert.rejects(relay.close());
  const reopened=await startNetworkServer(options);await reopened.close();
 }finally{await relay.close().catch(()=>{});certs.close();rmSync(dir,{recursive:true,force:true});}
});
