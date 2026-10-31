import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('manual registry is default off, instance scoped, durable and revokes generations before acknowledgment',async()=>{
 const path='../../src/network/admission.js',api=await import(path).catch(()=>({}));assert.equal(typeof api.AdmissionRegistry,'function','manual registry is missing');
 const dir=await mkdtemp(join(tmpdir(),'jev-admission-registry-'));
 let registry=new api.AdmissionRegistry(dir,10000);
 try{
  const device=registry.register('device','my Mac'),a=registry.register('ai','same name'),b=registry.register('ai','same name');
  assert.equal(registry.get(a.id).enabled,false);assert.notEqual(a.id,b.id);
  registry.updateDeviceInstance(device.id,'11111111-1111-4111-8111-111111111111');registry.setEnabled(device.id,true);registry.setEnabled(a.id,true);
  const old=registry.get(a.id).owner;assert.match(old,/^network-/);assert.equal(registry.get(b.id).enabled,false);
  assert.throws(()=>registry.register('ai','bad\nname'),/INVALID_NAME/);
  registry.setEnabled(a.id,false);assert.equal(registry.get(a.id).state,'stopping');assert.ok(registry.revocations().includes(old));
  registry.ackRevocations([old]);assert.equal(registry.get(a.id).state,'pending');registry.setEnabled(a.id,true);assert.notEqual(registry.get(a.id).owner,old);
  registry.close();registry=new api.AdmissionRegistry(dir,10000);assert.equal(registry.get(a.id).enabled,false);
  assert.equal(registry.isLive(a.id),false);const fresh=registry.register('ai','same name');assert.equal(fresh.enabled,false);
  assert.ok(registry.revocations().length);assert.throws(()=>registry.setEnabled(a.id,true),/CONNECTION_OFFLINE/);
 }finally{registry.close();await rm(dir,{recursive:true,force:true});}
});
test('device revocations remain bound to the executing coordinator across device switch and replacement',async()=>{
 const path='../../src/network/admission.js',{AdmissionRegistry}=await import(path);const dir=await mkdtemp(join(tmpdir(),'jev-admission-target-')),registry=new AdmissionRegistry(dir,10000);
 try{
  assert.equal(typeof registry.updateDeviceInstance,'function','durable device target binding missing');
  const a=registry.register('device','Mac A'),b=registry.register('device','Mac B'),ai=registry.register('ai','AI');const ia='11111111-1111-4111-8111-111111111111',ib='22222222-2222-4222-8222-222222222222';
  registry.updateDeviceInstance(a.id,ia);registry.updateDeviceInstance(b.id,ib);registry.setEnabled(a.id,true);registry.setEnabled(ai.id,true);const owner=registry.get(ai.id).owner!;
  registry.setEnabled(a.id,false);assert.equal(registry.get(a.id).state,'stopping');registry.setEnabled(b.id,true);
  assert.deepEqual(registry.revocationsFor(b.id,ib),[]);assert.deepEqual(registry.revocationsFor(a.id,ia),[owner]);
  const replacement=registry.register('device','Mac A replacement');registry.updateDeviceInstance(replacement.id,ia);registry.setEnabled(b.id,false);registry.setEnabled(replacement.id,true);assert.deepEqual(registry.revocationsFor(replacement.id,ia),[owner]);
  registry.ackRevocations([owner]);assert.equal(registry.get(a.id).state,'pending');
 }finally{registry.close();await rm(dir,{recursive:true,force:true});}
});
test('device heartbeat loss fences grants while retaining the process handle for reconnect',async()=>{
 const path='../../src/network/admission.js',{AdmissionRegistry}=await import(path);const dir=await mkdtemp(join(tmpdir(),'jev-admission-reconnect-')),registry=new AdmissionRegistry(dir,10000,100);
 try{
  const device=registry.register('device','Mac'),ai=registry.register('ai','AI');registry.updateDeviceInstance(device.id,'11111111-1111-4111-8111-111111111111');registry.setEnabled(device.id,true);registry.setEnabled(ai.id,true);
  await new Promise(done=>setTimeout(done,130));assert.equal(registry.get(device.id).enabled,false);assert.equal(registry.get(ai.id).enabled,false);
  assert.equal(registry.isLive(device.id),true,'same process handle must survive a dropped network link');assert.equal(registry.touch(device.id).id,device.id);assert.equal(registry.get(device.id).enabled,false);
 }finally{registry.close();await rm(dir,{recursive:true,force:true});}
});
test('device heartbeat during child revocation does not persist the derived stopping state',async()=>{
 const path='../../src/network/admission.js',{AdmissionRegistry}=await import(path);const dir=await mkdtemp(join(tmpdir(),'jev-admission-state-')),registry=new AdmissionRegistry(dir,10000);
 try{
  const device=registry.register('device','Mac'),ai=registry.register('ai','AI'),instance='11111111-1111-4111-8111-111111111111';registry.updateDeviceInstance(device.id,instance);registry.setEnabled(device.id,true);registry.setEnabled(ai.id,true);const owner=registry.get(ai.id).owner!;
  registry.setEnabled(device.id,false);assert.equal(registry.get(device.id).state,'stopping');registry.touch(device.id);registry.updateDeviceInstance(device.id,instance);registry.ackRevocations([owner]);
  assert.equal(registry.get(device.id).state,'pending');assert.equal(registry.setEnabled(device.id,true).enabled,true);
 }finally{registry.close();await rm(dir,{recursive:true,force:true});}
});
