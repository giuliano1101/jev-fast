import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {JevSession,TestBudget,createJevRuntime} from '../index.mjs';
import {fixture} from './helpers.mjs';

function adapter({drift=false,unknown=false,hang=false}={}) {
  let observations=0,inputs=0;
  return {kind:'native',scope:()=>({app:'test'}),close:async()=>{},
    observe:async()=>({observation_id:'obs-'+(++observations),value:drift&&observations>1?'changed':'ready',complete:inputs>0}),
    guard:(_candidate,state)=>({value:state.value}),
    execute:async()=>{inputs++;if(unknown)throw Error('NATIVE_RESULT_LOST');if(hang)await delay(60);return {input_submitted:true};},
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
