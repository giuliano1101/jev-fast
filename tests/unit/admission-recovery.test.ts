import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {admissionFixture} from '../helpers/admission-fixture.js';
import {until} from '../helpers/network-fixture.js';
test('transient connector lease loss recovers operator-selected device without reviving old AI owners or replaying UNKNOWN',async()=>{
 const f=await admissionFixture({proxy:true,leaseMs:1000,autoAdmitAi:true,allowContinuations:true});
 try{const device=await f.row('device','Our Mac mini');await f.enable(device.id);await until(async()=>f.net.store.status(),s=>s.local_ready);const a=await f.client(),status=await f.tool(a.client,'jev.network_status'),context={continuation_token:status.continuation_token};assert.equal(status.enabled,true);
  const opened=await f.request(a.client,'jev.open_session','open',{fixture_id:'standard'}),session_id=(opened.reply!.result as {session_id:string}).session_id;
  f.browser.loseNextResponse=true;const params={session_id,goal_id:'unknown-goal',idempotency_key:'unknown-key',goal:{task:'form',language:'en',seed:7},success:{kind:'task_complete'}};
  const before=await f.request(a.client,'jev.run_goal','uncertain',params);assert.equal((before.reply!.result as {status:string}).status,'UNKNOWN');const physical=f.browser.physical,providerCalls=f.provider.calls;
  f.proxy.offline=true;await until(async()=>f.net.registry.get(device.id),row=>!row.enabled);assert.equal((f.net.registry.get(device.id) as {desiredEnabled?:boolean}).desiredEnabled,true);assert.equal((await f.tool(a.client,'jev.network_status',context)).code,'CONTINUATION_INVALID');
  f.proxy.offline=false;await until(async()=>f.net.registry.get(device.id),row=>row.enabled);await until(async()=>f.net.store.status(),row=>row.local_ready);assert.equal(f.connector!.registrationId(),device.id);assert.equal(f.net.registry.get(String(status.connection_id)).enabled,false);
  const b=await f.client('new AI');assert.equal((await f.tool(b.client,'jev.network_status')).enabled,true);assert.equal((await f.tool(b.client,'jev.network_status',context)).code,'CONTINUATION_INVALID');
  const inaccessible=await f.request(b.client,'jev.run_goal','new-owner-cannot-replay',params);assert.equal(inaccessible.reply?.error?.code,'UNAUTHORIZED');
  const original=createHash('sha256').update(String(status.connection_id)+'\0uncertain').digest('hex');assert.equal((f.net.store.get(original).reply!.result as {status:string}).status,'UNKNOWN');assert.equal(f.browser.physical,physical);assert.equal(f.provider.calls,providerCalls);
  await f.enable(device.id,false);await until(async()=>f.net.registry.get(device.id),row=>row.state!=='stopping');await new Promise(done=>setTimeout(done,300));assert.equal(f.net.registry.get(device.id).enabled,false);assert.equal((f.net.registry.get(device.id) as {desiredEnabled?:boolean}).desiredEnabled,false);
 }finally{f.proxy.offline=false;await f.close();}
});
