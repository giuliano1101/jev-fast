# Hybrid Routing Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this first bounded sub-project task-by-task. No paid API or live UI is needed for this sub-project.

**Goal:** Implement and test a pure automatic route selector that honors shared authorization, uncertainty, budgets, current state, and procedure validity.

**Architecture:** This is the first independently testable part of the [complete S8 design](../../hybrid-execution-design.md). It selects a route and reason but cannot operate a UI, learn procedures, invoke a teacher, or report real task completion. Those integrations remain separately scoped stages in the design; a green routing unit test is not evidence of an autonomous agent.

**Tech Stack:** Existing TypeScript, Zod, node:test. No new dependency.

Status: implementation plan only. All boxes below are intentionally unchecked.

## Task 1 — Contract and executable policy

**Files:**
- Create: `bench/hybrid/router.ts`
- Create: `tests/unit/hybrid-router.test.ts`

- [ ] Add the following test file. Export a temporary route function returning STOP from the new module so the first run fails on assertions rather than an unresolved import.

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import {routeHybrid} from '../../bench/hybrid/router.js';
const base = {
  authorized: true, budgetAvailable: true, actionUnknown: false,
  readiness: 'settled', terminalVerified: false, procedure: 'active',
  regression: false, repairVerified: false, noProgress: 0,
  decisionRejected: false, deterministicReady: false,
  teacherAvailable: true, teacherUsed: false,
};
test('new procedure automatically requests teacher discovery', () => {
  assert.deepEqual(routeHybrid({...base, procedure:'missing'}), {route:'TEACHER', reason:'PROCEDURE_NOT_ACTIVE'});
});
test('unknown action is reconciled before terminal or repair routing', () => {
  assert.deepEqual(routeHybrid({...base, actionUnknown:true, terminalVerified:true, repairVerified:true}), {route:'RECONCILE', reason:'UNKNOWN_ACTION'});
});
test('loading does not trigger repair and terminal cannot bypass readiness', () => {
  assert.deepEqual(routeHybrid({...base, readiness:'pending', regression:true, repairVerified:true, terminalVerified:true}), {route:'SETTLE', reason:'STATE_PENDING'});
});
test('deterministic execution requires a valid procedure and no regression', () => {
  assert.equal(routeHybrid({...base, deterministicReady:true}).route, 'DIRECT');
  assert.equal(routeHybrid({...base, deterministicReady:true, procedure:'quarantined'}).route, 'TEACHER');
  assert.equal(routeHybrid({...base, deterministicReady:true, regression:true}).route, 'TEACHER');
});
test('stable regression permits only a verified repair branch', () => {
  assert.equal(routeHybrid({...base, regression:true, repairVerified:true}).route, 'REPAIR');
  assert.equal(routeHybrid({...base, regression:true}).route, 'TEACHER');
});
test('one rejected decision escalates without another Jev attempt', () => {
  assert.deepEqual(routeHybrid({...base, decisionRejected:true}), {route:'TEACHER', reason:'DECISION_REJECTED'});
});
test('budget and authorization apply to every execution mode', () => {
  assert.equal(routeHybrid({...base, authorized:false, actionUnknown:true}).reason, 'NOT_AUTHORIZED');
  assert.equal(routeHybrid({...base, budgetAvailable:false, deterministicReady:true}).reason, 'BUDGET_EXHAUSTED');
});
test('teacher cannot ping-pong and lack of a teacher fails closed', () => {
  assert.equal(routeHybrid({...base, decisionRejected:true, teacherUsed:true}).reason, 'HANDOFF_LIMIT');
  assert.equal(routeHybrid({...base, procedure:'missing', teacherAvailable:false}).reason, 'TEACHER_UNAVAILABLE');
});
test('stable verified terminal wins over unnecessary further actions', () => {
  assert.equal(routeHybrid({...base, terminalVerified:true}).route, 'DONE');
  assert.equal(routeHybrid(base).route, 'JEV');
});
test('strict input validation does not grant authority from extra fields', () => {
  assert.equal(routeHybrid({...base, script:'click anything'}).reason, 'INVALID_INPUT');
  assert.equal(routeHybrid({...base, readiness:'assumed'}).reason, 'INVALID_INPUT');
});
```

- [ ] Run `. scripts/env.sh && npm run build && node --test dist/tests/unit/hybrid-router.test.js`; confirm expected assertion failures against the stub.
- [ ] Replace the stub with the following initial implementation. Do not add network or UI access to this file.

```typescript
import {z} from 'zod';
const inputSchema = z.strictObject({
  authorized:z.boolean(), budgetAvailable:z.boolean(), actionUnknown:z.boolean(),
  readiness:z.enum(['settled','pending','unobservable']), terminalVerified:z.boolean(),
  procedure:z.enum(['missing','draft','probation','active','expired','quarantined']),
  regression:z.boolean(), repairVerified:z.boolean(), noProgress:z.number().int().min(0).max(12),
  decisionRejected:z.boolean(), deterministicReady:z.boolean(),
  teacherAvailable:z.boolean(), teacherUsed:z.boolean(),
});
export type HybridRoute = 'STOP'|'RECONCILE'|'SETTLE'|'DONE'|'TEACHER'|'REPAIR'|'DIRECT'|'JEV';
export interface RouteDecision {route:HybridRoute; reason:string}
export function routeHybrid(value:unknown):RouteDecision {
  const parsed=inputSchema.safeParse(value);
  if(!parsed.success)return {route:'STOP',reason:'INVALID_INPUT'};
  const s=parsed.data;
  const teacher=(reason:string):RouteDecision => s.teacherUsed
    ? {route:'STOP',reason:'HANDOFF_LIMIT'}
    : !s.teacherAvailable ? {route:'STOP',reason:'TEACHER_UNAVAILABLE'}
    : {route:'TEACHER',reason};
  if(!s.authorized)return {route:'STOP',reason:'NOT_AUTHORIZED'};
  if(!s.budgetAvailable)return {route:'STOP',reason:'BUDGET_EXHAUSTED'};
  if(s.actionUnknown)return {route:'RECONCILE',reason:'UNKNOWN_ACTION'};
  if(s.readiness==='pending')return {route:'SETTLE',reason:'STATE_PENDING'};
  if(s.readiness==='unobservable')return teacher('STATE_UNOBSERVABLE');
  if(s.terminalVerified)return {route:'DONE',reason:'GOAL_VERIFIED'};
  if(s.procedure!=='active')return teacher('PROCEDURE_NOT_ACTIVE');
  if(s.regression)return s.repairVerified ? {route:'REPAIR',reason:'VERIFIED_REPAIR'} : teacher('INVARIANT_LOST');
  if(s.noProgress>=2)return teacher('NO_PROGRESS');
  if(s.decisionRejected)return teacher('DECISION_REJECTED');
  if(s.deterministicReady)return {route:'DIRECT',reason:'VERIFIED_UNIQUE_STEP'};
  return {route:'JEV',reason:'BOUNDED_CHOICE'};
}
```

`authorized`, `terminalVerified`, `repairVerified` and `deterministicReady` must eventually come from trusted controller checks. They are not fields a teacher, web page or external client may set. This policy is a decision component, not an authorization boundary by itself. `pending` is bounded by settle.ts, never an unbounded polling instruction. `teacherUsed` must be atomically consumed before dispatch in controller.ts. RECONCILE is read-only and cannot replay an uncertain action.

- [ ] Re-run the tests and `npm run typecheck && npm run lint`. Require all tests green.
- [ ] Add exhaustive table coverage for the remaining enum states and priority combinations before integration: expired/probation/draft, unavailable observations, two no-progress steps, and unknown+exhausted budget. The expected routes are defined explicitly by the complete function above and S8 trigger table.

## Task 2 — Document and commit the isolated component

**Files:**
- Modify: `docs/hybrid-execution-design.md` (status paragraph only)

- [ ] After actual tests pass, replace its status paragraph with:

```text
状态：自动路由纯函数已实现并通过离线策略测试。尚未实现自动 teacher 调用、流程学习、共享动作租约或混合执行。S7 的实测结果不因此改变。
```

- [ ] Inspect `git diff --check`; ensure no S7 measured files or runtime/private data changed.
- [ ] Commit `bench/hybrid/router.ts`, `tests/unit/hybrid-router.test.ts` and the status update with message `Add tested hybrid routing policy without live execution`.

## Following integration stage — prerequisites, not claims of implementation

Before a real hybrid benchmark, implement the teacher host adapter, one shared action lease, aggregate budget and deadline, stable tri-state observation, independent terminal verifier, and versioned procedure evidence. Execute the fault matrix in the complete design. Refuse a request when no teacher host is configured; do not emulate a teacher with pre-scripted oracle answers and call that a real mixed-model result.

The historical paid authorization must be checked live before any future paid run. This plan neither renews it nor authorizes sending private account data to a new model service.
