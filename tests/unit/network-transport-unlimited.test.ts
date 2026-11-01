import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:https';
import {randomUUID,createHash} from 'node:crypto';
import {networkFixture,until} from '../helpers/network-fixture.js';
import {admissionFixture} from '../helpers/admission-fixture.js';
for(const manual of [false,true])test(`${manual?'manual':'bearer'} connector dispatches more than four independent jobs`,async()=>{
 const f=manual?await admissionFixture():await networkFixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let entered=0;
 const original=f.engine.openSession.bind(f.engine);f.engine.openSession=async()=>{entered++;await gate;return {session_id:randomUUID(),capabilities:[],allowed_origin:'http://127.0.0.1:9999'};};
 try{
  const connection=await f.client(),client='client' in connection?connection.client:connection;
  if('approve' in f)await f.approve();else await f.ready(client);
  for(let i=0;i<6;i++)await f.submit(client,'jev.open_session',`many-${i}`,{fixture_id:'standard'});
  await until(async()=>entered,count=>count===6,2500);assert.equal(entered,6);release();await f.connector!.stop();
  const cid='row' in f?(await f.row('ai','Our AI')).id:null;
  for(let i=0;i<6;i++){const rid=`many-${i}`,key=cid?createHash('sha256').update(cid+'\0'+rid).digest('hex'):rid;assert.equal(f.net.store.get(key).delivery_status,'COMPLETED');}
 }finally{release();f.engine.openSession=original;await f.close();}
});
for(const manual of [false,true])test(`${manual?'manual':'bearer'} HTTP relay accepts work with over 32 pending request bodies`,async()=>{
 const f=manual?await admissionFixture({local:false,connector:false}):await networkFixture({local:false,connector:false});
 const requests:ReturnType<typeof request>[]=[];
 try{
  for(let i=0;i<35;i++){
   const req=request(f.net.url+(manual?'/connector/register':'/mcp'),{method:'POST',ca:f.certs.ca,agent:false,headers:{'content-type':'application/json',...(manual?{}:{authorization:'Bearer '+('tokens' in f?f.tokens.mcp:'')})}},res=>res.resume());req.on('error',()=>{});req.flushHeaders();requests.push(req);
  }
  await new Promise(done=>setTimeout(done,200));
  const status=await new Promise<number>((done,fail)=>{const req=request(f.net.url+'/health',{method:'GET',ca:f.certs.ca,agent:false},res=>{res.resume();res.on('end',()=>done(res.statusCode!));});req.on('error',fail);req.end();});
  assert.equal(status,200);assert.equal(f.net.server.maxConnections,undefined);assert.equal(f.net.server.maxRequestsPerSocket??0,0);
 }finally{for(const req of requests)req.destroy();await f.close();}
});
