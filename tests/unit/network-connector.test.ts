import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Coordinator} from '../../src/service/coordinator.js';
import {readCredential,ipcCall} from '../../src/service/ipc.js';
import type {Engine} from '../../src/core/engine.js';
import {ConnectorJournal} from '../../src/network/store.js';
import type {Delivery} from '../../src/network/protocol.js';
test('connector entry point is inert on import',async()=>{
 const path='../../src/network/connector.js';const api=await import(path).catch(()=>({}));assert.equal(typeof api.startConnector,'function','outbound connector is not implemented');
});
test('local health gives authenticated clients a provider-free coordinator epoch',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'network-health-'));let providerCalls=0;
 const engine={shutdown:async()=>{}} as unknown as Engine;
 let coordinator=await Coordinator.start({runtimeDir:dir,engine,clients:['a'],health:async()=>{providerCalls++;return {};}});
 try{
  const credential=await readCredential(join(dir,'client-a.json'));
  const health=await ipcCall(credential,'service.local_health',{}) as {ready:boolean;instance_id:string};
  assert.equal(health.ready,true);assert.match(health.instance_id,/^[a-f0-9-]{36}$/);assert.equal(providerCalls,0);assert.deepEqual(Object.keys(health).sort(),['instance_id','ready']);
  await assert.rejects(ipcCall(credential,'service.local_health',{extra:true}),/INVALID_ARGUMENTS/);
  await coordinator.close();coordinator=await Coordinator.start({runtimeDir:dir,engine,clients:['a']});
  const fresh=await ipcCall(await readCredential(join(dir,'client-a.json')),'service.local_health',{}) as {instance_id:string};assert.notEqual(fresh.instance_id,health.instance_id);
 }finally{await coordinator.close();rmSync(dir,{recursive:true,force:true});}
});
test('connector persists a claim before execution and quarantines an interrupted claim',()=>{
 const dir=mkdtempSync(join(tmpdir(),'network-journal-')),profile={url:'https://relay.invalid',device_id:'d',agent_id:'a',credentialFile:'/private/client-a.json'};
 const job:Delivery={device_id:'d',agent_id:'a',request_id:'r',method:'jev.open_session',params:{fixture_id:'standard'},delivery_nonce:'b'.repeat(64),expires_at:Date.now()+5000,local_instance_id:randomUUID()};
 let journal=new ConnectorJournal(dir,profile);
 try{
  assert.equal(journal.claim(job),true);journal.close();journal=new ConnectorJournal(dir,profile);
  assert.equal(journal.claim(job),false);assert.deepEqual(journal.pending()?.outcome,{kind:'unknown'});
  journal.ack('r',job.delivery_nonce);assert.equal(journal.pending(),undefined);
  journal.close();assert.throws(()=>new ConnectorJournal(dir,{...profile,url:'https://other.invalid'}),/STORAGE_CORRUPT/);
 }finally{journal.close();rmSync(dir,{recursive:true,force:true});}
});
test('connector journal resends the exact durable reply and rejects changed delivery metadata',()=>{
 const dir=mkdtempSync(join(tmpdir(),'network-reply-')),profile={url:'https://relay.invalid',device_id:'d',agent_id:'a',credentialFile:'/private/client-a.json'};
 const job:Delivery={device_id:'d',agent_id:'a',request_id:'r',method:'jev.open_session',params:{fixture_id:'standard'},delivery_nonce:'c'.repeat(64),expires_at:Date.now()+5000,local_instance_id:randomUUID()};
 let journal=new ConnectorJournal(dir,profile);const outcome={kind:'reply' as const,reply:{ok:false as const,error:{code:'BUSY'}}};
 try{journal.claim(job);journal.finish('r',outcome);journal.close();journal=new ConnectorJournal(dir,profile);assert.deepEqual(journal.pending(),{request_id:'r',delivery_nonce:job.delivery_nonce,outcome});assert.equal(journal.claim(job),false);assert.throws(()=>journal.claim({...job,delivery_nonce:'d'.repeat(64)}),/DELIVERY_CONFLICT/);assert.throws(()=>journal.ack('r','e'.repeat(64)),/JOURNAL_CONFLICT/);
  assert.throws(()=>journal.claim({...job,request_id:'different',params:{fixture_id:'standard',shell:'echo hi'}}));
 }finally{journal.close();rmSync(dir,{recursive:true,force:true});}
});
