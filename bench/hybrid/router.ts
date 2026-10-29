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
