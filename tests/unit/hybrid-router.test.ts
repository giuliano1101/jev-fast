import test from 'node:test';
import assert from 'node:assert/strict';
import {routeHybrid} from '../../bench/hybrid/router.js';
const base = {
  authorized:true, budgetAvailable:true, actionUnknown:false,
  readiness:'settled', terminalVerified:false, procedure:'active',
  regression:false, repairVerified:false, noProgress:0,
  decisionRejected:false, deterministicReady:false,
  teacherAvailable:true, teacherUsed:false,
};
const cases = [
  [{authorized:false}, 'STOP', 'NOT_AUTHORIZED'],
  [{budgetAvailable:false}, 'STOP', 'BUDGET_EXHAUSTED'],
  [{actionUnknown:true}, 'RECONCILE', 'UNKNOWN_ACTION'],
  [{readiness:'pending'}, 'SETTLE', 'STATE_PENDING'],
  [{readiness:'unobservable'}, 'TEACHER', 'STATE_UNOBSERVABLE'],
  [{terminalVerified:true}, 'DONE', 'GOAL_VERIFIED'],
  [{procedure:'missing'}, 'TEACHER', 'PROCEDURE_NOT_ACTIVE'],
  [{regression:true}, 'TEACHER', 'INVARIANT_LOST'],
  [{noProgress:2}, 'TEACHER', 'NO_PROGRESS'],
  [{decisionRejected:true}, 'TEACHER', 'DECISION_REJECTED'],
  [{deterministicReady:true}, 'DIRECT', 'VERIFIED_UNIQUE_STEP'],
  [{}, 'JEV', 'BOUNDED_CHOICE'],
] as const;
test('every routing rule dominates all lower-priority combinations', () => {
  // For each leading rule, exercise every combination of later rules (including conflicting readiness).
  for (let i=0;i<cases.length;i++) {
    const [leading, route, reason] = cases[i]!;
    const lower=cases.slice(i+1);
    for(let mask=0;mask<2**lower.length;mask++) {
      const input={...base};
      lower.forEach(([patch], bit)=>{if(mask & 2**bit)Object.assign(input,patch);});
      Object.assign(input,leading);
      assert.deepEqual(routeHybrid(input),{route,reason},JSON.stringify(input));
    }
  }
});
test('only settled active procedures can use verified repair, and terminal wins',()=>{
  assert.deepEqual(routeHybrid({...base,regression:true,repairVerified:true}),{route:'REPAIR',reason:'VERIFIED_REPAIR'});
  for(const [patch,route,reason] of cases.slice(0,7)) {
    assert.deepEqual(routeHybrid({...base,regression:true,repairVerified:true,...patch}),{route,reason});
  }
});
test('all non-active procedure states need teacher and share one handoff allowance',()=>{
  for(const procedure of ['missing','draft','probation','expired','quarantined']) {
    for(const teacherAvailable of [true,false])for(const teacherUsed of [true,false]) {
      assert.deepEqual(routeHybrid({...base,procedure,teacherAvailable,teacherUsed,deterministicReady:true}),
        teacherUsed?{route:'STOP',reason:'HANDOFF_LIMIT'}:!teacherAvailable?{route:'STOP',reason:'TEACHER_UNAVAILABLE'}:{route:'TEACHER',reason:'PROCEDURE_NOT_ACTIVE'});
    }
  }
});
test('every escalation shares teacher availability and handoff limit',()=>{
  for(const [patch,route] of cases.filter(([,route])=>route==='TEACHER')) {
    assert.equal(route,'TEACHER');
    assert.deepEqual(routeHybrid({...base,...patch,teacherUsed:true}),{route:'STOP',reason:'HANDOFF_LIMIT'});
    assert.deepEqual(routeHybrid({...base,...patch,teacherAvailable:false}),{route:'STOP',reason:'TEACHER_UNAVAILABLE'});
  }
});
test('no progress threshold is exactly two',()=>{
  for(const noProgress of [0,1])assert.equal(routeHybrid({...base,noProgress}).route,'JEV');
  for(const noProgress of [2,12])assert.equal(routeHybrid({...base,noProgress}).reason,'NO_PROGRESS');
});
test('strict validation refuses malformed, missing, and unknown fields',()=>{
  for(const value of [null,{}, {...base,script:'click'}, {...base,readiness:'assumed'}, {...base,procedure:'ACTIVE'}, {...base,noProgress:-1}, {...base,noProgress:13}, {...base,noProgress:0.5}, {...base,authorized:'true'}, {...base,budgetAvailable:undefined}]) {
    assert.deepEqual(routeHybrid(value),{route:'STOP',reason:'INVALID_INPUT'});
  }
});
