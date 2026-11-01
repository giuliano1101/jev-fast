import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {RelayStore,Audit} from '../../src/network/store.js';
import {AdmissionRegistry} from '../../src/network/admission.js';
import {syncSchema} from '../../src/network/protocol.js';
import {manualSyncReplySchema} from '../../src/network/manual-protocol.js';
import * as ipc from '../../src/service/ipc.js';
const temporary=()=>mkdtempSync(join(tmpdir(),'jev-unlimited-'));
test('relay accepts more than 32 queued requests and new deliveries have no default expiry',()=>{
 const directory=temporary(),store=new RelayStore({directory,deviceId:'d',agentId:'a'});
 const sync={connector_id:randomUUID(),ready:true,local_instance_id:randomUUID(),capacity:1,results:[]};
 try{store.sync(sync);for(let i=0;i<40;i++)assert.equal(store.submit('jev.open_session',{request_id:`queued-${i}`,params:{fixture_id:'standard'}}).delivery_status,'QUEUED');
  assert.equal(store.sync(sync).job!.expires_at,null);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
test('default queue and result lifetimes are unlimited while heartbeat and receipt fencing remain active',()=>{
 const directory=temporary(),store=new RelayStore({directory,deviceId:'d',agentId:'a'}),realNow=Date.now;let now=realNow();Date.now=()=>now;
 const sync={connector_id:randomUUID(),ready:true,local_instance_id:randomUUID(),capacity:1,results:[]};
 try{store.sync(sync);store.submit('jev.open_session',{request_id:'long',params:{fixture_id:'standard'}});
  for(let i=0;i<6;i++){now+=1000;store.sync({...sync,capacity:0});}
  assert.equal(store.get('long').delivery_status,'QUEUED');const job=store.sync(sync).job!;
  for(let i=0;i<80;i++){now+=1000;store.sync(sync);}
  assert.equal(store.get('long').delivery_status,'DISPATCHED');
  assert.throws(()=>store.sync({...sync,results:[{request_id:'long',delivery_nonce:'f'.repeat(64),outcome:{kind:'unknown' as const}}]}),/RECEIPT_CONFLICT/);
  now+=3001;assert.equal(store.get('long').delivery_status,'UNKNOWN');assert.equal(store.sync(sync).job,null);
  store.sync({...sync,results:[{request_id:'long',delivery_nonce:job.delivery_nonce,outcome:{kind:'reply' as const,reply:{ok:true as const,result:{done:true}}}}]});assert.equal(store.get('long').delivery_status,'COMPLETED');
 }finally{Date.now=realNow;store.close();rmSync(directory,{recursive:true,force:true});}
});
test('manual admission accepts over 128 live labels and AI handles do not expire by default',()=>{
 const directory=temporary(),registry=new AdmissionRegistry(directory),realNow=Date.now;let now=realNow();Date.now=()=>now;
 try{const first=registry.register('ai','first');for(let i=0;i<130;i++)registry.register('ai',`AI ${i}`);now+=1800001;assert.equal(registry.isLive(first.id),true);assert.equal(registry.touch(first.id).id,first.id);}
 finally{Date.now=realNow;registry.close();rmSync(directory,{recursive:true,force:true});}
});
test('audit reopens history beyond the former 10000 row limit and can keep appending',()=>{
 const directory=temporary(),schema=z.strictObject({request_id:z.string()});let audit=new Audit(directory,{kind:'test'},schema);audit.close();
 const db=new DatabaseSync(join(directory,'network.sqlite'));db.exec('BEGIN');const insert=db.prepare('INSERT INTO records VALUES(?,?)');for(let i=0;i<10001;i++)insert.run(`r${i}`,JSON.stringify({request_id:`r${i}`}));db.exec('COMMIT');db.close();
 try{audit=new Audit(directory,{kind:'test'},schema);audit.put('next',{request_id:'next'});assert.equal(audit.all().length,10002);}finally{audit.close();rmSync(directory,{recursive:true,force:true});}
});
test('sync accepts real available capacity and more than 128 owners',()=>{
 assert.equal(syncSchema.parse({connector_id:randomUUID(),ready:false,local_instance_id:null,capacity:500,results:[]}).capacity,500);
 assert.equal(manualSyncReplySchema.parse({acks:[],job:null,owners:Array.from({length:140},()=>`network-${'a'.repeat(64)}`),revocations:[],enabled:true}).owners.length,140);
});
test('business IPC requests use only caller specified deadlines including wrapped dispatch',()=>{
 const api=ipc as typeof ipc & {requestedRpcTimeoutMs:(method:string,params:unknown)=>number|null};assert.equal(typeof api.requestedRpcTimeoutMs,'function');
 assert.equal(api.requestedRpcTimeoutMs('jev.open_session',{}),null);assert.equal(api.requestedRpcTimeoutMs('jev.browser_act',{}),null);assert.equal(api.requestedRpcTimeoutMs('jev.browser_act',{timeout_ms:120000}),125000);
 assert.equal(api.requestedRpcTimeoutMs('jev.run_goal',{}),null);assert.equal(api.requestedRpcTimeoutMs('jev.choose_action',{}),null);
 assert.equal(api.requestedRpcTimeoutMs('service.network_dispatch',{method:'jev.run_goal',params:{}}),null);
 assert.equal(api.requestedRpcTimeoutMs('jev.run_goal',{time_budget_ms:120000}),125000);
 assert.equal(api.requestedRpcTimeoutMs('jev.choose_action',{timeout_ms:150000}),155000);
 assert.equal(api.requestedRpcTimeoutMs('service.health',{}),65000);
});
test('caller queue and response deadlines remain finite and survive the durable schema',()=>{
 const directory=temporary(),options={directory,deviceId:'d',agentId:'a',queueTtlMs:100,responseTtlMs:100};let store=new RelayStore(options);const realNow=Date.now;let now=realNow();Date.now=()=>now;
 const sync={connector_id:randomUUID(),ready:true,local_instance_id:randomUUID(),capacity:1,results:[]};
 try{store.sync(sync);store.submit('jev.open_session',{request_id:'explicit-queue',params:{fixture_id:'standard'}});now+=101;assert.equal(store.get('explicit-queue').delivery_status,'REJECTED');
  store.submit('jev.open_session',{request_id:'explicit-result',params:{fixture_id:'standard'}});assert.equal(store.sync(sync).job!.expires_at,now+100);now+=101;store.sync(sync);assert.equal(store.get('explicit-result').delivery_status,'UNKNOWN');
  store.close();store=new RelayStore(options);assert.equal(store.get('explicit-result').delivery_status,'UNKNOWN');
 }finally{Date.now=realNow;store.close();rmSync(directory,{recursive:true,force:true});}
});
test('an explicit AI idle lifetime is honored while the default remains unlimited',()=>{
 const directory=temporary(),registry=new AdmissionRegistry(directory,100),realNow=Date.now;let now=realNow();Date.now=()=>now;
 try{const ai=registry.register('ai','AI');now+=101;assert.equal(registry.isLive(ai.id),false);assert.throws(()=>registry.touch(ai.id),/HANDLE_EXPIRED/);}
 finally{Date.now=realNow;registry.close();rmSync(directory,{recursive:true,force:true});}
});
test('long RPC budgets avoid the Node timeout integer overflow',async()=>{
 const api=ipc as typeof ipc & {startRpcDeadline:(ms:number|null,callback:()=>void)=>()=>void};assert.equal(typeof api.startRpcDeadline,'function');let elapsed=false;
 const cancel=api.startRpcDeadline(2147483648,()=>{elapsed=true;});try{await new Promise(done=>setTimeout(done,20));assert.equal(elapsed,false);}finally{cancel();}
});
test('general decisions accept arbitrary host state and retain only caller specified response deadlines',()=>{
 const directory=temporary(),store=new RelayStore({directory,deviceId:'d',agentId:'a'}),realNow=Date.now;let now=realNow();Date.now=()=>now;
 const sync={connector_id:randomUUID(),ready:true,local_instance_id:randomUUID(),capacity:1,results:[]};
 const general={idempotency_key:'host-choice',task:'Edit a selected image in Photos',state:{application:'Photos',observed_controls:['Edit','Save'],arbitrary_nested:{a:[true,null,4]}},actions:Array.from({length:80},(_,i)=>({id:`control-${i}`,description:`Observed control ${i}`}))};
 try{store.sync(sync);store.submit('jev.choose_action',{request_id:'general',params:general});assert.equal(store.sync(sync).job!.expires_at,null);
  store.submit('jev.choose_action',{request_id:'timed-general',params:{...general,timeout_ms:1000}});store.sync(sync);
  store.submit('jev.run_goal',{request_id:'timed-fixture',params:{session_id:'s',goal_id:'g',idempotency_key:'fixture',goal:{task:'form',seed:4,language:'en'},success:{kind:'task_complete'},time_budget_ms:1000}});store.sync(sync);
  for(let i=0;i<7;i++){now+=1000;store.sync(sync);}
  assert.equal(store.get('general').delivery_status,'DISPATCHED');assert.equal(store.get('timed-general').delivery_status,'UNKNOWN');assert.equal(store.get('timed-fixture').delivery_status,'UNKNOWN');
 }finally{Date.now=realNow;store.close();rmSync(directory,{recursive:true,force:true});}
});
test('large explicit operator lifetimes remain valid without overflowing durable integer timestamps',()=>{
 const directory=temporary(),store=new RelayStore({directory,deviceId:'d',agentId:'a',queueTtlMs:Number.MAX_SAFE_INTEGER,responseTtlMs:Number.MAX_SAFE_INTEGER});
 const sync={connector_id:randomUUID(),ready:true,local_instance_id:randomUUID(),capacity:1,results:[]};
 try{store.sync(sync);store.submit('jev.open_session',{request_id:'long-explicit',params:{fixture_id:'standard'}});assert.equal(store.sync(sync).job!.expires_at,Number.MAX_SAFE_INTEGER);assert.equal(store.get('long-explicit').delivery_status,'DISPATCHED');}
 finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
