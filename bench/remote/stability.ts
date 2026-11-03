/** Historical cross-entry plans and verdicts; no transport launcher. */
import {z} from 'zod';
import {taskSchema,idSchema,type Goal} from '../../src/core/contracts.js';
export type Entry='direct'|'cli'|'mcp';
export const scenarios=['low_confidence','model_delay','dom_replace','stale_validation','cancel_pending','duplicate','lost_response','gateway_unreachable'] as const;
export type Scenario=typeof scenarios[number];
export interface Trial {id:string;task:Goal['task'];seed:number;entry:Entry;language:'en'|'zh';max_steps:8;time_budget_ms:15000;scenario?:Scenario;}
const entries:Entry[]=['direct','cli','mcp'];
export function normalPlan():Trial[]{
 const plan:Trial[]=[];for(const [taskIndex,task] of taskSchema.options.entries())for(const [seedIndex,seed] of [801,802,803].entries()){
  const rotate=(taskIndex+seedIndex)%3;for(const entry of [...entries.slice(rotate),...entries.slice(0,rotate)])plan.push({id:`${task}-${seed}-${entry}`,task,seed,entry,language:seedIndex===1?'zh':'en',max_steps:8,time_budget_ms:15000});
 }return plan;
}
export function faultPlan():Trial[]{return scenarios.flatMap((scenario,i)=>[811,812].flatMap((seed,j)=>{const rotate=(i+j)%3;return [...entries.slice(rotate),...entries.slice(0,rotate)].map(entry=>({id:`fault-${scenario}-${seed}-${entry}`,task:'select' as const,seed,entry,language:seed===812?'zh' as const:'en' as const,max_steps:8 as const,time_budget_ms:15000 as const,scenario}));}));}
interface VerdictInput {status:unknown;steps?:unknown;actions?:Array<{status?:unknown}>;physical_actions?:number;idempotency?:{same_result?:boolean;no_extra_actions?:boolean;before_decisions?:number;after_decisions?:number};new_key_error?:unknown;}
export function faultVerdict(scenario:Scenario,row:VerdictInput):boolean{
 const zero=row.steps===0&&row.actions?.length===0&&row.physical_actions===0;
 const replaySafe=row.idempotency?.same_result===true&&row.idempotency.no_extra_actions===true&&Number.isInteger(row.idempotency.before_decisions)&&row.idempotency.before_decisions===row.idempotency.after_decisions;
 if(['low_confidence','model_delay','gateway_unreachable'].includes(scenario))return row.status==='FALLBACK'&&zero;
 if(scenario==='cancel_pending')return row.status==='CANCELLED'&&zero;
 if(scenario==='lost_response')return row.status==='UNKNOWN'&&row.steps===1&&row.physical_actions===1&&row.actions?.length===1&&row.actions[0]?.status==='UNKNOWN'&&replaySafe&&row.new_key_error==='QUARANTINED';
 if(scenario==='duplicate')return row.status==='SUCCEEDED'&&row.steps===1&&row.physical_actions===1&&row.actions?.length===1&&row.actions[0]?.status==='SUCCEEDED'&&replaySafe;
 return row.status==='SUCCEEDED'&&row.steps===1&&row.physical_actions===1&&row.actions?.length===1&&row.actions[0]?.status==='SUCCEEDED';
}
const common={approval_id:idSchema,expires_at:z.number().int().positive(),max_requests:z.literal(300),max_cost_usd:z.literal(1)};
const approvalSchema=z.object({authorization:z.strictObject({...common,synthetic_only:z.literal(true)}),approval:z.strictObject({...common,reservation_usd:z.literal(.003)}),authorized_at:z.string().optional()}).passthrough();
export function validateStabilityApproval(value:unknown,now=Date.now()){
 const parsed=approvalSchema.parse(value),a=parsed.authorization,b=parsed.approval;
 const start=parsed.authorized_at?Date.parse(parsed.authorized_at):now;
 if(!Number.isFinite(start)||start>now||now-start>86400000||a.expires_at<=now||a.expires_at>start+86400000||a.approval_id!==b.approval_id||a.expires_at!==b.expires_at)throw Error('INVALID_STABILITY_APPROVAL');
 return parsed;
}
