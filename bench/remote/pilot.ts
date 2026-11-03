/** Historical pilot validation and safe sampling; no transport launcher. */
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {idSchema,usageSchema} from '../../src/core/contracts.js';
import {validateLedgerState} from '../../src/session/schema.js';
import {canonicalJson} from '../../src/remote/protocol.js';
const common={approval_id:idSchema,expires_at:z.number().int().positive(),max_requests:z.literal(30),max_cost_usd:z.literal(.1)};
const approvalSchema=z.strictObject({authorization:z.strictObject({...common,synthetic_only:z.literal(true)}),approval:z.strictObject({...common,reservation_usd:z.literal(.003)}),authorized_at:z.string(),scope:z.literal('local Mac loopback TLS synthetic pilot only; no physical second device or production app')});
export function validatePilotApproval(value:unknown,now=Date.now()){
 const parsed=approvalSchema.parse(value),a=parsed.authorization,b=parsed.approval,start=Date.parse(parsed.authorized_at);
 if(!Number.isFinite(start)||start>now||now-start>86400000||a.expires_at<=now||a.expires_at>start+86400000||a.approval_id!==b.approval_id||a.expires_at!==b.expires_at)throw new Error('INVALID_PILOT_APPROVAL');
 return parsed;
}
interface Attempt {trial_id:string;attempt:number;started_at:string;headers_at?:string;finished_at?:string;http_status?:number;headers_ms?:number;observed_ms?:number;usage?:z.infer<typeof usageSchema>;confidence?:number;observation?:string;transport_error?:boolean}
/** Only allowlisted metadata escapes the cloned response; never inspect request headers/body. */
export function createAttemptObserver(base:typeof fetch,onUpdate:()=>void,trial:()=>string,onFatal:(code:string)=>void){
 const attempts:Attempt[]=[];const pending=new Set<Promise<void>>();
 async function inspect(response:Response,row:Attempt,start:number){
  const reader=response.body?.getReader();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   if(!reader){row.observation='NO_BODY';return;}
   const chunks:Uint8Array[]=[];let bytes=0;
   const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('OBSERVATION_TIMEOUT')),2200);});
   for(;;){const chunk=await Promise.race([reader.read(),deadline]);if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>65536)throw new Error('OBSERVATION_LIMIT');chunks.push(chunk.value);}
   const value=JSON.parse(Buffer.concat(chunks).toString()) as {usage?:unknown;answers?:{action?:{confidence?:unknown}}};
   const usage=usageSchema.safeParse(value.usage);if(usage.success)row.usage=usage.data;
   const confidence=value.answers?.action?.confidence;if(typeof confidence==='number'&&Number.isFinite(confidence)&&confidence>=0&&confidence<=1)row.confidence=confidence;
   row.observation='BOUNDED_JSON';
  }catch{row.observation='UNAVAILABLE_OR_LIMITED';}
  finally{if(timer)clearTimeout(timer);void reader?.cancel().catch(()=>{});row.finished_at=new Date().toISOString();row.observed_ms=performance.now()-start;onUpdate();}
 }
 const transport:typeof fetch=async(url,options)=>{
  const start=performance.now(),row:Attempt={trial_id:trial(),attempt:attempts.length+1,started_at:new Date().toISOString()};attempts.push(row);onUpdate();
  try{
   const response=await base(url,options);row.http_status=response.status;row.headers_at=new Date().toISOString();row.headers_ms=performance.now()-start;
   if(response.status===401||response.status===403)onFatal('UPSTREAM_HTTP_'+response.status);
   onUpdate();
   const observation=inspect(response.clone(),row,start);pending.add(observation);void observation.then(()=>pending.delete(observation),()=>{pending.delete(observation);onFatal('OBSERVATION_PERSISTENCE_FAILED');});
   return response; // Do not await clone reads, change the response, or interfere with provider timing.
  }catch{row.transport_error=true;row.finished_at=new Date().toISOString();row.observed_ms=performance.now()-start;onFatal('UPSTREAM_TRANSPORT_UNKNOWN');onUpdate();throw new Error('PROVIDER_TRANSPORT_ERROR');}
 };
 return {attempts,transport,settle:async()=>{while(pending.size)await Promise.allSettled([...pending]);}};
}
type Task='cancel'|'correction'|'form'|'select';
type Frontend='cli'|'mcp';
const plan:Array<{id:string;task:Task;frontend:Frontend;max_steps:number;seed:number}>=[
 {id:'trial-01',task:'form',frontend:'cli',max_steps:4,seed:101},
 {id:'trial-02',task:'cancel',frontend:'mcp',max_steps:1,seed:102},
 {id:'trial-03',task:'correction',frontend:'cli',max_steps:3,seed:103},
 {id:'trial-04',task:'correction',frontend:'mcp',max_steps:3,seed:104},
 {id:'trial-05',task:'form',frontend:'mcp',max_steps:4,seed:105},
 {id:'trial-06',task:'cancel',frontend:'cli',max_steps:1,seed:106},
 {id:'trial-07',task:'cancel',frontend:'mcp',max_steps:1,seed:107},
 {id:'trial-08',task:'correction',frontend:'cli',max_steps:3,seed:108},
 {id:'trial-09',task:'form',frontend:'cli',max_steps:4,seed:109}
];
/** Fail closed on any previously started formal work, action ambiguity or changed approval. */
export function validateUnstartedContinuation(input:unknown):string {
 const budgetSchema=z.strictObject({approval:approvalSchema.shape.approval,requests:z.number().int().min(0).max(30),reserved_usd:z.number().min(0).max(.1)});
 const parsed=z.strictObject({approval:approvalSchema,mode:z.enum(['mock','live']),marker:z.strictObject({started_at:z.string(),approval_id:idSchema,approval_sha256:z.string(),mode:z.enum(['mock','live']),output:z.string().min(1)}),summary:z.object({mode:z.enum(['mock','live']),approval_id:idSchema,formal_planned:z.literal(9),formal_attempted:z.literal(0),formal_succeeded:z.literal(0),formal_success_denominator:z.literal(9),warmup_status:z.literal('FALLBACK'),budget_before:budgetSchema,budget_after:budgetSchema}).passthrough(),rows:z.unknown(),warmup:z.object({status:z.literal('FALLBACK'),result:z.object({session_id:idSchema,goal_id:z.literal('warmup'),status:z.literal('FALLBACK'),steps:z.literal(0),action_ids:z.array(z.unknown()).length(0)}).passthrough(),actions:z.array(z.unknown()).length(0)}).passthrough(),ledger:z.unknown(),budget:budgetSchema}).parse(input);
 const {approval,marker,summary,warmup,budget}=parsed;
 const fail=()=>{throw new Error('CONTINUATION_NOT_ALLOWED');};
 if(marker.approval_id!==approval.approval.approval_id||marker.approval_sha256!==createHash('sha256').update(JSON.stringify(approval)).digest('hex')||marker.mode!==parsed.mode||summary.mode!==parsed.mode||summary.approval_id!==marker.approval_id)fail();
 if(canonicalJson(parsed.rows)!==canonicalJson(plan.map(item=>({...item,status:'NOT_RUN'}))))fail();
 for(const value of [budget,summary.budget_before,summary.budget_after])if(canonicalJson(value.approval)!==canonicalJson(approval.approval)||Math.abs(value.reserved_usd-value.requests*.003)>1e-10)fail();
 if(budget.requests<summary.budget_after.requests||summary.budget_after.requests<summary.budget_before.requests)fail();
 const ledger=parsed.ledger;validateLedgerState(ledger);
 if(Object.keys(ledger.actions).length!==0||Object.keys(ledger.goals).length!==1||Object.values(ledger.sessions).some(session=>session.quarantined||!session.closed)||Object.values(ledger.goals).some(goal=>goal.status==='UNKNOWN'||goal.status==='RUNNING'||goal.steps!==0||goal.action_ids.length!==0))fail();
 if(canonicalJson(ledger.goals[`${warmup.result.session_id}:warmup`])!==canonicalJson(warmup.result))fail();
 return basename(marker.output)+'/summary.json';
}
