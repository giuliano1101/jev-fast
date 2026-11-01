import {z} from 'zod';
import {choiceArgsSchema,type ChoiceArgs,type ChoiceDecision} from '../choice/contracts.js';
import {choiceSignal,choiceWithin} from '../choice/timing.js';
import {usageSchema} from '../core/contracts.js';
import {Fault} from '../core/errors.js';
import {canonicalJson} from '../remote/protocol.js';
import type {AttemptRecorder,AttemptUsage} from '../remote/usage.js';
/** Transport resource guards: 16 MiB UTF-8 request/response; canonical JSON depth 32. */
export const CHOICE_BODY_BYTES=16*1024*1024;
export interface JevChoiceOptions {key:string;recorder:AttemptRecorder;transport?:(url:string,options?:RequestInit)=>Promise<Response>;beforeAttempt?:()=>void|Promise<void>}
const answerSchema=z.object({model:z.literal('jev-1.14.0'),answers:z.object({action:z.object({type:z.literal('choice'),choice:z.string().min(1),confidence:z.number().finite().min(0).max(1)})})});
/** Decision only. A chosen label neither executes an action nor authorizes host tool use. No automatic retries. */
export class JevChoiceProvider {
 constructor(private readonly options:JevChoiceOptions){if(!options.key||options.key.trim()!==options.key||typeof options.recorder?.begin!=='function'||typeof options.recorder?.finish!=='function')throw new Fault('LIVE_NOT_AUTHORIZED');}
 async choose(value:ChoiceArgs,parent:AbortSignal):Promise<ChoiceDecision>{
  const parsed=choiceArgsSchema.safeParse(value);if(!parsed.success)throw new Fault('INVALID_PROTOCOL');const args=parsed.data;
  const body=canonicalJson({model:'jev-1.14.0',state:{task:args.task,observation:args.state},questions:{action:{type:'choice',instructions:'Choose the action that best advances the task using the provided observation. The labels describe candidate actions; choosing one does not execute it or grant execution authority.',criteria:Object.fromEntries(args.actions.map(action=>[action.id,action.description]))}}});
  if(Buffer.byteLength(body)>CHOICE_BODY_BYTES)throw new Fault('REQUEST_TOO_LARGE');
  const context=choiceSignal(parent,args.timeout_ms),signal=context.signal;let attempt:string|undefined,httpStatus:number|null=null,usage:AttemptUsage|null=null;
  const check=()=>context.check();
  try{
   check();if(this.options.beforeAttempt)await choiceWithin(Promise.resolve().then(()=>{check();return this.options.beforeAttempt!();}),signal);
   check();attempt=await choiceWithin(Promise.resolve().then(()=>{check();return this.options.recorder.begin();}),signal);
   check();if(this.options.beforeAttempt)await choiceWithin(Promise.resolve().then(()=>{check();return this.options.beforeAttempt!();}),signal);
   check();const response=await choiceWithin((this.options.transport??fetch)('https://api.typesafe.ai/v1/systemone',{method:'POST',redirect:'error',headers:{authorization:`Bearer ${this.options.key}`,'content-type':'application/json'},body,signal}),signal);httpStatus=response.status;
   let raw:unknown;const reader=response.body?.getReader();if(reader){const chunks:Uint8Array[]=[];let bytes=0;try{for(;;){const chunk=await choiceWithin(reader.read(),signal);if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>CHOICE_BODY_BYTES)throw new Fault('RESPONSE_LIMIT');chunks.push(chunk.value);}try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{/* Missing/invalid JSON remains unknown usage. */}}finally{void reader.cancel().catch(()=>{});}}
   if(raw&&typeof raw==='object'){const metered=usageSchema.safeParse((raw as Record<string,unknown>).usage);if(metered.success)usage=metered.data;}
   if(!response.ok)throw new Fault('PROVIDER_HTTP_ERROR');const result=answerSchema.safeParse(raw);if(!result.success||!args.actions.some(action=>action.id===result.data.answers.action.choice))throw new Fault('INVALID_RESPONSE');check();
   return {provider:'jev',model:'jev-1.14.0',selected_id:result.data.answers.action.choice,confidence:result.data.answers.action.confidence,usage};
  }catch(error){if(error instanceof Fault)throw error;throw new Fault(signal.aborted?'CANCELLED':'PROVIDER_UNAVAILABLE');}
  finally{try{if(attempt)await choiceWithin(Promise.resolve().then(()=>this.options.recorder.finish(attempt!,{http_status:httpStatus,usage})),signal);context.check();}finally{context.close();}}
 }
}
