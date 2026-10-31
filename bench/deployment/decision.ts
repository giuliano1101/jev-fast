import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {usageSchema} from '../../src/core/contracts.js';
import {encodeRequestBody} from '../../src/providers/request-body.js';

const ENDPOINT='https://api.typesafe.ai/v1/systemone';
const MODEL='jev-1.14.0';
const INPUT_PRICE=0.042/1e6;
export const DEPLOYMENT_ACTIONS=Object.freeze({
 verify_uploaded_source:'Verify the already uploaded deployment source without exposing source or credentials.',
 verify_dns:'Verify the configured deployment DNS result without transmitting domain or address values.',
 inspect_listeners:'Inspect existing listener bindings without transmitting host addresses or process details.',
 prepare_private_relay:'Prepare the private relay using operator-provided private configuration.',
 verify_private_health:'Verify the prepared private relay health before public exposure.',
 publish_https:'Publish the authorized relay through HTTPS after private health verification.',
 verify_public_mcp:'Verify the published public MCP endpoint without transmitting its address or session data.',
 inspect_operator_route:'Verify the operator control route remains accessible only over loopback.',
} as const);
const actionIds=['verify_uploaded_source','verify_dns','inspect_listeners','prepare_private_relay','verify_private_health','publish_https','verify_public_mcp','inspect_operator_route'] as const;
const phases=['preflight','private_relay','private_health','https','public_mcp','operator_route'] as const;
const checks=['uploaded_source_verified','dns_verified','listeners_inspected','private_relay_prepared','private_health_verified','https_published','public_mcp_verified','operator_route_inspected'] as const;
const checkedSchema=z.strictObject({uploaded_source_verified:z.boolean(),dns_verified:z.boolean(),listeners_inspected:z.boolean(),private_relay_prepared:z.boolean(),private_health_verified:z.boolean(),https_published:z.boolean(),public_mcp_verified:z.boolean(),operator_route_inspected:z.boolean()});
const authorizedSchema=z.strictObject({verify_uploaded_source:z.boolean(),verify_dns:z.boolean(),inspect_listeners:z.boolean(),prepare_private_relay:z.boolean(),verify_private_health:z.boolean(),publish_https:z.boolean(),verify_public_mcp:z.boolean(),inspect_operator_route:z.boolean()});
const inputSchema=z.strictObject({phase:z.enum(phases),checked:checkedSchema,host_authorized:authorizedSchema,candidates:z.array(z.enum(actionIds)).min(1).max(actionIds.length)});
export type DeploymentDecisionInput=z.infer<typeof inputSchema>;
export type DeploymentActionId=typeof actionIds[number];
const approvalSchema=z.strictObject({approval_id:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),expires_at:z.number().int().positive(),real_public_controls_only:z.literal(true)});
export type DeploymentAuthorization=z.infer<typeof approvalSchema>;
export interface DeploymentRequestOptions {authorization:DeploymentAuthorization;reserve:()=>unknown|Promise<unknown>}
export interface DeploymentAdapterOptions {key:string;transport?:(url:string,options?:RequestInit)=>Promise<Response>}
export interface DeploymentAccounting {usage:z.infer<typeof usageSchema>|null;request_count:number;known_cost_usd:number;unknown_usage_requests:number}
export interface DeploymentDecision extends DeploymentAccounting {candidate_id:DeploymentActionId;confidence:number;selector_elapsed_ms:number;execution_status:'NOT_EXECUTED'}
export type DeploymentErrorCode='INVALID_DEPLOYMENT_INPUT'|'LIVE_NOT_AUTHORIZED'|'BUDGET_RESERVATION_REJECTED'|'PROVIDER_HTTP_ERROR'|'PROVIDER_TRANSPORT_ERROR'|'PROVIDER_DEADLINE'|'RESPONSE_LIMIT'|'INVALID_RESPONSE'|'INVALID_CHOICE'|'INVALID_PROBABILITIES'|'USAGE_EXCEEDS_RESERVATION';
export class DeploymentDecisionError extends Error {
 constructor(readonly code:DeploymentErrorCode,readonly accounting:DeploymentAccounting,readonly selector_elapsed_ms:number){super(code);this.name='DeploymentDecisionError';}
}
const answerSchema=z.strictObject({model:z.literal(MODEL),answers:z.strictObject({action:z.strictObject({type:z.literal('choice'),choice:z.string().min(1).max(64),confidence:z.number().finite().min(0).max(1),probabilities:z.record(z.string(),z.number().finite().min(0).max(1)).optional()})}),usage:usageSchema.optional()});

/** The caller supplies only checked facts and explicit host eligibility, never raw observations. */
export function parseDeploymentDecisionInput(value:unknown):DeploymentDecisionInput {
 const parsed=inputSchema.safeParse(value);
 if(!parsed.success)throw new Error('INVALID_DEPLOYMENT_INPUT');
 const input=parsed.data;
 const allowed=input.phase==='preflight'?actionIds.slice(0,3):[actionIds[phases.indexOf(input.phase)+2]!];
 if(new Set(input.candidates).size!==input.candidates.length)throw new Error('INVALID_DEPLOYMENT_INPUT');
 for(const id of input.candidates){
  const index=actionIds.indexOf(id);
  if(!allowed.includes(id)||!input.host_authorized[id]||input.checked[checks[index]!]||index>=3&&checks.slice(0,index).some(key=>!input.checked[key]))throw new Error('INVALID_DEPLOYMENT_INPUT');
 }
 // Later-stage facts are valid only after all prerequisite facts were checked by the host.
 for(let index=3;index<checks.length;index++)if(input.checked[checks[index]!]&&checks.slice(0,index).some(key=>!input.checked[key]))throw new Error('INVALID_DEPLOYMENT_INPUT');
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

/** Narrow real deployment research selector, separate from the synthetic Engine contract.
 * The host independently authorizes and executes UI actions and verifies their outcomes.
 * This class never executes shell/UI actions, loads keys, creates ledgers, approves spending,
 * retries requests, or accepts raw account/UI data. The constructor alone receives the key.
 * reserve must persist one current host-approved request with at most $0.01 exposure before
 * returning; pending reservations conservatively count as unknown and must not be replayed.
 * selector_elapsed_ms includes reservation, model request and validation, never UI execution.
 */
export class DeploymentDecisionAdapter {
 readonly #key:string;
 readonly #transport:(url:string,options?:RequestInit)=>Promise<Response>;
 constructor(options:DeploymentAdapterOptions){this.#key=options.key;this.#transport=options.transport??fetch;}
 async decide(value:unknown,options:DeploymentRequestOptions):Promise<DeploymentDecision>{
  const started=performance.now(),requestDeadline=Date.now()+15000;
  const accounting:DeploymentAccounting={usage:null,request_count:0,known_cost_usd:0,unknown_usage_requests:0};
  const fail=(code:DeploymentErrorCode):never=>{throw new DeploymentDecisionError(code,{...accounting},performance.now()-started);};
  let input:DeploymentDecisionInput;
  try{input=parseDeploymentDecisionInput(value);}catch{return fail('INVALID_DEPLOYMENT_INPUT');}
  const approved=approvalSchema.safeParse(options?.authorization);
  if(!approved.success||approved.data.expires_at<=Date.now()||typeof this.#key!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(this.#key)||typeof options.reserve!=='function')return fail('LIVE_NOT_AUTHORIZED');
  const authorization=approved.data,reserve=options.reserve;
  const encoded=encodeRequestBody(JSON.stringify({model:MODEL,state:{data_classification:'real-public-deployment-controls',real_public_controls_only:true,goal:'Select the next host-authorized deployment control from the fixed real deployment catalog.',phase:input.phase,checked:input.checked},questions:{action:{type:'choice',instructions:'Choose one listed eligible deployment control. Host checked facts and current phase constrain eligibility. Selection grants no execution or budget permission; the host independently authorizes and performs the actual UI action.',criteria:Object.fromEntries(input.candidates.map(id=>[id,DEPLOYMENT_ACTIONS[id]]))}}}));
  const controller=new AbortController(),deadline=Math.min(requestDeadline,authorization.expires_at);
  const timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
  try{
   try{
    await bounded(Promise.resolve().then(()=>{
     if(controller.signal.aborted||Date.now()>=deadline)throw new Error('RESERVATION_STOPPED');
     accounting.request_count=1;accounting.unknown_usage_requests=1;
     return reserve();
    }),controller.signal);
   }catch{
    if(Date.now()>=authorization.expires_at)return fail('LIVE_NOT_AUTHORIZED');
    if(controller.signal.aborted||Date.now()>=deadline)return fail('PROVIDER_DEADLINE');
    accounting.request_count=0;accounting.unknown_usage_requests=0;
    return fail('BUDGET_RESERVATION_REJECTED');
   }
   if(Date.now()>=authorization.expires_at)return fail('LIVE_NOT_AUTHORIZED');
   if(controller.signal.aborted||Date.now()>=deadline)return fail('PROVIDER_DEADLINE');
   const response=await bounded(this.#transport(ENDPOINT,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${this.#key}`,'content-type':'application/json',...(encoded.encoding?{'content-encoding':encoded.encoding}:{})},body:encoded.body,signal:controller.signal}),controller.signal);
   if(!response.ok){void response.body?.cancel().catch(()=>{});return fail('PROVIDER_HTTP_ERROR');}
   const reader=response.body?.getReader();if(!reader)return fail('INVALID_RESPONSE');
   const chunks:Uint8Array[]=[];let size=0;
   try{
    for(;;){const part=await bounded(reader.read(),controller.signal);if(part.done)break;size+=part.value.byteLength;if(size>65536)return fail('RESPONSE_LIMIT');chunks.push(part.value);}
   }finally{void reader.cancel().catch(()=>{});}
   let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return fail('INVALID_RESPONSE');}
   // Bad choices or malformed answers still retain independently valid usage accounting.
   if(raw&&typeof raw==='object'&&Object.hasOwn(raw,'usage')){const usage=usageSchema.safeParse((raw as {usage:unknown}).usage);if(usage.success){accounting.usage=usage.data;accounting.known_cost_usd=usage.data.input_tokens*INPUT_PRICE;accounting.unknown_usage_requests=0;}}
   const parsed=answerSchema.safeParse(raw);if(!parsed.success)return fail('INVALID_RESPONSE');
   const answer=parsed.data.answers.action;
   if(!input.candidates.includes(answer.choice as DeploymentActionId))return fail('INVALID_CHOICE');
   if(answer.probabilities){
    const probabilities=answer.probabilities,keys=Object.keys(probabilities);
    if(keys.length!==input.candidates.length||keys.some(id=>!input.candidates.includes(id as DeploymentActionId))||Math.abs(Object.values(probabilities).reduce((sum,p)=>sum+p,0)-1)>1e-6||Object.values(probabilities).some(p=>p>(probabilities[answer.choice]??0)+1e-9))return fail('INVALID_PROBABILITIES');
   }
   if(accounting.known_cost_usd>.01)return fail('USAGE_EXCEEDS_RESERVATION');
   if(controller.signal.aborted||Date.now()>=deadline)return fail('PROVIDER_DEADLINE');
   return {candidate_id:answer.choice as DeploymentActionId,confidence:answer.confidence,selector_elapsed_ms:performance.now()-started,execution_status:'NOT_EXECUTED',...accounting};
  }catch(error){if(error instanceof DeploymentDecisionError)throw error;return fail(controller.signal.aborted?'PROVIDER_DEADLINE':'PROVIDER_TRANSPORT_ERROR');}
  finally{clearTimeout(timer);controller.abort();}
 }
}

/** Function entry point; credentials belong exclusively to the privately configured adapter. */
export function decideDeployment(value:unknown,adapter:DeploymentDecisionAdapter,options:DeploymentRequestOptions):Promise<DeploymentDecision>{
 return adapter.decide(value,options);
}
