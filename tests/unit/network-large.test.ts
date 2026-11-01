import test from 'node:test';
import assert from 'node:assert/strict';
import {networkFixture} from '../helpers/network-fixture.js';
import {admissionFixture} from '../helpers/admission-fixture.js';
for(const manual of [false,true])test(`${manual?'manual':'bearer'} general request and result transport synthetic 300 KiB state through HTTPS IPC and durable audits`,async()=>{
 const synthetic='x'.repeat(300*1024);let calls=0;
 const chooseAction=async(_client:string,args:{state:unknown})=>{calls++;return {selected_id:'a',synthetic_state:args.state};};
 const f=manual?await admissionFixture({chooseAction}):await networkFixture({chooseAction});
 try{const connected=await f.client(),client='client' in connected?connected.client:connected;if('approve' in f)await f.approve();else await f.ready(client);
  const args={idempotency_key:'large-general',task:'Read synthetic large UI state',state:{synthetic_payload:synthetic},actions:[{id:'a',description:'One observed control'}]},reply=await f.request(client,'jev.choose_action','large-request',args);
  assert.equal(reply.delivery_status,'COMPLETED');assert.equal(reply.reply?.ok,true);assert.equal((reply.reply!.result as {synthetic_state:{synthetic_payload:string}}).synthetic_state.synthetic_payload,synthetic);assert.equal(calls,1);
  const duplicate=await f.request(client,'jev.choose_action','large-request',args);assert.deepEqual(duplicate,reply);assert.equal(calls,1);
 }finally{await f.close();}
});
