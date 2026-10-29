import {z} from 'zod';
import {performance} from 'node:perf_hooks';
import {PUBLIC_TASKS,parsePublicInput,type PublicDecisionInput} from './catalog.js';
import {preparePublicRequest,type PublicRequestPlan} from './optimization.js';
import type {PublicObservation} from './observation.js';
import type {PublicDecision,PublicAccounting} from './decision.js';
import {usageSchema} from '../../src/core/contracts.js';

export interface PublicSessionContext {signal:AbortSignal}
export interface PublicSessionOptions {
 task_id:PublicDecisionInput['task_id'];variant:PublicDecisionInput['variant'];trial_id:string;
 observe:(context:PublicSessionContext)=>Promise<PublicObservation>;
 decide:(input:PublicDecisionInput,context:PublicSessionContext)=>Promise<PublicDecision>;
 execute:(action:{candidate_id:string;binding:number},context:PublicSessionContext)=>Promise<void>;
 onEvent?:(event:PublicSessionEvent)=>void|Promise<void>;
 time_budget_ms?:number;max_actions?:number;signal?:AbortSignal;
}
export interface PublicSessionEvent {type:string;[key:string]:unknown}
export interface PublicSessionAction {candidate_id:string;status:'verified'|'uncertain';elapsed_ms:number}
export interface PublicSessionDecision extends Partial<PublicDecision> {status:'decided'|'failed';failure_code?:string}
export interface PublicSessionResult {status:'success'|'failed';failure_code?:string;actions:PublicSessionAction[];decisions:PublicSessionDecision[];elapsed_ms:number}
const ids=z.array(z.string().min(1).max(64)).max(64);
const observationSchema=z.strictObject({completed:ids,candidates:ids,bindings:z.record(z.string(),z.number().int().nonnegative()),terminal:z.boolean()});
const accountingSchema=z.object({usage:usageSchema.nullable(),request_count:z.number().int().min(0).max(1),known_cost_usd:z.number().finite().nonnegative(),unknown_usage_requests:z.number().int().min(0).max(1)});
const decisionSchema=accountingSchema.extend({candidate_id:z.string(),confidence:z.number().finite().min(0).max(1),elapsed_ms:z.number().finite().nonnegative(),request_plan:z.unknown()});
const searchFields=['language_english','fill_query'];
const dateFields=['fill_m1','fill_d1','fill_y1','fill_m2','fill_d2','fill_y2','include_end'];
class SessionFault extends Error {constructor(readonly code:string){super(code);}}
function sameList(a:unknown,b:readonly string[]):boolean{return Array.isArray(a)&&a.length===b.length&&a.every((id,i)=>id===b[i]);}
function samePlan(value:unknown,expected:PublicRequestPlan):boolean{
 if(!value||typeof value!=='object')return false;
 const plan=value as Record<string,unknown>,batches=plan.batches;
 return plan.variant===expected.variant&&plan.phase===expected.phase&&sameList(plan.effective_candidates,expected.effective_candidates)&&!!batches&&typeof batches==='object'&&sameList(Object.keys(batches).sort(),Object.keys(expected.batches).sort())&&Object.entries(expected.batches).every(([id,components])=>sameList((batches as Record<string,unknown>)[id],components));
}
/** Bounded orchestrator only: all UI and hosted-model work is supplied by the caller. */
export async function runPublicSession(options:PublicSessionOptions):Promise<PublicSessionResult>{
 const started=performance.now(),actions:PublicSessionAction[]=[],decisions:PublicSessionDecision[]=[];
 const result=(status:'success'|'failed',failure_code?:string):PublicSessionResult=>({status,...(failure_code?{failure_code}:{}),actions,decisions,elapsed_ms:performance.now()-started});
 const duration=options.time_budget_ms??300000,limit=options.max_actions??12;
 try{parsePublicInput({task_id:options.task_id,variant:options.variant,trial_id:options.trial_id,completed:[],candidates:[PUBLIC_TASKS[options.task_id]?.controls[0]]});if(!Number.isInteger(duration)||duration<1||duration>300000||!Number.isInteger(limit)||limit<1||limit>12)throw Error();}
 catch{return result('failed','INVALID_SESSION_INPUT');}
 const controller=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
 const deadline=started+duration,context={signal};
 const timer=setTimeout(()=>controller.abort(),duration);
 const check=()=>{if(options.signal?.aborted)throw new SessionFault('CANCELLED');if(signal.aborted||performance.now()>=deadline)throw new SessionFault('SESSION_DEADLINE');};
 const within=<T>(call:()=>T|Promise<T>):Promise<T>=>{check();return new Promise((resolve,reject)=>{const abort=()=>reject(new SessionFault(options.signal?.aborted?'CANCELLED':'SESSION_DEADLINE'));signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{check();return call();}).then(value=>{check();return value;}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});};
 const emit=async(event:PublicSessionEvent)=>{if(options.onEvent)try{await within(()=>options.onEvent!(structuredClone(event)));}catch(error){if(error instanceof SessionFault)throw error;throw new SessionFault('EVENT_FAILED');}};
 const observe=async()=>{
  let raw:unknown;try{raw=await within(()=>options.observe(context));}catch(error){if(error instanceof SessionFault)throw error;throw new SessionFault('OBSERVATION_FAILED');}
  const parsed=observationSchema.safeParse(raw);if(!parsed.success)throw new SessionFault('INVALID_OBSERVATION');
  const state=parsed.data,allowed:readonly string[]=PUBLIC_TASKS[options.task_id].controls;
  if([state.completed,state.candidates].some(list=>new Set(list).size!==list.length||list.some(id=>!allowed.includes(id)))||!sameList(Object.keys(state.bindings).sort(),[...state.candidates].sort()))throw new SessionFault('INVALID_OBSERVATION');
  await emit({type:'observation',completed:state.completed,candidates:state.candidates,terminal:state.terminal});return state;
 };
 try{
  let state=await observe();
  for(;;){
   check();if(state.terminal){await emit({type:'terminal',status:'success'});return result('success');}
   if(actions.length>=limit)throw new SessionFault('ACTION_LIMIT');
   if(state.candidates.length===0)throw new SessionFault('NO_CANDIDATES');
   const input:PublicDecisionInput={task_id:options.task_id,variant:options.variant,trial_id:options.trial_id,completed:[...state.completed],candidates:[...state.candidates]};
   let expected:PublicRequestPlan;try{expected=preparePublicRequest(input).request_plan;}catch{throw new SessionFault('NO_EFFECTIVE_CANDIDATES');}
   let raw:unknown;try{raw=await within(()=>options.decide(input,context));}catch(error){
    const accounting=accountingSchema.safeParse(error&&typeof error==='object'?(error as {accounting?:PublicAccounting}).accounting:undefined);
    decisions.push({status:'failed',failure_code:error instanceof SessionFault?error.code:'DECISION_FAILED',...(accounting.success?accounting.data:{})});
    if(error instanceof SessionFault)throw error;throw new SessionFault('DECISION_FAILED');
   }
   const parsed=decisionSchema.safeParse(raw);
   if(!parsed.success||!expected.effective_candidates.includes(parsed.data.candidate_id)||!samePlan(parsed.data.request_plan,expected)){const accounting=accountingSchema.safeParse(raw);decisions.push({status:'failed',failure_code:'INVALID_DECISION',...(accounting.success?accounting.data:{})});throw new SessionFault('INVALID_DECISION');}
   const decision:PublicDecision={...parsed.data,request_plan:expected};decisions.push({...decision,status:'decided'});
   await emit({type:'decision',...decision});
   if(decision.confidence<.9)throw new SessionFault('LOW_CONFIDENCE');
   const components=expected.batches[decision.candidate_id]??[decision.candidate_id];let progress=false;
   for(const id of components){
    state=await observe();if(state.terminal){await emit({type:'terminal',status:'success'});return result('success');}
    if(state.completed.includes(id))continue;
    if(!state.candidates.includes(id)||state.bindings[id]===undefined)throw new SessionFault('STALE_ACTION');
    const prerequisites=id==='submit_search'?searchFields:id==='calculate_duration'?dateFields:[];
    if(prerequisites.some(field=>!state.completed.includes(field)))throw new SessionFault('PRECONDITION_FAILED');
    if(actions.length>=limit)throw new SessionFault('ACTION_LIMIT');
    check();const actionStarted=performance.now(),action:PublicSessionAction={candidate_id:id,status:'uncertain',elapsed_ms:0};actions.push(action);
    try{await within(()=>options.execute({candidate_id:id,binding:state.bindings[id]!},context));}catch(error){action.elapsed_ms=performance.now()-actionStarted;if(error instanceof SessionFault)throw error;throw new SessionFault('EXECUTION_UNCERTAIN');}
    action.elapsed_ms=performance.now()-actionStarted;
    state=await observe();if(!state.terminal&&!state.completed.includes(id))throw new SessionFault('ACTION_NOT_VERIFIED');
    action.status='verified';progress=true;await emit({type:'action',...action});
    if(state.terminal){await emit({type:'terminal',status:'success'});return result('success');}
   }
   if(!progress&&sameList([...state.completed].sort(),[...input.completed].sort())&&sameList([...state.candidates].sort(),[...input.candidates].sort()))throw new SessionFault('NO_PROGRESS');
  }
 }catch(error){const code=error instanceof SessionFault?error.code:'SESSION_FAILED';try{await emit({type:'failure',code});}catch{/* Logging cannot make an uncertain action repeat. */}return result('failed',code);}
 finally{clearTimeout(timer);controller.abort();}
}
