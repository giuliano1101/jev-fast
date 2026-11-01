import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {schemas,type BrowserPort,type Candidate,type Goal,type Predicate,type Snapshot} from '../../src/core/contracts.js';
import {Engine} from '../../src/core/engine.js';
import {MockProvider} from '../../src/providers/mock.js';
import {Ledger} from '../../src/session/ledger.js';
import {validateLedgerState} from '../../src/session/schema.js';
const request=(session_id:string)=>({session_id,goal_id:'goal',idempotency_key:'key',goal:{task:'form' as const,language:'en' as const,seed:1},success:{kind:'task_complete' as const}});
class ProgressBrowser implements BrowserPort {
 progress=new Map<string,number>();target=80;executing=new Set<string>();release?:()=>void;gate?:Promise<void>;
 async open(id:string){this.progress.set(id,0);return {allowed_origin:'http://127.0.0.1:7777'};}
 async observe(session_id:string):Promise<Snapshot>{const now=Date.now(),count=this.progress.get(session_id)!;return {session_id,snapshot_id:'snap_'+count,document_epoch:1,mutation_version:count,url:'http://127.0.0.1:7777/form',origin:'http://127.0.0.1:7777',created_at:now,expires_at:now+2000,fingerprint:String(count),safe_summary:'synthetic',synthetic:true,nodes:[],candidates:[{candidate_id:'c',snapshot_id:'snap_'+count,operation:'click',target_ref:'submit',params_ref:'local',risk_class:'fixture',preconditions:[],expected_postcondition:{kind:'flag',name:'loaded',value:true},policy_version:'p0-v1',description:'Advance'}]};}
 async check(id:string,predicate:Predicate){return predicate.kind==='flag'||this.progress.get(id)!>=this.target;}
 async validate(){return true;}
 async execute(id:string,_candidate:Candidate,_goal:Goal,_signal:AbortSignal){this.executing.add(id);await this.gate;this.progress.set(id,this.progress.get(id)!+1);}
 async close(id:string){this.progress.delete(id);}
}
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'jev-unlimited-')),browser=new ProgressBrowser(),engine=await Engine.create({storageDir:dir,browser,provider:new MockProvider(),clients:['a','b']});return {dir,browser,engine,async cleanup(){browser.release?.();await engine.shutdown();await rm(dir,{recursive:true,force:true});}};}
test('goal budgets are optional caller limits with no product maxima',()=>{
 const base=request('s'),parsed=schemas.run_goal.parse(base);
 assert.equal(parsed.max_steps,undefined);assert.equal(parsed.time_budget_ms,undefined);
 assert.equal(schemas.run_goal.safeParse({...base,max_steps:1000,time_budget_ms:Number.MAX_SAFE_INTEGER}).success,true);
 for(const bad of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1])for(const field of ['max_steps','time_budget_ms'])assert.equal(schemas.run_goal.safeParse({...base,[field]:bad}).success,false);
 assert.equal(schemas.run_goal.safeParse({...base,time_budget_ms:1}).success,true);
});
test('omitted goal budgets permit more than 64 actions and durable reopen',async()=>{
 const f=await fixture();try{
  const {session_id}=await f.engine.openSession('a',{fixture_id:'standard'}),result=await f.engine.runGoal('a',request(session_id));
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.steps,80);assert.equal(result.action_ids.length,80);
  await f.engine.shutdown();const reopened=await Ledger.open(f.dir);try{assert.equal(reopened.state.goals[session_id+':goal']!.action_ids.length,80);}finally{await reopened.close();}
 }finally{await f.cleanup();}
});
test('huge explicit timeout remains active without timer overflow',async()=>{
 const f=await fixture();f.browser.target=1;const original=MockProvider.prototype.decide;
 MockProvider.prototype.decide=async function(input,context){assert.ok(Number.isFinite(context.deadline));await new Promise(resolve=>setTimeout(resolve,5));return original.call(this,input,context);};
 try{const {session_id}=await f.engine.openSession('a',{fixture_id:'standard'});assert.equal((await f.engine.runGoal('a',{...request(session_id),max_steps:100,time_budget_ms:Number.MAX_SAFE_INTEGER})).status,'SUCCEEDED');}finally{MockProvider.prototype.decide=original;await f.cleanup();}
});
test('independent owners run concurrently and one cancellation does not close the other',async()=>{
 const f=await fixture();f.browser.target=1;f.browser.gate=new Promise(resolve=>{f.browser.release=resolve;});
 try{
  const [a,b]=await Promise.all([f.engine.openSession('a',{fixture_id:'standard'}),f.engine.openSession('b',{fixture_id:'standard'})]);
  await assert.rejects(f.engine.observe('a',{session_id:b.session_id}),/UNAUTHORIZED/);
  const runningA=f.engine.runGoal('a',request(a.session_id)),runningB=f.engine.runGoal('b',request(b.session_id));
  while(f.browser.executing.size<2)await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.engine.runGoal('a',{...request(a.session_id),goal_id:'other',idempotency_key:'other'}),/BUSY/);
  assert.equal((await f.engine.cancel('a',{session_id:a.session_id,goal_id:'goal'})).status,'UNKNOWN');
  await f.engine.closeSession('a',{session_id:a.session_id});f.browser.release!();
  assert.equal((await runningA).status,'UNKNOWN');assert.equal((await runningB).status,'SUCCEEDED');
  assert.equal((await f.engine.status('b',{session_id:b.session_id}) as {closed:boolean}).closed,false);
 }finally{await f.cleanup();}
});
test('ledger keeps evidence and records beyond former arbitrary capacities',()=>{
 const sessions=Object.fromEntries(Array.from({length:100001},(_,i)=>['s'+i,{owner:'a',fixture_id:'standard',allowed_origin:'http://127.0.0.1:7777',epoch:0,quarantined:false,closed:false}]));
 assert.doesNotThrow(()=>validateLedgerState({version:2,sessions,goals:{'s0:g':{session_id:'s0',goal_id:'g',idempotency_key:'key',request_hash:'hash',status:'SUCCEEDED',steps:0,elapsed_ms:0,reason:null,evidence:Array(129).fill('VERIFIED'),action_ids:[]}},actions:{}}));
});
test('network owner admission accepts more than 128 independent owners',async()=>{
 const f=await fixture();try{const owners=Array.from({length:129},(_,i)=>'network-'+i.toString(16).padStart(64,'0'));assert.equal((await f.engine.reconcileNetworkOwners(owners)).owners.length,129);}finally{await f.cleanup();}
});

test('candidate count has no global limit while candidate identities stay unique',async()=>{
 const f=await fixture();f.browser.target=1;const observe=f.browser.observe.bind(f.browser);
 f.browser.observe=async id=>{const snapshot=await observe(id);snapshot.candidates=Array.from({length:65},(_,i)=>({...snapshot.candidates[0]!,candidate_id:'c'+i}));return snapshot;};
 try{const {session_id}=await f.engine.openSession('a',{fixture_id:'standard'});assert.equal((await f.engine.runGoal('a',request(session_id))).status,'SUCCEEDED');}finally{await f.cleanup();}
});

test('public coordinator authorization uses configured and revoked owner identities',async()=>{
 const f=await fixture();try{assert.doesNotThrow(()=>f.engine.authorizeClient('a'));assert.throws(()=>f.engine.authorizeClient('outside'),/UNAUTHORIZED/);const owner='network-'+'a'.repeat(64);f.engine.grantNetworkOwner(owner);f.engine.authorizeClient(owner);await f.engine.revokeNetworkOwner(owner);assert.throws(()=>f.engine.authorizeClient(owner),/UNAUTHORIZED/);}finally{await f.cleanup();}
});
