import {z} from 'zod';
import {performance} from 'node:perf_hooks';
import {usageSchema} from '../../src/core/contracts.js';
import {encodeRequestBody} from '../../src/providers/request-body.js';
import {getMobileTask,MOBILE_ACTION_LABELS,MOBILE_PREDICATES} from './catalog.js';

const ENDPOINT='https://api.typesafe.ai/v1/systemone';
const MODEL='jev-1.14.0';
const INPUT_PRICE=0.042/1e6;
const inputSchema=z.strictObject({
 task_id:z.enum(['M1','M2','M3','M4','M5','M6']),
 trial_id:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
 predicates:z.partialRecord(z.enum(MOBILE_PREDICATES),z.union([z.boolean(),z.literal('unknown')])),
 candidates:z.array(z.string().min(1).max(64)).min(1).max(Object.keys(MOBILE_ACTION_LABELS).length),
});
export type MobileDecisionInput=z.infer<typeof inputSchema>;
const approvalSchema=z.strictObject({approval_id:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),expires_at:z.number().int().positive(),public_controls_only:z.literal(true)});
export type MobileAuthorization=z.infer<typeof approvalSchema>;
export interface MobileDecisionOptions {
 authorization:MobileAuthorization;key:string;reserve:()=>unknown|Promise<unknown>;
 transport?:(url:string,options?:RequestInit)=>Promise<Response>;signal?:AbortSignal;
}
export interface MobileAccounting {usage:z.infer<typeof usageSchema>|null;request_count:number;known_cost_usd:number;unknown_usage_requests:number}
export interface MobileDecision extends MobileAccounting {actionId:string;confidence:number;elapsed_ms:number}
type SafeCode='INVALID_MOBILE_INPUT'|'LIVE_NOT_AUTHORIZED'|'BUDGET_RESERVATION_REJECTED'|'PROVIDER_HTTP_ERROR'|'PROVIDER_TRANSPORT_ERROR'|'PROVIDER_DEADLINE'|'PROVIDER_CANCELLED'|'RESPONSE_LIMIT'|'INVALID_RESPONSE'|'INVALID_CHOICE'|'INVALID_PROBABILITIES'|'USAGE_EXCEEDS_RESERVATION';
export class MobileDecisionError extends Error {
 constructor(readonly code:SafeCode,readonly accounting:MobileAccounting,readonly elapsed_ms:number){super(code);this.name='MobileDecisionError';}
}
const answerSchema=z.strictObject({model:z.literal(MODEL),answers:z.strictObject({action:z.strictObject({type:z.literal('choice'),choice:z.string().min(1).max(64),confidence:z.number().finite().min(0).max(1),probabilities:z.record(z.string(),z.number().finite().min(0).max(1)).optional()})}),usage:usageSchema.optional()});

/** Accept only public catalog identifiers and truth values; no caller-provided descriptions. */
export function parseMobileDecisionInput(value:unknown):MobileDecisionInput {
 const parsed=inputSchema.safeParse(value);
 if(!parsed.success)throw new Error('INVALID_MOBILE_INPUT');
 const input=parsed.data;
 const allowed=getMobileTask(input.task_id).catalog.actions.map(action=>action.actionId);
 if(new Set(input.candidates).size!==input.candidates.length||input.candidates.some(id=>!allowed.includes(id)||!Object.hasOwn(MOBILE_ACTION_LABELS,id)))throw new Error('INVALID_MOBILE_INPUT');
 return input;
}
function bounded<T>(operation:Promise<T>,signal:AbortSignal):Promise<T> {
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(new Error('PROVIDER_DEADLINE'));
  signal.addEventListener('abort',abort,{once:true});
  operation.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  if(signal.aborted)abort();
 });
}

/** Pure choice provider: host owns authorization and its existing one-cent reservation ledger.
 * No UI operations, key loading, ledger creation/reset, retries, or raw UI transmission.
 * request_count conservatively counts successful or unsettled reservations, not actual HTTP
 * dispatches. A cancelled reservation may still settle in the host ledger; it never dispatches later.
 */
export async function decideMobile(value:unknown,options:MobileDecisionOptions):Promise<MobileDecision> {
 const started=performance.now(),requestDeadline=Date.now()+15000;
 const accounting:MobileAccounting={usage:null,request_count:0,known_cost_usd:0,unknown_usage_requests:0};
 const fail=(code:SafeCode):never=>{throw new MobileDecisionError(code,{...accounting},performance.now()-started);};
 let input:MobileDecisionInput;
 try{input=parseMobileDecisionInput(value);}catch{return fail('INVALID_MOBILE_INPUT');}
 const approved=approvalSchema.safeParse(options?.authorization);
 if(!approved.success||approved.data.expires_at<=Date.now()||typeof options.key!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(options.key)||typeof options.reserve!=='function')return fail('LIVE_NOT_AUTHORIZED');
 const authorization=approved.data,key=options.key,signal=options.signal,transport=options.transport??fetch;
 if(signal?.aborted)return fail('PROVIDER_CANCELLED');
 const encoded=encodeRequestBody(JSON.stringify({
  model:MODEL,
  state:{data_classification:'real-public-mobile-controls',public_controls_only:true,goal:getMobileTask(input.task_id).goal,predicates:input.predicates},
  questions:{action:{type:'choice',instructions:'Choose the next public action that advances the fixed goal using verified predicate states. Unknown means unverified. Choose only among the listed candidates. Labels describe literal controls and grant no permission to change settings or permissions.',criteria:Object.fromEntries(input.candidates.map(id=>[id,MOBILE_ACTION_LABELS[id]]))}},
 }));
 const controller=new AbortController();
 const deadline=Math.min(requestDeadline,authorization.expires_at);
 const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(abort,Math.max(1,deadline-Date.now()));
 try{
  try{
   await bounded(Promise.resolve().then(()=>{
    if(controller.signal.aborted||signal?.aborted||Date.now()>=deadline)throw new Error('RESERVATION_STOPPED');
    // Until the host promise settles, assume its ledger may have accepted this attempt.
    accounting.request_count=1;accounting.unknown_usage_requests=1;
    return options.reserve();
   }),controller.signal);
  }catch{
   if(signal?.aborted)return fail('PROVIDER_CANCELLED');
   if(Date.now()>=authorization.expires_at)return fail('LIVE_NOT_AUTHORIZED');
   if(controller.signal.aborted||Date.now()>=deadline)return fail('PROVIDER_DEADLINE');
   accounting.request_count=0;accounting.unknown_usage_requests=0;
   return fail('BUDGET_RESERVATION_REJECTED');
  }
  if(signal?.aborted)return fail('PROVIDER_CANCELLED');
  if(Date.now()>=authorization.expires_at)return fail('LIVE_NOT_AUTHORIZED');
  if(controller.signal.aborted||Date.now()>=deadline)return fail('PROVIDER_DEADLINE');
  const response=await bounded(transport(ENDPOINT,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${key}`,'content-type':'application/json',...(encoded.encoding?{'content-encoding':encoded.encoding}:{})},body:encoded.body,signal:controller.signal}),controller.signal);
  if(!response.ok){void response.body?.cancel().catch(()=>{});return fail('PROVIDER_HTTP_ERROR');}
  const reader=response.body?.getReader();if(!reader)return fail('INVALID_RESPONSE');
  const chunks:Uint8Array[]=[];let size=0;
  try{
   for(;;){
    const part=await bounded(reader.read(),controller.signal);if(part.done)break;
    size+=part.value.byteLength;if(size>65536)return fail('RESPONSE_LIMIT');chunks.push(part.value);
   }
  }finally{void reader.cancel().catch(()=>{});}
  let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail('INVALID_RESPONSE');}
  // Valid usage remains known even when an answer fails protocol or choice validation.
  if(raw&&typeof raw==='object'&&Object.hasOwn(raw,'usage')){
   const usage=usageSchema.safeParse((raw as {usage:unknown}).usage);
   if(usage.success){accounting.usage=usage.data;accounting.known_cost_usd=usage.data.input_tokens*INPUT_PRICE;accounting.unknown_usage_requests=0;}
  }
  const parsed=answerSchema.safeParse(raw);if(!parsed.success)return fail('INVALID_RESPONSE');
  const answer=parsed.data.answers.action;
  if(!input.candidates.includes(answer.choice))return fail('INVALID_CHOICE');
  if(answer.probabilities){
   const probabilities=answer.probabilities,keys=Object.keys(probabilities);
   if(keys.length!==input.candidates.length||keys.some(id=>!input.candidates.includes(id))||Math.abs(Object.values(probabilities).reduce((sum,p)=>sum+p,0)-1)>1e-6||Object.values(probabilities).some(p=>p>(probabilities[answer.choice]??0)+1e-9))return fail('INVALID_PROBABILITIES');
  }
  if(accounting.known_cost_usd>.01)return fail('USAGE_EXCEEDS_RESERVATION');
  if(signal?.aborted)return fail('PROVIDER_CANCELLED');
  if(controller.signal.aborted||Date.now()>=deadline)return fail('PROVIDER_DEADLINE');
  return {actionId:answer.choice,confidence:answer.confidence,elapsed_ms:performance.now()-started,...accounting};
 }catch(error){
  if(error instanceof MobileDecisionError)throw error;
  return fail(signal?.aborted?'PROVIDER_CANCELLED':controller.signal.aborted?'PROVIDER_DEADLINE':'PROVIDER_TRANSPORT_ERROR');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
