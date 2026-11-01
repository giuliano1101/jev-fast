import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {admissionFixture} from '../helpers/admission-fixture.js';
import {until} from '../helpers/network-fixture.js';
async function ready(f:Awaited<ReturnType<typeof admissionFixture>>){const device=await f.row('device','Our Mac mini');await f.enable(device.id);await until(async()=>f.net.store.status(),row=>row.local_ready);return device;}
test('opaque continuation preserves the original async request and session owner across short MCP transports',async()=>{
 const f=await admissionFixture({autoAdmitAi:true,allowContinuations:true});const original=f.engine.openSession.bind(f.engine);let release!:()=>void,entered=false;const gate=new Promise<void>(done=>release=done);
 f.engine.openSession=async(client,args)=>{entered=true;await gate;return original(client,args);};
 try{await ready(f);const a=await f.client('short client');const status=await f.tool(a.client,'jev.network_status'),token=status.continuation_token;assert.equal(typeof token,'string');assert.match(token as string,/^[a-f0-9]{64}$/);assert.equal(status.continuation_supported,true);
  const submitted=await f.submit(a.client,'jev.open_session','original-open',{fixture_id:'standard'});assert.equal(submitted.delivery_status,'QUEUED');await until(async()=>entered,Boolean);await a.transport.terminateSession();
  const b=await f.client('different label');const context={continuation_token:token};const resumed=await f.tool(b.client,'jev.network_status',context);assert.equal(resumed.connection_id,status.connection_id);assert.equal(resumed.enabled,true);
  const pending=await f.tool(b.client,'jev.request_status',{...context,request_id:'original-open'});assert.equal(pending.delivery_status,'DISPATCHED');
  assert.equal((await f.tool(b.client,'jev.request_status',{request_id:'original-open'})).code,'REQUEST_NOT_FOUND');
  assert.equal((await f.tool(b.client,'jev.request_status',{request_id:'original-open',continuation_token:randomBytes(32).toString('hex')})).code,'CONTINUATION_INVALID');
  const own=await f.tool(b.client,'jev.network_status');assert.notEqual(own.connection_id,status.connection_id);assert.equal((await f.tool(b.client,'jev.request_status',{request_id:'original-open',continuation_token:own.continuation_token})).code,'REQUEST_NOT_FOUND');
  release();const finished=await until(()=>f.tool(b.client,'jev.request_status',{...context,request_id:'original-open'}),row=>row.delivery_status==='COMPLETED');const session_id=(finished.reply as {result:{session_id:string}}).result.session_id;
  assert.deepEqual(await f.tool(b.client,'jev.open_session',{...context,request_id:'original-open',params:{fixture_id:'standard'}}),finished);assert.equal(Object.keys(f.engine.ledger.state.sessions).length,1);
  await f.tool(b.client,'jev.status',{...context,request_id:'same-owner',params:{session_id}});const inspected=await until(()=>f.tool(b.client,'jev.request_status',{...context,request_id:'same-owner'}),row=>row.delivery_status==='COMPLETED');assert.equal((inspected.reply as {ok:boolean}).ok,true);
  await b.transport.terminateSession();const c=await f.client('third client');assert.equal((await f.tool(c.client,'jev.network_status',context)).connection_id,status.connection_id);
  assert.equal((await f.tool(c.client,'jev.release_connection',context)).released,true);await until(async()=>Object.values(f.engine.ledger.state.sessions),rows=>rows.every(row=>row.closed));assert.equal((await f.tool(c.client,'jev.network_status',context)).code,'CONTINUATION_INVALID');
 }finally{release();f.engine.openSession=original;await f.close();}
});
for(const shutdown of ['release','manual-off','device-off'] as const)test(`${shutdown} invalidates retained continuation and cancels its pending goal`,async()=>{
 const f=await admissionFixture({autoAdmitAi:true,allowContinuations:true});let unhold:(()=>void)|undefined;
 try{const device=await ready(f),a=await f.client(),status=await f.tool(a.client,'jev.network_status'),context={continuation_token:status.continuation_token};assert.equal(typeof status.continuation_token,'string');
  const opened=await f.request(a.client,'jev.open_session','open',{fixture_id:'standard'}),session_id=(opened.reply!.result as {session_id:string}).session_id,gate=f.provider.holdNext();unhold=gate.release;
  await f.submit(a.client,'jev.run_goal','held',{session_id,goal_id:'held-goal',idempotency_key:'held-key',goal:{task:'form',seed:4,language:'en'},success:{kind:'task_complete'}});await gate.entered;await a.transport.terminateSession();
  const b=await f.client('next call');if(shutdown==='release')assert.equal((await f.tool(b.client,'jev.release_connection',context)).released,true);else await f.enable(shutdown==='manual-off'?String(status.connection_id):device.id,false);
  assert.equal((await f.tool(b.client,'jev.network_status',context)).code,'CONTINUATION_INVALID');await until(async()=>Object.values(f.engine.ledger.state.goals),rows=>rows.length===1&&rows[0]!.status==='CANCELLED');assert.equal(f.browser.physical,0);
 }finally{unhold?.();await f.close();}
});
test('continuations remain unavailable unless the operator explicitly configures the policy',async()=>{
 const f=await admissionFixture({autoAdmitAi:true});try{await ready(f);const a=await f.client(),status=await f.tool(a.client,'jev.network_status');assert.equal(status.continuation_token,undefined);await a.transport.terminateSession();assert.equal(f.net.registry.get(String(status.connection_id)).enabled,false);}finally{await f.close();}
});
