import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, percentile, type TaskRow } from '../../bench/metrics.js';
const row = (id: string, overrides: Partial<TaskRow> = {}): TaskRow => ({
  id, mode:'mock', task:'form', language:'en', seed:1, status:'SUCCEEDED', reason:'',
  elapsed_ms:10, timeout_ms:60000, actions:2, action_errors:0, policy_rejections:0,
  fallback:false, safety_violations:0, requests:2, retries:0,
  input_tokens:null, output_tokens:null, cost_usd:null,
  stages:{observe:1,candidate:1,policy:1,provider:1,execute:1,verify:1}, ...overrides
});
test('overall metrics retain timeout and fallback failures in denominator and latency', () => {
  const result = summarize([row('a'),row('b',{status:'FALLBACK',reason:'BUDGET_EXHAUSTED',elapsed_ms:60012,fallback:true,actions:1,action_errors:1})]);
  assert.equal(result.tasks,2); assert.equal(result.successes,1); assert.equal(result.success_rate,0.5);
  assert.equal(result.p95_ms,60012); assert.equal(result.timeouts,1);
  assert.equal(result.fallback_rate,0.5); assert.equal(result.action_error_rate,1/3);
  assert.equal(result.failures.BUDGET_EXHAUSTED,1);
  assert.equal(result.total_cost_usd,null); assert.equal(result.unknown_cost_tasks,2);
});
test('all failed experiment does not divide cost by zero',()=>{
 const result=summarize([row('x',{status:'FAILED',cost_usd:0.1})]);
 assert.equal(result.cost_per_success_usd,null); assert.equal(result.cost_per_started_task_usd,0.1);
});
test('exact mock zero costs and stages aggregate without invented paid usage',()=>{
 const result=summarize([row('x',{cost_usd:0,input_tokens:0,output_tokens:0})]);
 assert.equal(result.total_cost_usd,0); assert.equal(result.usage.input_tokens,0);
 assert.equal(result.stage_p95_ms.provider,1); assert.equal(result.requests,2);
});
test('nearest-rank percentile handles empty and validates samples',()=>{
 assert.equal(percentile([],0.95),null); assert.equal(percentile([30,10,20],0.5),20);
 assert.throws(()=>percentile([NaN],0.5)); assert.throws(()=>percentile([1],2));
});
