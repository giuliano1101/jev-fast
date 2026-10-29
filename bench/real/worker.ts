import {z} from 'zod';
import {mkdir,readFile,writeFile,rename,readdir,open,unlink} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {parsePublicInput,PUBLIC_CONTROLS,type PublicDecisionInput} from './catalog.js';
import {runPublicDecisionFile} from './decision.js';
import {usageSchema} from '../../src/core/contracts.js';

const nonceSchema=z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const requestSchema=z.strictObject({nonce:nonceSchema,input:z.unknown()});
const control=z.string().refine(value=>Object.hasOwn(PUBLIC_CONTROLS,value));
const action=z.string().refine(value=>Object.hasOwn(PUBLIC_CONTROLS,value)||value==='prepare_search'||value==='prepare_dates');
const accounting={usage:usageSchema.nullable().optional(),request_count:z.number().int().min(0).max(1).optional(),known_cost_usd:z.number().finite().nonnegative().optional(),unknown_usage_requests:z.number().int().min(0).max(1).optional()};
const plan=z.object({variant:z.enum(['baseline','optimized']),phase:z.string().refine(value=>['baseline','verify_goal','prepare_search','prepare_dates'].includes(value)||Object.hasOwn(PUBLIC_CONTROLS,value)),effective_candidates:z.array(action).max(64),batches:z.object({prepare_search:z.array(control).max(7).optional(),prepare_dates:z.array(control).max(7).optional()})});
const codes=z.enum(['INVALID_PUBLIC_INPUT','NO_EFFECTIVE_CANDIDATES','LIVE_NOT_AUTHORIZED','BUDGET_RESERVATION_REJECTED','PROVIDER_HTTP_ERROR','PROVIDER_TRANSPORT_ERROR','PROVIDER_DEADLINE','RESPONSE_LIMIT','INVALID_RESPONSE','INVALID_CHOICE','INVALID_PROBABILITIES','USAGE_EXCEEDS_RESERVATION','PUBLIC_PREFLIGHT_REJECTED','WORKER_DECISION_FAILED','DECISION_FAILED']);
const responseSchema=z.object({status:z.enum(['decided','failed']),result:z.object({candidate_id:action,confidence:z.number().finite().min(0).max(1),elapsed_ms:z.number().finite().nonnegative().optional(),...accounting,request_plan:plan.optional()}).optional(),error:z.object({code:codes,accounting:z.object(accounting).optional(),elapsed_ms:z.number().finite().nonnegative().optional(),request_plan:plan.optional()}).optional(),budget:z.object({requests:z.number().int().nonnegative(),reservedUsd:z.number().finite().nonnegative(),maxUsd:z.number().positive().max(3),maxRequests:z.number().int().positive().max(300),expiresAt:z.number().int().positive()}).nullable().optional()});
export interface PublicQueueState {handled_nonces:Set<string>}
export interface PublicQueueOutput {nonce:string;decision:z.infer<typeof responseSchema>&{artifact?:string}}
function parseRequest(value:unknown):{nonce:string;input:PublicDecisionInput}{try{const parsed=requestSchema.parse(value);return {nonce:parsed.nonce,input:parsePublicInput(parsed.input)};}catch{throw new Error('INVALID_QUEUE_REQUEST');}}
/** Consumes a nonce before invoking its one authorized decision attempt. Never retries. */
export async function processQueueOnce(value:unknown,state:PublicQueueState,decide:(input:PublicDecisionInput)=>Promise<unknown>):Promise<PublicQueueOutput|null>{
 const request=parseRequest(value);if(state.handled_nonces.has(request.nonce))return null;state.handled_nonces.add(request.nonce);
 try{const raw=await decide(request.input);const path=raw&&typeof raw==='object'?(raw as {path?:unknown}).path:undefined;const filename=typeof path==='string'?basename(path):'';const artifact=/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(filename)?filename:undefined;return {nonce:request.nonce,decision:{...responseSchema.parse(raw),...(artifact?{artifact}:{})}};}
 catch{return {nonce:request.nonce,decision:{status:'failed',error:{code:'WORKER_DECISION_FAILED'}}};}
}
/** Start from the repository cwd. The existing bridge retains key ownership and budget enforcement. */
export async function runPublicQueueWorker(keyPath:string):Promise<void>{
 const queue=resolve('.runtime/real-queue');await mkdir(queue,{recursive:true,mode:0o700});
 const lock=await open(join(queue,'.worker.lock'),'wx',0o600);
 try{
  const prior=JSON.parse(await readFile(resolve('.runtime/live-budget/budget.json'),'utf8')) as {expiresAt:unknown};
  if(!Number.isSafeInteger(prior.expiresAt)||Number(prior.expiresAt)<=Date.now())throw new Error('WORKER_BUDGET_EXPIRED');
  const deadline=Math.min(Date.now()+300000,Number(prior.expiresAt));
  const state:PublicQueueState={handled_nonces:new Set((await readdir(queue)).flatMap(name=>{const match=name.match(/^claim-([A-Za-z0-9_-]{1,64})\.json$/);return match?[match[1]!]:[];}))};
  console.log(JSON.stringify({status:'PUBLIC_QUEUE_WORKER_READY',deadline_ms:deadline}));
  while(Date.now()<deadline){
   let request:{nonce:string;input:PublicDecisionInput}|undefined;
   try{const bytes=await readFile(join(queue,'input.json'));if(bytes.byteLength<=16384)request=parseRequest(JSON.parse(bytes.toString('utf8')));}catch{/* Partial or invalid writes cannot start a request. */}
   if(request&&!state.handled_nonces.has(request.nonce)){
    // The decision bridge has a 15-second attempt deadline; leave that full window.
    if(Date.now()+15000>=deadline)break;
    const selected=request;
    const output=await processQueueOnce(selected,state,async input=>{
     if(Date.now()>=deadline)throw new Error('WORKER_EXPIRED');
     const claim=await open(join(queue,`claim-${selected.nonce}.json`),'wx',0o600);
     try{await claim.writeFile(JSON.stringify({nonce:selected.nonce,started_at:new Date().toISOString()}));await claim.sync();}finally{await claim.close();}
     const queueDirectory=await open(queue,'r');try{await queueDirectory.sync();}finally{await queueDirectory.close();}
     const inputPath=join(queue,'decision-input.json');await writeFile(inputPath,JSON.stringify(input),{mode:0o600});
     if(Date.now()+15000>=deadline)throw new Error('WORKER_EXPIRED');
     return runPublicDecisionFile(keyPath,inputPath);
    });
    if(output){const temporary=join(queue,`output-${selected.nonce}.tmp`);await writeFile(temporary,JSON.stringify(output),{mode:0o600});await rename(temporary,join(queue,'output.json'));}
   }
   await delay(Math.max(1,Math.min(100,deadline-Date.now())));
  }
 }finally{await lock.close();await unlink(join(queue,'.worker.lock'));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){runPublicQueueWorker(process.argv[2]??'').catch(()=>{console.error('PUBLIC_QUEUE_WORKER_FAILED_CLOSED');process.exitCode=1;});}
