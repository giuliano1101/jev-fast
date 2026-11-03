import test from 'node:test';
import assert from 'node:assert/strict';
import {normalPlan,faultPlan,faultVerdict,validateStabilityApproval} from '../../bench/remote/stability.js';
import {taskSchema} from '../../src/core/contracts.js';
test('normal plan covers exact schema, seeds, language and balanced facade order',()=>{
 const plan=normalPlan();assert.equal(plan.length,108);assert.equal(new Set(plan.map(x=>x.id)).size,108);
 assert.deepEqual([...new Set(plan.map(x=>x.task))],taskSchema.options);
 for(const task of taskSchema.options)for(const seed of [801,802,803]){
  const group=plan.filter(x=>x.task===task&&x.seed===seed);assert.equal(group.length,3);
  assert.equal(new Set(group.map(x=>x.entry)).size,3);assert.equal(new Set(group.map(x=>x.language)).size,1);
  assert.ok(group.every(x=>x.max_steps===8&&x.time_budget_ms===15000));
 }
 const first=plan.filter((_,i)=>i%3===0);for(const entry of ['direct','cli','mcp'])assert.equal(first.filter(x=>x.entry===entry).length,12);
 assert.equal(new Set(plan.map(x=>x.language)).size,2);
});
test('fault plan separately covers 8 faults by 2 seeds by all facades',()=>{
 const plan=faultPlan();assert.equal(plan.length,48);assert.equal(new Set(plan.map(x=>x.id)).size,48);
 assert.equal(new Set(plan.map(x=>x.scenario)).size,8);assert.ok(plan.every(x=>x.task==='select'));
 assert.equal(faultVerdict('low_confidence',{status:'FALLBACK',steps:0,physical_actions:0,actions:[]}),true);
 assert.equal(faultVerdict('low_confidence',{status:'FALLBACK',steps:1,actions:[{status:'SUCCEEDED'}]}),false);
 assert.equal(faultVerdict('dom_replace',{status:'SUCCEEDED',steps:1,physical_actions:1,actions:[{status:'SUCCEEDED'}]}),true);
 assert.equal(faultVerdict('lost_response',{status:'UNKNOWN',steps:1,physical_actions:1,actions:[{status:'UNKNOWN'}],idempotency:{same_result:true,no_extra_actions:true,before_decisions:1,after_decisions:1},new_key_error:'QUARANTINED'}),true);
 assert.equal(faultVerdict('lost_response',{status:'UNKNOWN',steps:1,physical_actions:1,actions:[{status:'UNKNOWN'}]}),false);
 assert.equal(faultVerdict('cancel_pending',{status:'CANCELLED',steps:0,physical_actions:1,actions:[]}),false);
 assert.equal(faultVerdict('duplicate',{status:'SUCCEEDED',steps:1,physical_actions:1,actions:[{status:'SUCCEEDED'}],idempotency:{same_result:true,no_extra_actions:true,before_decisions:1,after_decisions:2}}),false);
});
test('live approval binds exact expanded caps and a bounded fresh authorization',()=>{
 const now=Date.now(),common={approval_id:'stability-only',expires_at:now+3600000,max_requests:300,max_cost_usd:1};
 const approval={authorization:{...common,synthetic_only:true},approval:{...common,reservation_usd:.003},authorized_at:new Date(now).toISOString()};
 assert.equal(validateStabilityApproval(approval,now).approval.max_requests,300);
 for(const mutate of [(x:typeof approval)=>x.approval.max_requests=301,(x:typeof approval)=>x.authorization.approval_id='old',(x:typeof approval)=>x.approval.reservation_usd=.002,(x:typeof approval)=>x.authorization.expires_at=now+86400001]){const x=structuredClone(approval);mutate(x);assert.throws(()=>validateStabilityApproval(x,now));}
});
