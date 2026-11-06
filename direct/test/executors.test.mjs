import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {canonicalJson} from '../dist/src/remote/protocol.js';
import {DESKTOP_PRE_DISPATCH_REJECTIONS, FileExecutionJournal, inspectDesktopSession, JevSession, TestBudget, createJevRuntime, reconcileDesktopSession} from '../index.mjs';
import {fixture} from './helpers.mjs';
const stepDigest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

function adapter({drift=false,unknown=false,hang=false,fail=null}={}) {
  let observations=0,inputs=0;
  return {kind:'native',scope:()=>({app:'test'}),close:async()=>{},
    observe:async()=>({observation_id:'obs-'+(++observations),value:drift&&observations>1?'changed':'ready',complete:inputs>0}),
    guard:(_candidate,state)=>({value:state.value}),
    execute:async()=>{inputs++;if(fail)throw Error(fail);if(unknown)throw Error('NATIVE_RESULT_LOST');if(hang)await delay(60);return {input_submitted:true};},
    get inputs(){return inputs;}};
}
const step={task:'Click the correct control',goalId:'goal',idempotencyKey:'one',intent:{action:'verify'},
  project:state=>({value:state.value}),candidates:()=>[{id:'verify',description:'Verify',method:'click',input:{}}],verify:state=>state.complete};
function model(choice='verify',confidence=1){let calls=0;return {async choose(){calls++;return {selected_id:choice,confidence,provider:'jev',model:'jev-1.14.0'};},close(){},get calls(){return calls;}};}
test('session caches a verified physical step across reopen and rejects changed intent',async()=>{
  const f=fixture(),a=adapter(),m=model();let session=await JevSession.open({adapter:a,jev:m,directory:join(f.runtime,'session')});
  try{
    assert.equal((await session.step(step)).status,'VERIFIED');assert.equal(a.inputs,1);assert.equal(m.calls,1);
    assert.equal((await session.step(step)).cached,true);assert.equal(a.inputs,1);
    await assert.rejects(session.step({...step,intent:{action:'different'}}),/IDEMPOTENCY_CONFLICT/);
    await session.close();session=await JevSession.open({adapter:a,jev:m,directory:join(f.runtime,'session')});
    assert.equal((await session.step(step)).cached,true);assert.equal(a.inputs,1);assert.equal(m.calls,1);
  }finally{await session.close();f.cleanup();}
});
test('fresh state drift and low confidence never dispatch',async()=>{
  for(const [a,m,status] of [[adapter({drift:true}),model(),'STALE'],[adapter(),model('verify',0.4),'REJECTED'],[adapter(),model('invented'),'REJECTED']]){
    const f=fixture();const s=await JevSession.open({adapter:a,jev:m,directory:join(f.runtime,'session')});
    try{assert.equal((await s.step(step)).status,status);assert.equal(a.inputs,0);}finally{await s.close();f.cleanup();}
  }
});
test('unknown input survives restart and prevents any later physical action',async()=>{
  const f=fixture(),a=adapter({unknown:true}),m=model();let s=await JevSession.open({adapter:a,jev:m,directory:join(f.runtime,'session')});
  try{
    assert.equal((await s.step(step)).status,'UNKNOWN');assert.equal(a.inputs,1);
    await s.close();s=await JevSession.open({adapter:a,jev:m,directory:join(f.runtime,'session')});
    await assert.rejects(s.step({...step,idempotencyKey:'two'}),/SURFACE_QUARANTINED/);assert.equal(a.inputs,1);assert.equal(m.calls,1);
  }finally{await s.close();f.cleanup();}
});
test('late physical completion cannot release interrupted-input quarantine',async()=>{
  const f=fixture(),a=adapter(),m=model(),entered=Promise.withResolvers(),release=Promise.withResolvers(),finished=Promise.withResolvers(),stop=new AbortController();
  const execute=a.execute;
  a.execute=async candidate=>{const result=await execute(candidate);entered.resolve();await release.promise;finished.resolve();return result;};
  const s=await JevSession.open({adapter:a,jev:m,directory:join(f.runtime,'session')});
  try{
    const pending=s.step({...step,signal:stop.signal});await entered.promise;stop.abort();
    assert.equal((await pending).status,'UNKNOWN');release.resolve();await finished.promise;
    await assert.rejects(s.step({...step,idempotencyKey:'two'}),/SURFACE_QUARANTINED/);assert.equal(a.inputs,1);
  }finally{release.resolve();await s.close();f.cleanup();}
});
test('one physical-host lease excludes concurrent sessions',async()=>{
  const f=fixture(),s=await JevSession.open({adapter:adapter(),jev:model(),directory:join(f.runtime,'session')});
  try{await assert.rejects(JevSession.open({adapter:adapter(),jev:model(),directory:join(f.runtime,'session')}),/JOURNAL_BUSY/);}finally{await s.close();f.cleanup();}
});
test('keyboard preparation runs before a fresh observation and never on rejected choices',async()=>{
  for(const confidence of [1,0.3]){
    const f=fixture(),a=adapter(),events=[];
    const observe=a.observe,execute=a.execute;
    a.observe=async()=>{events.push('observe');return observe();};
    a.prepare=async()=>{events.push('prepare');};
    a.execute=async()=>{events.push('execute');return execute();};
    const s=await JevSession.open({adapter:a,jev:model('verify',confidence),directory:join(f.runtime,'session')});
    try{
      const result=await s.step(step);
      if(confidence===1){assert.equal(result.status,'VERIFIED');assert.deepEqual(events.slice(0,4),['observe','prepare','observe','execute']);}
      else{assert.equal(result.status,'REJECTED');assert.deepEqual(events,['observe']);}
    }finally{await s.close();f.cleanup();}
  }
});
test('explicit budget charges known usage and holds unknown reservation after reopen',()=>{
  const f=fixture();let b=new TestBudget({directory:join(f.runtime,'budget'),limitUsd:0.003});
  let sequence=0;const recorder={begin:()=>String(++sequence),finish(){}};
  try{
    let wrapped=b.wrap(recorder),id=wrapped.begin();wrapped.finish(id,{http_status:200,usage:{input_tokens:100,output_tokens:4}});
    assert.ok(Math.abs(b.summary().known_cost_usd-0.0000042)<1e-12);
    wrapped=b.wrap(recorder);id=wrapped.begin();wrapped.finish(id,{http_status:null,usage:null});
    assert.throws(()=>b.wrap(recorder).begin(),/TEST_BUDGET_EXHAUSTED/);
    b.close();b=new TestBudget({directory:join(f.runtime,'budget'),limitUsd:0.003});
    assert.equal(b.summary().attempts,2);assert.equal(b.summary().unknown_attempts,1);
    assert.throws(()=>b.wrap(recorder).begin(),/TEST_BUDGET_EXHAUSTED/);
  }finally{b.close();f.cleanup();}
});
test('atomic Choice and Noul questions use exactly one official request and one usage entry',async()=>{
  const f=fixture();let requests=0;
  const runtime=createJevRuntime({...f,transport:async(url,init)=>{
    requests++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init.redirect,'error');
    assert.deepEqual(Object.keys(JSON.parse(init.body).questions),['action','ready']);
    return Response.json({model:'jev-1.14.0',answers:{action:{type:'choice',choice:'a',confidence:1,probabilities:{a:1,b:0}},ready:{type:'noul',noul:0.99}},usage:{input_tokens:120,output_tokens:20}});
  }});
  try{
    const result=await runtime.ask({state:{status:'ready'},questions:{action:{type:'choice',instructions:'Choose A',criteria:{a:'A',b:'B'}},ready:{type:'noul',instructions:'Is the state ready?'}}});
    assert.equal(result.answers.action.choice,'a');assert.equal(result.answers.ready.noul,0.99);assert.equal(requests,1);assert.equal(runtime.usage().attempts,1);
  }finally{runtime.close();f.cleanup();}
});
test('bad probability distributions reject batch decision while preserving billed usage',async()=>{
  const f=fixture();const runtime=createJevRuntime({...f,transport:async()=>Response.json({model:'jev-1.14.0',answers:{action:{type:'choice',choice:'a',confidence:1,probabilities:{a:0.2,b:0.8}}},usage:{input_tokens:120,output_tokens:20}})});
  try{await assert.rejects(runtime.ask({state:'ready',questions:{action:{type:'choice',instructions:'Choose',criteria:{a:'A',b:'B'}}}}),/INVALID_RESPONSE/);assert.equal(runtime.usage().known_usage_attempts,1);}finally{runtime.close();f.cleanup();}
});
test('missing or nonfinite session confidence is rejected before physical input',async()=>{
  for(const confidence of [undefined,NaN,Infinity]){
    const f=fixture(),a=adapter(),s=await JevSession.open({adapter:a,jev:model('verify',confidence===undefined?1:confidence),directory:join(f.runtime,'session')});
    if(confidence===undefined)s.jev={async choose(){return {selected_id:'verify'};},close(){}};
    try{assert.equal((await s.step(step)).status,'REJECTED');assert.equal(a.inputs,0);}finally{await s.close();f.cleanup();}
  }
});
test('a hanging batch transport reaches deadline once and preserves unknown usage',async()=>{
  const f=fixture();let calls=0;
  const runtime=createJevRuntime({...f,transport:async()=>{calls++;return new Promise(()=>{});}});
  try{
    await assert.rejects(runtime.ask({state:'ready',questions:{ready:{type:'noul',instructions:'Ready?'}},timeoutMs:20}),/PROVIDER_DEADLINE/);
    assert.equal(calls,1);assert.equal(runtime.usage().unknown_usage_attempts,1);
  }finally{runtime.close();f.cleanup();}
});
function desktopProof(event,overrides={}){return {eventId:event.eventId,leaseKey:event.leaseKey,actionId:event.actionId,observationId:'obs-fresh',evidenceId:'operator-read',verdict:'not-executed',basis:'pre-dispatch',...overrides};}
async function seedSurface(directory,{status,code=null,journalMode='pending',goalId='goal',idempotencyKey='legacy'}={}){
  mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
  const id=stepDigest({goalId,idempotencyKey}),inputDigest=stepDigest({task:step.task,goalId,intent:step.intent,scope:{app:'test'}});
  const event={schemaVersion:1,eventId:randomUUID(),leaseKey:'physical-host',sessionId:randomUUID(),actionId:'step-'+id,observationId:'obs-legacy',startedAt:Date.now()};
  if(journalMode!=='absent'){
    const journal=await FileExecutionJournal.open(join(directory,'physical'));
    await journal.begin(event);
    if(journalMode==='reconciled-not-executed')await journal.reconcile(event,{eventId:event.eventId,leaseKey:event.leaseKey,actionId:event.actionId,observationId:'obs-title-unchanged',evidenceId:'title-url',verdict:'not-executed'});
    else if(journalMode==='acknowledged-executed')await journal.acknowledge(event,'executed');
    await journal.close();
  }
  const dbPath=join(directory,'steps.sqlite'),db=new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE steps(id TEXT PRIMARY KEY,digest TEXT NOT NULL,status TEXT NOT NULL,result TEXT);');
  db.prepare('INSERT INTO steps(id,digest,status,result) VALUES(?,?,?,?)').run(id,inputDigest,status,status==='PLANNING'?null:JSON.stringify({status,code,goalId,idempotencyKey}));
  db.close();chmodSync(dbPath,0o600);return {id,event,goalId,idempotencyKey};
}
async function recover(directory,overrides={},options={}){
  let calls=0,seen;const result=await reconcileDesktopSession({directory,...options,verify:async(event,context)=>{calls++;seen={event,context};return typeof overrides==='function'?overrides(event,context):desktopProof(event,overrides);}});
  return {result,calls,seen};
}
async function assertBlocked(directory){
  const a=adapter(),s=await JevSession.open({adapter:a,jev:model(),directory});
  try{await assert.rejects(s.step({...step,idempotencyKey:'after-quarantine'}),/SURFACE_QUARANTINED/);assert.equal(a.inputs,0);}finally{await s.close();}
}
async function assertResumed(directory,goalId,idempotencyKey,terminal){
  const a=adapter(),m=model(),s=await JevSession.open({adapter:a,jev:m,directory});
  try{
    const cached=await s.step({...step,goalId,idempotencyKey});
    assert.equal(cached.cached,true);assert.equal(cached.status,terminal);assert.equal(cached.replayed,false);assert.equal(a.inputs,0);assert.equal(m.calls,0);
    assert.equal((await s.step({...step,idempotencyKey:'legal-new-key'})).status,'VERIFIED');assert.equal(a.inputs,1);assert.equal(m.calls,1);
    assert.equal((await s.step({...step,idempotencyKey:'legal-new-key'})).cached,true);assert.equal(a.inputs,1);
  }finally{await s.close();}
}
test('desktop pre-dispatch rejections are a closed code set and exclude uncertain losses',()=>{
  for(const code of ['AMBIGUOUS_APP','APP_NOT_RUNNING','APP_NOT_FOUND','ELEMENT_DISABLED','UNSUPPORTED_KEY','PERMISSION_REQUIRED'])assert.ok(DESKTOP_PRE_DISPATCH_REJECTIONS.includes(code));
  for(const code of ['NATIVE_RESULT_LOST','INPUT_RESULT_UNKNOWN','DESKTOP_NATIVE_UNKNOWN','STALE_OBSERVATION','FOCUS_CHANGED','ACTIVATION_FAILED','INPUT_FAILED','TITLE_UNCHANGED'])assert.equal(DESKTOP_PRE_DISPATCH_REJECTIONS.includes(code),false);
});
test('a pre-dispatch driver rejection is acknowledged and does not quarantine the desktop',async()=>{
  const f=fixture(),directory=join(f.runtime,'session'),a=adapter({fail:'AMBIGUOUS_APP'}),m=model();
  const s=await JevSession.open({adapter:a,jev:m,directory});
  try{
    const failed=await s.step(step);assert.equal(failed.status,'FAILED');assert.equal(failed.code,'AMBIGUOUS_APP');assert.equal(failed.dispatch,'not-executed');assert.equal(a.inputs,1);
    assert.equal((await s.step(step)).cached,true);assert.equal(a.inputs,1);assert.equal(m.calls,1);
    const next=await s.step({...step,idempotencyKey:'next'});
    assert.equal(next.status,'FAILED');assert.equal(next.code,'AMBIGUOUS_APP');assert.equal(next.dispatch,'not-executed');assert.equal(next.cached,false);assert.equal(a.inputs,2);
    const state=JSON.parse(readFileSync(join(directory,'physical','executions.json'),'utf8'));
    assert.equal(state.pending.length,0);assert.equal(state.resolved[0].status,'rejected');assert.equal(state.resolved[0].proof,undefined);
    await s.close();assert.equal(inspectDesktopSession({directory}).status,'CLEAR');
  }finally{await s.close();f.cleanup();}
});
test('post-dispatch driver failures stay UNKNOWN and are not acknowledged',async()=>{
  for(const fail of ['STALE_OBSERVATION','DESKTOP_NATIVE_UNKNOWN','ACTIVATION_FAILED','INPUT_FAILED']){
    const f=fixture(),directory=join(f.runtime,'session'),a=adapter({fail});
    const s=await JevSession.open({adapter:a,jev:model(),directory});
    try{
      assert.equal((await s.step(step)).status,'UNKNOWN');assert.equal(a.inputs,1);
      const state=JSON.parse(readFileSync(join(directory,'physical','executions.json'),'utf8'));
      assert.equal(state.pending.length,1);assert.equal(state.resolved.length,0);
      await assert.rejects(s.step({...step,idempotencyKey:'two'}),/SURFACE_QUARANTINED/);assert.equal(a.inputs,1);
    }finally{await s.close();f.cleanup();}
  }
});
test('stale, wrong-action, and title-stability proofs do not release a journal-only recovered UNKNOWN step',async()=>{
  const f=fixture(),directory=join(f.runtime,'session');
  try{
    const seeded=await seedSurface(directory,{status:'UNKNOWN',code:'AMBIGUOUS_APP',journalMode:'reconciled-not-executed'});
    const inspected=inspectDesktopSession({directory});
    assert.equal(inspected.status,'QUARANTINED');assert.equal(inspected.counts.pending,0);assert.equal(inspected.steps[0].code,'AMBIGUOUS_APP');
    assert.equal(inspected.matchingResolutions[0].verdict,'not-executed');assert.equal(inspected.matchingResolutions[0].evidenceId,'title-url');
    const ledger=readFileSync(join(directory,'physical','executions.json'));
    for(const overrides of [{observationId:'obs-legacy'},{observationId:'obs-title-unchanged'},{actionId:'step-wrong'},{verdict:'nope'},{basis:'observed-effect'},{basis:'human-confirmed'},{verdict:'executed',basis:'observed-effect',observationId:'obs-fresh-2'}]){
      const {result}=await recover(directory,overrides);
      assert.notEqual(result.status,'RESOLVED');assert.equal(inspectDesktopSession({directory}).status,'QUARANTINED');
    }
    await assertBlocked(directory);
    const {result,seen}=await recover(directory,{});
    assert.equal(result.status,'RESOLVED');assert.equal(result.reason,'ACTION_NOT_EXECUTED');assert.equal(result.replayed,false);assert.equal(seen.context.journalKind,'partial');
    assert.equal(readFileSync(join(directory,'physical','executions.json')).equals(ledger),true);
    let calls=0;const again=await reconcileDesktopSession({directory,verify(){calls++;throw Error('must not run');}});
    assert.equal(again.status,'CLEAR');assert.equal(again.reason,'NO_PENDING_ACTION');assert.equal(calls,0);
    await assertResumed(directory,seeded.goalId,seeded.idempotencyKey,'RECONCILED_NOT_EXECUTED');
  }finally{f.cleanup();}
});
test('an uncertain desktop action is not replayed and not-executed proof cannot invent a miss',async()=>{
  const f=fixture(),directory=join(f.runtime,'session'),a=adapter({unknown:true});
  const s=await JevSession.open({adapter:a,jev:model(),directory});
  try{
    assert.equal((await s.step(step)).status,'UNKNOWN');assert.equal(a.inputs,1);
    await s.close();
    for(const overrides of [{},{basis:'human-confirmed'},{verdict:'executed',basis:'observed-effect',observationId:'obs-fresh-2'},{verdict:'executed',basis:'human-confirmed',observationId:'obs-fresh-3'}]){
      const {result}=await recover(directory,overrides);assert.equal(result.reason,overrides.verdict==='executed'?'EXECUTED_UNPROVEN':'NOT_EXECUTED_UNPROVEN');
    }
    await assertBlocked(directory);assert.equal(a.inputs,1);
    const released=await recover(directory,{verdict:'unconfirmed',basis:'human-confirmed',observationId:'obs-human'});
    assert.equal(released.result.status,'RESOLVED');assert.equal(released.result.reason,'ACTION_UNCONFIRMED');assert.equal(released.result.replayed,false);
    const state=JSON.parse(readFileSync(join(directory,'physical','executions.json'),'utf8'));
    assert.equal(state.pending.length,0);assert.equal(state.resolved.at(-1).proof.verdict,'unconfirmed');
    const again=await recover(directory,{verdict:'not-executed'});assert.equal(again.calls,0);assert.equal(again.result.status,'CLEAR');
    await assertResumed(directory,'goal','one','RECONCILED_UNCONFIRMED');
  }finally{await s.close();f.cleanup();}
});
test('desktop recovery covers crash windows without replaying the armed action',async()=>{
  const f=fixture();
  try{
    const planning=join(f.runtime,'planning');
    const armed=await seedSurface(planning,{status:'PLANNING',journalMode:'pending',idempotencyKey:'armed'});
    assert.equal((await recover(planning,{basis:'observed-effect'})).result.reason,'NOT_EXECUTED_UNPROVEN');
    assert.equal((await recover(planning,{})).result.status,'RESOLVED');
    await assertResumed(planning,armed.goalId,armed.idempotencyKey,'RECONCILED_NOT_EXECUTED');
    const executing=join(f.runtime,'executing');
    const lost=await seedSurface(executing,{status:'EXECUTING',journalMode:'pending',idempotencyKey:'executing'});
    assert.equal((await recover(executing,{})).result.reason,'NOT_EXECUTED_UNPROVEN');
    await assertBlocked(executing);
    assert.equal((await recover(executing,{verdict:'unconfirmed',basis:'human-confirmed',observationId:'obs-human'})).result.status,'RESOLVED');
    await assertResumed(executing,lost.goalId,lost.idempotencyKey,'RECONCILED_UNCONFIRMED');
    const submitted=join(f.runtime,'submitted');
    const done=await seedSurface(submitted,{status:'EXECUTING',journalMode:'acknowledged-executed',idempotencyKey:'submitted'});
    assert.equal((await recover(submitted,{})).result.reason,'NOT_EXECUTED_UNPROVEN');
    assert.equal((await recover(submitted,{verdict:'executed',basis:'observed-effect',observationId:'obs-effect'})).result.reason,'ACTION_CONFIRMED');
    await assertResumed(submitted,done.goalId,done.idempotencyKey,'RECONCILED_EXECUTED');
    const absent=join(f.runtime,'absent');
    await seedSurface(absent,{status:'UNKNOWN',journalMode:'absent',idempotencyKey:'absent'});
    assert.equal((await recover(absent,{})).result.reason,'NOT_EXECUTED_UNPROVEN');
    assert.equal((await recover(absent,{verdict:'unconfirmed',basis:'human-confirmed',observationId:'obs-human'})).result.status,'RESOLVED');
    assert.equal(existsSync(join(absent,'physical','executions.json')),false);
  }finally{f.cleanup();}
});
test('a late reconciliation callback cannot release desktop quarantine',async()=>{
  const f=fixture(),directory=join(f.runtime,'session');
  const seeded=await seedSurface(directory,{status:'UNKNOWN',code:'NATIVE_RESULT_LOST',journalMode:'pending'});
  let resolveProof,seen;const proof=new Promise(resolve=>{resolveProof=resolve;});
  try{
    const result=await reconcileDesktopSession({directory,maxDurationMs:30,verify:event=>{seen=event;return proof;}});
    assert.equal(result.reason,'DEADLINE');
    resolveProof(desktopProof(seen,{verdict:'unconfirmed',basis:'human-confirmed',observationId:'obs-late'}));
    await delay(20);
    assert.equal(inspectDesktopSession({directory}).status,'QUARANTINED');
    assert.equal(JSON.parse(readFileSync(join(directory,'physical','executions.json'),'utf8')).pending[0].eventId,seeded.event.eventId);
    await assertBlocked(directory);
  }finally{f.cleanup();}
});
test('a live desktop owner is not displaced and a dead owner lock is not removed',async()=>{
  const f=fixture(),directory=join(f.runtime,'session'),s=await JevSession.open({adapter:adapter(),jev:model(),directory});
  try{
    const live=inspectDesktopSession({directory});
    assert.equal(live.status,'BUSY');assert.equal(live.lock.owner,'alive');assert.equal(live.lock.pid,process.pid);
    let calls=0;
    assert.equal((await reconcileDesktopSession({directory,verify(){calls++;}})).status,'BUSY');assert.equal(calls,0);
    await assert.rejects(JevSession.open({adapter:adapter(),jev:model(),directory}),/JOURNAL_BUSY/);
    await s.close();
    const lock=join(directory,'physical','owner.lock');
    writeFileSync(lock,JSON.stringify({pid:2147483646,token:randomUUID()}),{mode:0o600});
    const before=readFileSync(lock);
    const dead=inspectDesktopSession({directory});
    assert.equal(dead.status,'BUSY');assert.equal(dead.lock.owner,'dead');assert.match(dead.advisoryOwner,/does not authorize deleting/);
    assert.equal((await reconcileDesktopSession({directory,verify(){calls++;}})).reason,'JOURNAL_BUSY');
    assert.equal(calls,0);assert.equal(readFileSync(lock).equals(before),true);assert.equal(existsSync(lock),true);
  }finally{await s.close();f.cleanup();}
});
