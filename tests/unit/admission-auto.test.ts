import test from 'node:test';
import assert from 'node:assert/strict';
import {admissionFixture} from '../helpers/admission-fixture.js';
import {until} from '../helpers/network-fixture.js';
test('operator auto AI policy admits each short lived MCP instance during initialization',async()=>{
 const f=await admissionFixture({autoAdmitAi:true});
 try{const device=await f.row('device','Our Mac mini');await f.enable(device.id);await until(async()=>f.net.store.status(),row=>row.local_ready);
  for(let i=0;i<3;i++){const {client,transport}=await f.client('Short AI');const current=f.net.registry.list().filter((row:{type:string})=>row.type==='ai').at(-1)!;
   assert.equal(current.enabled,true,'initialize must finish with the operator policy applied');assert.equal((await f.tool(client,'jev.network_status')).enabled,true);
   await transport.terminateSession();assert.equal(f.net.registry.get(current.id).enabled,false);
  }
 }finally{await f.close();}
});
test('auto admission retries a never admitted connection after device readiness but respects explicit owner off',async()=>{
 const f=await admissionFixture({autoAdmitAi:true});
 try{const {client}=await f.client(),ai=await f.row('ai','Our AI');assert.equal(ai.enabled,false);
  const device=await f.row('device','Our Mac mini');await f.enable(device.id);await until(async()=>f.net.store.status(),row=>row.local_ready);
  assert.equal((await f.tool(client,'jev.network_status')).enabled,true);
  await f.enable(ai.id,false);await until(async()=>f.rows().find(row=>row.id===ai.id)!,row=>row.state!=='stopping');
  assert.equal((await f.tool(client,'jev.network_status')).enabled,false,'operator off cannot be undone by an AI request');
  await f.enable(device.id,false);const fresh=await f.client('Other AI');assert.equal((await f.tool(fresh.client,'jev.network_status')).enabled,false);
 }finally{await f.close();}
});
