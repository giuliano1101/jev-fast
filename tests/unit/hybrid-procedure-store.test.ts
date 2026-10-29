import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProcedureStore} from '../../bench/hybrid/procedure-store.js';
import type {TrialEvidence} from '../../bench/hybrid/workflow-contracts.js';
import {catalog,definition,evidence} from '../helpers/hybrid-workflow.js';
async function setup(t:{after:(fn:()=>Promise<void>)=>void}) {
  const directory=await mkdtemp(join(tmpdir(),'jev-procedure-'));
  const store=await ProcedureStore.open(directory,catalog);
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
  return {store,directory};
}
async function activate(store:ProcedureStore) {
  const first=await store.create(definition,evidence(),100);assert.ok(first);
  const second=await store.recordTrial(definition.procedureId,first.revision,evidence('trial-2'),100);assert.ok(second);
  const third=await store.recordTrial(definition.procedureId,second.revision,evidence('trial-3','start-b'),100);assert.ok(third);
  return third;
}
test('three independent verified runs across two initial states graduate through draft and probation',async t=>{
  const {store}=await setup(t);
  const first=await store.create(definition,evidence(),100);assert.ok(first);assert.equal(first.status,'DRAFT');
  const second=await store.recordTrial(definition.procedureId,1,evidence('trial-2'),100);assert.equal(second.status,'PROBATION');
  const third=await store.recordTrial(definition.procedureId,2,evidence('trial-3'),100);assert.equal(third.status,'PROBATION');
  const fourth=await store.recordTrial(definition.procedureId,3,evidence('trial-4','start-b'),100);assert.equal(fourth.status,'ACTIVE');
  assert.equal(fourth.trials.length,4);assert.equal(store.get(definition.procedureId,1)?.status,'DRAFT');
});
test('failed, unknown, unverified and missing-goal evidence is retained but cannot qualify',async t=>{
  const {store}=await setup(t);
  const first=await store.create(definition,evidence(),100);assert.ok(first);
  const disqualified:Partial<TrialEvidence>[]=[{terminal:false},{terminal:'unknown'},{independentlyVerified:false},{regression:'unknown'},{predicates:{}},{predicates:{'public.done':'unknown'}}];
  for(let i=0;i<disqualified.length;i++) {
    const result=await store.recordTrial(definition.procedureId,i+1,{...evidence(`bad-${i}`,'start-b'),...disqualified[i]},100);
    assert.equal(result.status,'PROBATION');assert.equal(result.trials.length,i+2);
  }
  const second=await store.recordTrial(definition.procedureId,7,evidence('good-2','start-b'),100);assert.equal(second.status,'PROBATION');
  const third=await store.recordTrial(definition.procedureId,8,evidence('good-3','start-b'),100);assert.equal(third.status,'ACTIVE');
});
test('unknown actions block promotion and are never interpreted as confirmed regression',async t=>{
  const {store}=await setup(t);const active=await activate(store);
  const unknown=await store.recordTrial(definition.procedureId,active.revision,{...evidence('uncertain'),actionUnknown:true,terminal:'unknown',regression:'unknown'},100);
  assert.equal(unknown.status,'PROBATION');
  const later=await store.recordTrial(definition.procedureId,unknown.revision,evidence('later','start-c'),100);
  assert.equal(later.status,'PROBATION');
});
test('confirmed regression immediately quarantines and later success cannot silently reactivate',async t=>{
  const {store}=await setup(t);const active=await activate(store);
  const bad=await store.recordTrial(definition.procedureId,active.revision,{...evidence('regressed'),regression:true,terminal:false},100);
  assert.equal(bad.status,'QUARANTINED');
  const later=await store.recordTrial(definition.procedureId,bad.revision,evidence('later','start-c'),100);
  assert.equal(later.status,'QUARANTINED');assert.equal(later.trials.length,5);
  const revised=await store.revise(definition.procedureId,later.revision,definition,evidence('revision-demo'),100);
  assert.equal(revised.status,'DRAFT');assert.equal(revised.definitionVersion,2);assert.equal(revised.trials.length,1);
  assert.equal(store.get(definition.procedureId,bad.revision)?.status,'QUARANTINED');
});
test('contradictory independent terminal and predicate evidence quarantines',async t=>{
  const {store}=await setup(t);const active=await activate(store);
  const bad=await store.recordTrial(definition.procedureId,active.revision,{...evidence('contradiction'),predicates:{'public.done':false}},100);
  assert.equal(bad.status,'QUARANTINED');
});
test('create requires a verified teacher demonstration and rejects any unknown action',async t=>{
  const {store}=await setup(t);
  for(const patch of [{terminal:false},{terminal:'unknown'},{independentlyVerified:false},{executor:'jev'},{actionUnknown:true},{regression:'unknown'},{predicates:{}}]) {
    await assert.rejects(store.create(definition,{...evidence(),...patch},100),/INVALID_DEMONSTRATION/);
  }
  assert.equal(store.get(definition.procedureId),undefined);
});
test('optimistic revisions serialize simultaneous writers and reject duplicate trial identities',async t=>{
  const {store}=await setup(t);const first=await store.create(definition,evidence(),100);assert.ok(first);
  const writes=await Promise.allSettled([store.recordTrial(definition.procedureId,1,evidence('trial-2'),100),store.recordTrial(definition.procedureId,1,evidence('trial-3'),100)]);
  assert.equal(writes.filter(x=>x.status==='fulfilled').length,1);
  assert.match(String((writes.find(x=>x.status==='rejected') as PromiseRejectedResult).reason),/REVISION_CONFLICT/);
  await assert.rejects(store.recordTrial(definition.procedureId,2,evidence(),100),/DUPLICATE_TRIAL/);
  await assert.rejects(store.create(definition,evidence('another'),100),/PROCEDURE_EXISTS/);
  await assert.rejects(store.revise(definition.procedureId,2,definition,evidence(),100),/DUPLICATE_TRIAL/);
});
test('only active unexpired workflows with exact environment and account scope can match',async t=>{
  const {store}=await setup(t);await activate(store);
  assert.equal(store.match(definition.procedureId,definition.scope,1099).reason,'MATCH');
  assert.equal(store.match(definition.procedureId,definition.scope,1100).reason,'TTL_EXPIRED');
  assert.equal(store.match(definition.procedureId,definition.scope,1100).status,'EXPIRED');
  for(const key of Object.keys(definition.scope) as (keyof typeof definition.scope)[]) {
    const scope={...definition.scope,[key]:key==='accountScope'||key==='environmentFingerprint'?'c'.repeat(64):'other'};
    assert.equal(store.match(definition.procedureId,scope,100).reason,'SCOPE_MISMATCH');
  }
  assert.equal(store.match('absent',definition.scope,100).status,'MISSING');
  assert.throws(()=>store.match(definition.procedureId,definition.scope,NaN),/INVALID_TIME/);
});
test('expired evidence cannot revive a workflow without a new definition version',async t=>{
  const {store}=await setup(t);const active=await activate(store);
  const expired=await store.recordTrial(definition.procedureId,active.revision,{...evidence('late'),completedAt:1100},1100);
  assert.equal(expired.status,'EXPIRED');
  await assert.rejects(store.recordTrial(definition.procedureId,expired.revision,{...evidence('future'),completedAt:1200},1100),/INVALID_EVIDENCE_TIME/);
});
test('atomic private snapshots survive reopen, preserve history, and do not expose mutable state',async t=>{
  const {store,directory}=await setup(t);const active=await activate(store);
  active.definition.steps[0]!.actionId='tampered';active.trials.length=0;
  assert.equal(store.get(definition.procedureId)?.trials.length,3);
  const read=store.get(definition.procedureId)!;read.trials.length=0;
  assert.equal(store.get(definition.procedureId)?.trials.length,3);
  assert.equal((await stat(join(directory,'procedures.json'))).mode&0o777,0o600);
  await assert.rejects(ProcedureStore.open(directory,catalog),/STORAGE_BUSY/);
  await store.close();
  const reopened=await ProcedureStore.open(directory,catalog);
  assert.equal(reopened.get(definition.procedureId)?.status,'ACTIVE');assert.equal(reopened.get(definition.procedureId,1)?.status,'DRAFT');
  assert.deepEqual((await readdir(directory)).sort(),['owner.lock','procedures.json']);
  await assert.rejects(store.recordTrial(definition.procedureId,3,evidence('closed'),100),/STORAGE_CLOSED/);
  await reopened.close();
});
test('corrupt, unknown-version, unknown-field and tampered history snapshots fail closed',async t=>{
  const {store,directory}=await setup(t);await activate(store);await store.close();
  const valid=await readFile(join(directory,'procedures.json'),'utf8');
  const data=JSON.parse(valid) as {schemaVersion:number;history:unknown[]};
  for(const bad of ['not json',JSON.stringify({...data,schemaVersion:2}),JSON.stringify({...data,rawText:'private'}),JSON.stringify({...data,history:[...data.history,...data.history]})]) {
    await writeFile(join(directory,'procedures.json'),bad);
    await assert.rejects(ProcedureStore.open(directory,catalog),/STORAGE_CORRUPT/);
    assert.deepEqual(await readdir(directory),['procedures.json']);
  }
  await writeFile(join(directory,'procedures.json'),valid);
  const reopened=await ProcedureStore.open(directory,catalog);await reopened.close();
});

test('failed atomic replacement retains prior memory and disk revision and removes temporary files',async t=>{
  const {store,directory}=await setup(t);
  const {mkdir,rmdir}=await import('node:fs/promises');
  await mkdir(join(directory,'procedures.json'));
  await assert.rejects(store.create(definition,evidence(),100),/EISDIR|ENOTDIR/);
  assert.equal(store.get(definition.procedureId),undefined);
  assert.deepEqual((await readdir(directory)).sort(),['owner.lock','procedures.json']);
  await rmdir(join(directory,'procedures.json'));
  const first=await store.create(definition,evidence(),100);
  assert.equal(first.revision,1);
});
test('persisted activation, evidence, definitions and time history are independently revalidated',async t=>{
  const {store,directory}=await setup(t);await activate(store);await store.close();
  const valid=JSON.parse(await readFile(join(directory,'procedures.json'),'utf8')) as {schemaVersion:1;history:import('../../bench/hybrid/procedure-store.js').ProcedureSnapshot[]};
  const changes:((data:typeof valid)=>void)[]=[
    data=>{data.history[0]!.status='ACTIVE';},
    data=>{data.history[2]!.trials[2]!.independentlyVerified=false;},
    data=>{data.history[2]!.trials[2]!.startStateKey='start-a';},
    data=>{data.history[2]!.definition.steps[0]!.safeRepeat=false;},
    data=>{data.history[2]!.trials[0]!.terminal=false;},
    data=>{data.history[2]!.recordedAt=99;},
    data=>{data.history[2]!.expiresAt=Number.MAX_SAFE_INTEGER;},
  ];
  for(const change of changes) {
    const invalid=structuredClone(valid);change(invalid);
    await writeFile(join(directory,'procedures.json'),JSON.stringify(invalid));
    await assert.rejects(ProcedureStore.open(directory,catalog),/STORAGE_CORRUPT/);
  }
});
test('missing procedures, invalid revisions and mismatched replacement identities cannot write',async t=>{
  const {store,directory}=await setup(t);
  await assert.rejects(store.recordTrial('missing',1,evidence(),100),/PROCEDURE_MISSING/);
  await store.create(definition,evidence(),100);
  const before=await readFile(join(directory,'procedures.json'),'utf8');
  await assert.rejects(store.revise(definition.procedureId,1,{...definition,procedureId:'different'},evidence('revision'),100),/PROCEDURE_ID_MISMATCH/);
  await assert.rejects(store.recordTrial(definition.procedureId,NaN,evidence('next'),100),/REVISION_CONFLICT/);
  await assert.rejects(store.recordTrial(definition.procedureId,1,{...evidence('next'),completedAt:99},100),/INVALID_EVIDENCE_TIME/);
  await assert.rejects(store.recordTrial(definition.procedureId,1,evidence('next'),99),/INVALID_TIME/);
  assert.equal(store.match(definition.procedureId,definition.scope,100).reason,'NOT_ACTIVE');
  assert.equal(await readFile(join(directory,'procedures.json'),'utf8'),before);
});
test('close drains already accepted writes and rejects new writes while closing',async t=>{
  const {store,directory}=await setup(t);
  const pending=store.create(definition,evidence(),100);
  const closing=store.close();
  await assert.rejects(store.create({...definition,procedureId:'late'},evidence('late'),100),/STORAGE_CLOSED/);
  await assert.doesNotReject(Promise.all([pending,closing]));
  const reopened=await ProcedureStore.open(directory,catalog);
  assert.equal(reopened.get(definition.procedureId)?.status,'DRAFT');
  await reopened.close();
});
test('history capacity is enforced before mutation so every committed file remains reopenable',async t=>{
  const {store,directory}=await setup(t);
  const first=await store.create(definition,evidence(),100);await store.close();
  const history=Array.from({length:10000},(_,index)=>({...first,definition:{...first.definition,procedureId:`workflow-${index}`},trials:[{...first.trials[0]!,trialId:`capacity-${index}`}]}));
  await writeFile(join(directory,'procedures.json'),JSON.stringify({schemaVersion:1,history}));
  const full=await ProcedureStore.open(directory,catalog);
  try {
    const before=await readFile(join(directory,'procedures.json'),'utf8');
    await assert.rejects(full.create(definition,evidence('overflow'),100),/HISTORY_LIMIT/);
    assert.equal(full.get(definition.procedureId),undefined);
    assert.equal(await readFile(join(directory,'procedures.json'),'utf8'),before);
  } finally {await full.close();}
  const reopened=await ProcedureStore.open(directory,catalog);await reopened.close();
});
