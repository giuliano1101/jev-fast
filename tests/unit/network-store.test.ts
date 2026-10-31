import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
test('relay durability fences duplicates, restarts, nonces and offline IDs',async()=>{
 const path='../../src/network/store.js';const api=await import(path).catch(()=>({}));
 assert.equal(typeof api.RelayStore,'function','durable relay is not implemented');
 const dir=mkdtempSync(join(tmpdir(),'network-store-'));const options={directory:dir,deviceId:'d',agentId:'a'};
 let store=new api.RelayStore(options);
 const cid=randomUUID(),instance=randomUUID();
 const sync={connector_id:cid,ready:true,local_instance_id:instance,capacity:1,results:[]};
 const request={request_id:'one',params:{fixture_id:'standard'}};
 try{
  assert.equal(store.submit('jev.open_session',request).delivery_status,'REJECTED');
  store.sync(sync);
  assert.equal(store.submit('jev.open_session',request).delivery_status,'REJECTED');
  assert.equal(store.submit('jev.open_session',{...request,request_id:'two'}).delivery_status,'QUEUED');
  assert.throws(()=>store.submit('jev.observe',{request_id:'two',params:{session_id:'s'}}),/IDEMPOTENCY_CONFLICT/);
  const job=store.sync(sync).job;assert.equal(job.request_id,'two');assert.equal(job.local_instance_id,instance);
  assert.equal(store.get('two').delivery_status,'DISPATCHED');assert.equal(store.sync(sync).job,null);
  assert.throws(()=>new api.RelayStore(options),/STORAGE_OWNED/);
  assert.throws(()=>store.sync({...sync,connector_id:randomUUID()}),/CONNECTOR_FENCED/);
  store.submit('jev.open_session',{...request,request_id:'queued'});
  store.close();store=new api.RelayStore(options);
  assert.equal(store.get('two').delivery_status,'UNKNOWN');assert.equal(store.get('queued').delivery_status,'REJECTED');
  assert.equal(store.sync(sync).job,null);
  const result={request_id:'two',delivery_nonce:job.delivery_nonce,outcome:{kind:'reply',reply:{ok:true,result:{session_id:'s'}}}};
  assert.throws(()=>store.sync({...sync,results:[{...result,delivery_nonce:'a'.repeat(64)}]}),/RECEIPT_CONFLICT/);
  store.sync({...sync,results:[result]});assert.equal(store.get('two').delivery_status,'COMPLETED');
  store.sync({...sync,results:[result]});
  assert.throws(()=>store.sync({...sync,results:[{...result,outcome:{kind:'unknown'}}]}),/RECEIPT_CONFLICT/);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('relay rejects mutated audit bytes and refuses to erase or reopen them',async()=>{
 const path='../../src/network/store.js';const api=await import(path).catch(()=>({}));assert.equal(typeof api.RelayStore,'function');
 const dir=mkdtempSync(join(tmpdir(),'network-corrupt-'));const options={directory:dir,deviceId:'d',agentId:'a'};
 const store=new api.RelayStore(options);store.close();const file=join(dir,'network.sqlite');
 const bytes=readFileSync(file);bytes.fill(0,0,32);writeFileSync(file,bytes);
 try{assert.throws(()=>new api.RelayStore(options),/STORAGE_CORRUPT/);assert.deepEqual(readFileSync(file),bytes);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('lost delivery becomes UNKNOWN after bounded result deadline even while connector heartbeats',async()=>{
 const path='../../src/network/store.js';const {RelayStore}=await import(path);
 const dir=mkdtempSync(join(tmpdir(),'network-deadline-'));const store=new RelayStore({directory:dir,deviceId:'d',agentId:'a',responseTtlMs:100});
 const sync={connector_id:randomUUID(),ready:true,local_instance_id:randomUUID(),capacity:1,results:[]};
 try{store.sync(sync);store.submit('jev.open_session',{request_id:'lost',params:{fixture_id:'standard'}});const job=store.sync(sync).job;await new Promise(done=>setTimeout(done,130));store.sync(sync);assert.equal(store.get('lost').delivery_status,'UNKNOWN');
  store.sync({...sync,results:[{request_id:'lost',delivery_nonce:job.delivery_nonce,outcome:{kind:'reply',reply:{ok:false,error:{code:'BUSY'}}}}]});assert.equal(store.get('lost').delivery_status,'COMPLETED');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
