import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {MockProvider} from '../../src/providers/mock.js';
import {signDecisionResponse} from '../../src/remote/protocol.js';
import {remoteRequest} from '../helpers/remote-fixture.js';
const modulePath='../../src/remote/store.js';
async function api(){const value=await import(modulePath).catch(()=>null);assert.ok(value?.GatewayStore,'durable gateway store required');return value.GatewayStore;}
const identity={owner_id:'owner',device_id:'device',agent_id:'agent'};
const approval=()=>({approval_id:'approval',expires_at:Date.now()+60000,max_requests:2,max_cost_usd:.02,reservation_usd:.01});
async function fixture(fn:(dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'jev-gateway-store-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('central reservations survive restart and conflicting configuration cannot reset caps',async()=>fixture(async dir=>{const Store=await api();const limit=approval();let store=new Store(dir);try{store.configureBudget(limit);assert.equal(store.begin(identity,'key','a'.repeat(64)).status,'started');store.reserve(identity,'key',limit.approval_id);store.close();store=new Store(dir);store.configureBudget(limit);assert.equal(store.budget(limit.approval_id).requests,1);assert.equal(store.begin(identity,'key','a'.repeat(64)).status,'unknown');assert.throws(()=>store.begin(identity,'key','b'.repeat(64)),/IDEMPOTENCY_CONFLICT/);assert.throws(()=>store.configureBudget({...limit,max_requests:3}),/BUDGET_CONFIGURATION_CONFLICT/);assert.equal(store.begin(identity,'other','b'.repeat(64)).status,'started');store.reserve(identity,'other',limit.approval_id);assert.throws(()=>store.reserve(identity,'other',limit.approval_id),/BUDGET_EXHAUSTED/);assert.equal(store.budget(limit.approval_id).requests,2);}finally{store.close();}}));
test('unknown decision cannot be restarted or reserved again and identity isolates keys',async()=>fixture(async dir=>{const Store=await api();const store=new Store(dir);try{store.configureBudget(approval());store.begin(identity,'key','a'.repeat(64));store.markUnknown(identity,'key');assert.equal(store.begin(identity,'key','a'.repeat(64)).status,'unknown');assert.throws(()=>store.reserve(identity,'key','approval'),/DECISION_NOT_PENDING/);assert.equal(store.begin({...identity,device_id:'another'},'key','b'.repeat(64)).status,'started');}finally{store.close();}}));
test('revocation and per-device certificate binding persist across restart',async()=>fixture(async dir=>{const Store=await api();let store=new Store(dir);try{store.enroll({...identity,certificate_sha256:'a'.repeat(64),expires_at:Date.now()+60000});assert.deepEqual(store.authorize(identity,'a'.repeat(64)),identity);assert.throws(()=>store.authorize(identity,'b'.repeat(64)),/FORBIDDEN/);store.revoke(identity);store.close();store=new Store(dir);assert.throws(()=>store.authorize(identity,'a'.repeat(64)),/FORBIDDEN/);}finally{store.close();}}));
test('missing tables in an existing database cannot silently recreate budget or idempotency',async()=>{const Store=await api();const {DatabaseSync}=await import('node:sqlite');for(const table of ['budgets','decisions','principals'])await fixture(async dir=>{const store=new Store(dir);store.configureBudget(approval());store.close();const db=new DatabaseSync(join(dir,'gateway.sqlite'));db.exec(`DROP TABLE ${table}`);db.close();const reopened:Array<{close:()=>void}>=[];try{assert.throws(()=>{reopened.push(new Store(dir));},/GATEWAY_STORAGE_CORRUPT/);}finally{for(const value of reopened)value.close();}});});
test('completed signed response survives restart byte-for-byte without a new reservation',async()=>fixture(async dir=>{
 const Store=await api(),keys=generateKeyPairSync('ed25519'),request=remoteRequest();let store=new Store(dir);
 const decision=await new MockProvider().decide(request.input,{signal:new AbortController().signal,deadline:Date.now()+2000});
 const response=signDecisionResponse(request,decision,{privateKey:keys.privateKey,issuer:'gateway',audience:'executor',identity,decisionId:'decision',issuedAtMs:Date.now(),validForMs:1000,route:'mock'});
 try{store.configureBudget(approval());store.begin(identity,'key','a'.repeat(64));store.reserve(identity,'key','approval');store.complete(identity,'key',response);store.close();store=new Store(dir);const cached=store.begin(identity,'key','a'.repeat(64));assert.equal(cached.status,'complete');assert.equal(JSON.stringify(cached.response),JSON.stringify(response));assert.equal(store.budget('approval').requests,1);assert.throws(()=>store.reserve(identity,'key','approval'),/DECISION_NOT_PENDING/);}finally{store.close();}
}));
test('separate store instances share the same durable cap and cannot take over pending calls',async()=>fixture(async dir=>{
 const Store=await api(),a=new Store(dir),b=new Store(dir);try{a.configureBudget({...approval(),max_requests:1});a.begin(identity,'one','a'.repeat(64));b.begin(identity,'two','b'.repeat(64));assert.throws(()=>b.reserve(identity,'one','approval'),/DECISION_NOT_PENDING/);a.reserve(identity,'one','approval');assert.throws(()=>b.reserve(identity,'two','approval'),/BUDGET_EXHAUSTED/);assert.equal(b.budget('approval').requests,1);}finally{a.close();b.close();}
}));
test('well-formed SQLite with invalid decision fields fails closed on reopen',async()=>{
 const Store=await api(),{DatabaseSync}=await import('node:sqlite');
 for(const sql of ["UPDATE budgets SET requests=0.5,reserved=5000000","UPDATE decisions SET cost=-1","UPDATE decisions SET owner='not-a-process-instance'","UPDATE decisions SET code='ILLEGAL_PENDING_CODE'","UPDATE decisions SET id='invalid-composite-key'"])await fixture(async dir=>{
  const store=new Store(dir);store.configureBudget(approval());store.begin(identity,'key','a'.repeat(64));store.close();const db=new DatabaseSync(join(dir,'gateway.sqlite'));db.exec(sql);db.close();let reopened:{close:()=>void}|undefined;
  try{assert.throws(()=>{reopened=new Store(dir);},/GATEWAY_STORAGE_CORRUPT/);}finally{reopened?.close();}
 });
});
