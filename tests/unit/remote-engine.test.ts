import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Engine} from '../../src/core/engine.js';
import {MockProvider} from '../../src/providers/mock.js';
import {signDecisionResponse,canonicalDigest,type DecisionRequest} from '../../src/remote/protocol.js';
import type {BrowserPort,Candidate,Snapshot,DecisionContext} from '../../src/core/contracts.js';
const keys=generateKeyPairSync('ed25519');const identity={owner_id:'owner',device_id:'device',agent_id:'agent'};
class Browser implements BrowserPort {
 executions=0;done=false;changed=false;hang=false;
 async open(){return {allowed_origin:'http://127.0.0.1:7777'};}
 async observe(session_id:string):Promise<Snapshot>{const now=Date.now();return {session_id,snapshot_id:'snap',document_epoch:1,mutation_version:0,url:'http://127.0.0.1:7777/form',origin:'http://127.0.0.1:7777',created_at:now,expires_at:now+2000,fingerprint:this.done?'done':'before',safe_summary:JSON.stringify({task:'form',step:0,submitted:this.done?1:0,cancelled:false,loaded:false,scrolled:false,error:false}),synthetic:true,nodes:[],candidates:[{candidate_id:'c',snapshot_id:'snap',operation:'click',target_ref:'submit',params_ref:'params',risk_class:'fixture',preconditions:[],expected_postcondition:{kind:'task_complete'},policy_version:'p0-v1',description:'click submit (synthetic action)'}]};}
 async commitments(){return [{candidate_id:'c',target_digest:canonicalDigest(this.changed?'changed-target':'target'),params_digest:canonicalDigest('private-local-parameter')}];}
 async validate(){return true;}
 async check(){return this.done;}
 async execute(_id:string,_c:Candidate){this.executions++;if(this.hang)await new Promise(()=>{});this.done=true;}
 async close(){}
}
const request=(session_id:string)=>({session_id,goal_id:'goal',idempotency_key:'key',goal:{task:'form',language:'en',seed:1},success:{kind:'task_complete'},time_budget_ms:1000});
const policy={publicKey:keys.publicKey,issuer:'gateway',audience:'executor',identity,enforcementMode:'test_mock' as const};
async function setup(mode:'good'|'missing'|'tampered'|'changed'|'wrong_identity'|'live_required'|'short_ttl'='good'){
 const dir=await mkdtemp(join(tmpdir(),'jev-remote-engine-'));const browser=new Browser();let observed:DecisionRequest|undefined;
 const provider={decide:async(input:Parameters<MockProvider['decide']>[0],context:DecisionContext)=>{observed=(context as DecisionContext&{remoteRequest?:DecisionRequest}).remoteRequest;const d=await new MockProvider().decide(input,context);if(mode==='missing'||!observed)return d;const response=signDecisionResponse(observed,d,{privateKey:keys.privateKey,issuer:'gateway',audience:'executor',identity:mode==='wrong_identity'?{...identity,device_id:'wrong'}:identity,decisionId:'decision',issuedAtMs:Date.now(),validForMs:Math.min(mode==='short_ttl'?60:800,observed.deadline_ms,observed.snapshot.valid_for_ms),route:'mock'});if(mode==='tampered')response.receipt+='x';if(mode==='changed')browser.changed=true;return response;}};
 const options={storageDir:dir,browser,provider,clients:['a'],remotePolicy:{...policy,enforcementMode:mode==='live_required'?'required_jev' as const:'test_mock' as const}};const engine=await Engine.create(options);const session=await engine.openSession('a',{fixture_id:'standard'});return {dir,browser,engine,s:session.session_id,observed:()=>observed,cleanup:async()=>{await engine.shutdown();await rm(dir,{recursive:true,force:true});}};
}
test('remote Engine constructs trusted request and durably consumes receipt with action',async()=>{const f=await setup();try{const result=await f.engine.runGoal('a',request(f.s));assert.equal(result.status,'SUCCEEDED');assert.equal(f.browser.executions,1);assert.ok(f.observed());assert.equal(f.observed()!.execution_context.session_id,f.s);const text=await readFile(join(f.dir,'ledger.json'),'utf8');assert.match(text,/receipt_digest/);assert.match(text,/decision/);assert.doesNotMatch(text,/private-local-parameter/);assert.deepEqual(await f.engine.runGoal('a',request(f.s)),result);assert.equal(f.browser.executions,1);}finally{await f.cleanup();}});
test('missing or forged receipt, changed local binding, wrong device and wrong route never execute',async()=>{for(const mode of ['missing','tampered','changed','wrong_identity','live_required'] as const){const f=await setup(mode);try{const result=await f.engine.runGoal('a',request(f.s));assert.notEqual(result.status,'SUCCEEDED',mode);assert.equal(f.browser.executions,0,mode);}finally{await f.cleanup();}}});
test('consumed receipt survives UNKNOWN and reopen without action replay',async()=>{const f=await setup();try{f.browser.hang=true;const result=await f.engine.runGoal('a',request(f.s));assert.equal(result.status,'UNKNOWN');assert.equal(f.browser.executions,1);await f.engine.shutdown();const reopened=await Engine.create({storageDir:f.dir,browser:f.browser,provider:new MockProvider(),clients:['a'],remotePolicy:policy});try{assert.deepEqual(await reopened.runGoal('a',request(f.s)),result);assert.equal(f.browser.executions,1);const action=reopened.ledger.state.actions[result.action_ids[0]!]!;assert.ok(action.receipt?.nonce);await assert.rejects(reopened.ledger.transaction(s=>{s.actions.duplicate={...action,action_id:'duplicate'};s.goals[`${f.s}:goal`]!.action_ids.push('duplicate');}),/RECEIPT_ALREADY_CONSUMED/);assert.equal(reopened.ledger.state.actions.duplicate,undefined);}finally{await reopened.shutdown();}}finally{await f.cleanup();}});
test('receipt expiring before durable execution transition fails without UNKNOWN quarantine',async t=>{const f=await setup('short_ttl');const original=f.engine.ledger.transaction.bind(f.engine.ledger);t.mock.method(f.engine.ledger,'transaction',async (fn:Parameters<typeof original>[0])=>{await original(fn);if(Object.values(f.engine.ledger.state.actions).some(a=>a.status==='VALIDATED'))await new Promise(resolve=>setTimeout(resolve,100));});try{const result=await f.engine.runGoal('a',request(f.s));assert.equal(result.status,'FALLBACK');assert.equal(f.browser.executions,0);assert.equal(f.engine.ledger.state.sessions[f.s]!.quarantined,false);}finally{await f.cleanup();}});
test('BrowserAdapter checks permission again after asynchronous validation before physical dispatch',async t=>{
 const {BrowserAdapter}=await import('../../src/browser/adapter.js');const {performance}=await import('node:perf_hooks');const adapter=new BrowserAdapter('http://127.0.0.1:7777');const candidate=(await new Browser().observe('s')).candidates[0]!;let clicks=0;
 const internals=adapter as unknown as {sessions:Map<string,unknown>};internals.sessions.set('s',{snapshot:{},bound:new Map([['c',{node:{click:async()=>{clicks++;}}}]])});
 t.mock.method(adapter,'validate',async()=>{await new Promise(resolve=>setTimeout(resolve,40));return true;});t.mock.method(adapter,'check',async()=>true);
 const expiresAtMonotonic=performance.now()+15;const authorization={expiresAtMonotonic,assertAuthorized:()=>{if(performance.now()>=expiresAtMonotonic)throw Error('EXPIRED');}};
 await assert.rejects(Reflect.apply(adapter.execute,adapter,['s',candidate,{task:'form',language:'en',seed:1},new AbortController().signal,authorization]));assert.equal(clicks,0);
});
