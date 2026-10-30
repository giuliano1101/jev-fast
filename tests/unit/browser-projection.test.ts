import test from 'node:test';
import assert from 'node:assert/strict';
import {projectFixture} from '../../src/browser/projection.js';
import type {State} from '../../src/browser/frame.js';
import {taskSchema} from '../../src/core/contracts.js';
import {parseDecisionRequest} from '../../src/remote/protocol.js';
import {MockProvider} from '../../src/providers/mock.js';
const state:State={task:'form',step:0,name:'',email:'',category:'',query:'',submitted:0,cancelled:false,loaded:false,scrolled:false,complete:false,error:false};

test('every task has bounded safe projection accepted by the strict remote protocol',async()=>{
 for(const task of taskSchema.options){
  const goal={task,language:'en' as const,seed:2},current={...state,task};
  const projection=projectFixture(current,goal);
  assert.deepEqual(projectFixture({...current,complete:true},goal),projection,'oracle flag must not drive projection');
  const input={synthetic:true as const,snapshot_id:'snapshot',goal:{task,language:'en' as const},summary:JSON.stringify({task,step:0,submitted:0,cancelled:false,loaded:false,scrolled:false,error:false,projection}),candidates:[{candidate_id:'cancel',description:'Click Cancel to abandon the current task without completing its requested steps.'}]};
  const digest='sha256:'+'a'.repeat(64);
  assert.doesNotThrow(()=>parseDecisionRequest({schema_version:'decision-v1',request_id:'request',idempotency_key:'idempotency',nonce:'a'.repeat(32),execution_context:{session_id:'session',goal_id:'goal',lease_epoch:0,policy_version:'p0-v1',adapter_version:'fixture-v1'},snapshot:{id:'snapshot',digest,valid_for_ms:2000},input,candidate_set_digest:digest,deadline_ms:2000}));
  const decision=await new MockProvider().decide(input,{signal:new AbortController().signal,deadline:Date.now()+2000});
  assert.equal(decision.candidate_id,'cancel');assert.equal(decision.confidence,1);
 }
});

test('progress compares current values and selection without returning raw values',()=>{
 const goal={task:'form' as const,language:'en' as const,seed:2};
 const empty=projectFixture(state,goal),matched=projectFixture({...state,name:'Synthetic-2',category:'beta'},goal);
 assert.equal(empty.name_matches_goal,false);assert.equal(matched.name_matches_goal,true);
 assert.equal(empty.category_matches_goal,false);assert.equal(matched.category_matches_goal,true);
 assert.equal(projectFixture({...state,name:'Synthetic-3'},goal).name_matches_goal,false);
 assert.doesNotMatch(JSON.stringify(matched),/Synthetic-2|"category":"beta"|"complete"/);
});
