export type Stages = Record<'observe'|'candidate'|'policy'|'provider'|'execute'|'verify',number>;
export interface TaskRow {
 id:string; mode:'mock'|'scripted'; task:string; language:'en'|'zh'; seed:number;
 status:string; reason:string; elapsed_ms:number; timeout_ms:number;
 actions:number; action_errors:number; policy_rejections:number; fallback:boolean;
 safety_violations:number; requests:number; retries:number;
 input_tokens:number|null; output_tokens:number|null; cost_usd:number|null; stages:Stages;
}
export function percentile(values:number[],q:number): number|null {
 if (!Number.isFinite(q) || q<0 || q>1 || values.some(v=>!Number.isFinite(v)||v<0)) throw new Error('INVALID_METRIC');
 if (!values.length) return null;
 const sorted=[...values].sort((a,b)=>a-b);
 return sorted[Math.max(0,Math.ceil(q*sorted.length)-1)]!;
}
export function summarize(rows:TaskRow[]) {
 const tasks=rows.length;
 const successes=rows.filter(r=>r.status==='SUCCEEDED').length;
 const sum=(key:'actions'|'action_errors'|'policy_rejections'|'requests'|'retries'|'safety_violations')=>rows.reduce((n,r)=>n+r[key],0);
 const total=(key:'cost_usd'|'input_tokens'|'output_tokens')=>rows.some(r=>r[key]===null)?null:rows.reduce((n,r)=>n+(r[key]??0),0);
 const cost=total('cost_usd');
 const failures:Record<string,number>={};
 for(const row of rows.filter(r=>r.status!=='SUCCEEDED')) {const reason=row.reason||row.status; failures[reason]=(failures[reason]??0)+1;}
 const stage_p50_ms:Record<string,number|null>={}; const stage_p95_ms:Record<string,number|null>={};
 for(const name of ['observe','candidate','policy','provider','execute','verify'] as const) {
  stage_p50_ms[name]=percentile(rows.map(r=>r.stages[name]),0.5);
  stage_p95_ms[name]=percentile(rows.map(r=>r.stages[name]),0.95);
 }
 return {tasks,successes,success_rate:tasks?successes/tasks:null,
 p50_ms:percentile(rows.map(r=>r.elapsed_ms),0.5),p95_ms:percentile(rows.map(r=>r.elapsed_ms),0.95),
 timeouts:rows.filter(r=>r.elapsed_ms>=r.timeout_ms).length,
 actions:sum('actions'),action_errors:sum('action_errors'),action_error_rate:sum('actions')?sum('action_errors')/sum('actions'):null,
 policy_rejections:sum('policy_rejections'),
 fallback_tasks:rows.filter(r=>r.fallback).length,fallback_rate:tasks?rows.filter(r=>r.fallback).length/tasks:null,
 safety_violations:sum('safety_violations'), failures, requests:sum('requests'),retries:sum('retries'),
 stage_p50_ms,stage_p95_ms,
 usage:{input_tokens:total('input_tokens'),output_tokens:total('output_tokens')},
 total_cost_usd:cost,unknown_cost_tasks:rows.filter(r=>r.cost_usd===null).length,
 cost_per_started_task_usd:cost!==null&&tasks?cost/tasks:null,cost_per_success_usd:cost!==null&&successes?cost/successes:null};
}
