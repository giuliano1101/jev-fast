import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AdmissionRegistry} from '../../src/network/admission.js';
const instance='11111111-1111-4111-8111-111111111111';
const temporary=()=>mkdtempSync(join(tmpdir(),'jev-intent-'));
test('heartbeat expiry preserves operator intent and same registration resumes only after ready and revocation drain',()=>{
 const directory=temporary(),registry=new AdmissionRegistry(directory,null,100),realNow=Date.now;let now=realNow();Date.now=()=>now;
 const api=registry as AdmissionRegistry & {resumeDevice:(id:string,ready:boolean)=>{enabled:boolean;generation:number;desiredEnabled:boolean}};
 try{const device=registry.register('device','Mac'),ai=registry.register('ai','AI');registry.updateDeviceInstance(device.id,instance);registry.setEnabled(device.id,true);registry.setEnabled(ai.id,true);const oldOwner=registry.get(ai.id).owner!;
  now+=101;assert.equal(registry.get(device.id).enabled,false);assert.equal((registry.get(device.id) as {desiredEnabled?:boolean}).desiredEnabled,true);assert.equal(registry.get(ai.id).enabled,false);
  assert.equal(typeof api.resumeDevice,'function');registry.touch(device.id);assert.equal(api.resumeDevice(device.id,false).enabled,false);assert.equal(api.resumeDevice(device.id,true).enabled,false,'old owner revocations must drain first');
  registry.ackRevocations([oldOwner]);const resumed=api.resumeDevice(device.id,true);assert.equal(resumed.enabled,true);assert.equal(resumed.generation,2);assert.equal(resumed.desiredEnabled,true);assert.equal(registry.get(ai.id).enabled,false);assert.equal(registry.get(ai.id).owner,null);
  registry.setEnabled(ai.id,true);assert.notEqual(registry.get(ai.id).owner,oldOwner);
 }finally{Date.now=realNow;registry.close();rmSync(directory,{recursive:true,force:true});}
});
test('operator off while lease-disabled cancels durable intent and new same-name registrations do not inherit it',()=>{
 const directory=temporary(),registry=new AdmissionRegistry(directory,null,100),realNow=Date.now;let now=realNow();Date.now=()=>now;
 const api=registry as AdmissionRegistry & {resumeDevice:(id:string,ready:boolean)=>{enabled:boolean}};
 try{const device=registry.register('device','Mac');registry.updateDeviceInstance(device.id,instance);registry.setEnabled(device.id,true);now+=101;assert.equal(registry.get(device.id).enabled,false);
  registry.setEnabled(device.id,false);assert.equal((registry.get(device.id) as {desiredEnabled?:boolean}).desiredEnabled,false);registry.touch(device.id);assert.equal(api.resumeDevice(device.id,true).enabled,false);
  const fresh=registry.register('device','Mac');registry.updateDeviceInstance(fresh.id,instance);assert.equal(api.resumeDevice(fresh.id,true).enabled,false);
 }finally{Date.now=realNow;registry.close();rmSync(directory,{recursive:true,force:true});}
});
test('lease recovery cannot displace a different operator-selected active device',()=>{
 const directory=temporary(),registry=new AdmissionRegistry(directory,null,100),realNow=Date.now;let now=realNow();Date.now=()=>now;
 const api=registry as AdmissionRegistry & {resumeDevice:(id:string,ready:boolean)=>{enabled:boolean}};
 try{const a=registry.register('device','A');registry.updateDeviceInstance(a.id,instance);registry.setEnabled(a.id,true);now+=101;registry.get(a.id);registry.touch(a.id);
  const b=registry.register('device','B');registry.updateDeviceInstance(b.id,'22222222-2222-4222-8222-222222222222');registry.setEnabled(b.id,true);assert.equal(api.resumeDevice(a.id,true).enabled,false);assert.equal(registry.get(b.id).enabled,true);
 }finally{Date.now=realNow;registry.close();rmSync(directory,{recursive:true,force:true});}
});
test('durable intent survives restart but legacy disabled history never implies permission',()=>{
 const directory=temporary();let registry=new AdmissionRegistry(directory);let enabledId='',disabledId='';
 try{const enabled=registry.register('device','enabled'),disabled=registry.register('device','manually off');enabledId=enabled.id;disabledId=disabled.id;registry.updateDeviceInstance(enabledId,instance);registry.setEnabled(enabledId,true);registry.close();
  const db=new DatabaseSync(join(directory,'network.sqlite'));const rows=db.prepare('SELECT id,data FROM records').all();for(const row of rows){const data=JSON.parse(String(row.data)) as {enabled:boolean;desiredEnabled?:boolean;generation:number};delete data.desiredEnabled;data.enabled=row.id===enabledId;data.generation=1;db.prepare('UPDATE records SET data=? WHERE id=?').run(JSON.stringify(data),String(row.id));}db.close();
  registry=new AdmissionRegistry(directory);assert.equal((registry.get(enabledId) as {desiredEnabled?:boolean}).desiredEnabled,true);assert.equal((registry.get(disabledId) as {desiredEnabled?:boolean}).desiredEnabled,false);assert.equal(registry.isLive(enabledId),false,'restart never revives an old capability');
 }finally{registry.close();rmSync(directory,{recursive:true,force:true});}
});
test('turning off an expired device does not revoke AI owners of a different selected device',()=>{
 const directory=temporary(),registry=new AdmissionRegistry(directory,null,100),realNow=Date.now;let now=realNow();Date.now=()=>now;
 try{const a=registry.register('device','A');registry.updateDeviceInstance(a.id,instance);registry.setEnabled(a.id,true);now+=101;registry.get(a.id);registry.touch(a.id);
  const b=registry.register('device','B'),ai=registry.register('ai','B AI');registry.updateDeviceInstance(b.id,'22222222-2222-4222-8222-222222222222');registry.setEnabled(b.id,true);registry.setEnabled(ai.id,true);const owner=registry.get(ai.id).owner;
  registry.setEnabled(a.id,false);assert.equal(registry.get(b.id).enabled,true);assert.equal(registry.get(ai.id).enabled,true);assert.equal(registry.get(ai.id).owner,owner);assert.deepEqual(registry.revocations(),[]);
 }finally{Date.now=realNow;registry.close();rmSync(directory,{recursive:true,force:true});}
});
