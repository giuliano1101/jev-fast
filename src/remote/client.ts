import {request as httpsRequest} from 'node:https';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import type {DecisionContext,DecisionInput,DecisionProvider} from '../core/contracts.js';
import {Fault} from '../core/errors.js';
import {canonicalDigest,parseDecisionRequest,responseSchema,identitySchema,type DecisionResponse} from './protocol.js';
export interface RemoteDecisionOptions {url:string;cert:string|Buffer;key:string|Buffer;ca:string|Buffer;token:string;tokenLoader?:()=>Promise<string>;}
const healthSchema=z.strictObject({mode:z.enum(['mock','jev']),model:z.enum(['mock-v1','jev-1.14.0']),protocol:z.literal('decision-v1'),policy:z.literal('p0-v1'),identity:identitySchema}).refine(value=>(value.mode==='mock')===(value.model==='mock-v1'));
export type RemoteHealth=z.infer<typeof healthSchema>;
const safeCodes=new Set(['UNAUTHENTICATED','FORBIDDEN','INVALID_PROTOCOL','REQUEST_TOO_LARGE','STALE_SNAPSHOT','BUDGET_EXHAUSTED','RATE_LIMITED','PROVIDER_UNAVAILABLE','IDEMPOTENCY_CONFLICT','DECISION_UNKNOWN','LIVE_NOT_AUTHORIZED','INVALID_DECISION']);
/** HTTPS decision transport only. The local Engine independently verifies and consumes receipts. */
export class RemoteDecisionProvider implements DecisionProvider {
 private readonly url:URL;private readonly options:RemoteDecisionOptions;
 constructor(options:RemoteDecisionOptions){
  let url:URL;try{url=new URL(options.url);}catch{throw new Fault('INVALID_REMOTE_CONFIGURATION');}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!options.cert||!options.key||!options.ca||!options.token||/[\r\n]/.test(options.token))throw new Fault('INVALID_REMOTE_CONFIGURATION');
  this.url=url;this.options={...options};
 }
 async decide(input:DecisionInput,context:DecisionContext):Promise<DecisionResponse>{
  if(context.signal.aborted)throw new Fault('CANCELLED');
  const request=parseDecisionRequest(context.remoteRequest);
  if(canonicalDigest(input)!==canonicalDigest(request.input))throw new Fault('REMOTE_INPUT_MISMATCH');
  const remaining=Math.floor(Math.min(context.deadline-Date.now(),request.deadline_ms,request.snapshot.valid_for_ms,2000));
  if(!Number.isFinite(remaining)||remaining<=0)throw new Fault('STALE_SNAPSHOT');
  const raw=await this.exchange('/v1/decisions','POST',JSON.stringify(request),remaining,context.signal);
  const parsed=responseSchema.safeParse(raw);if(!parsed.success)throw new Fault('INVALID_RESPONSE');return parsed.data;
 }
 /** An authenticated diagnostic: success proves the token and current enrollment are valid. */
 async health(context:{signal?:AbortSignal;deadline?:number}={}):Promise<RemoteHealth>{
  const remaining=Math.floor(Math.min((context.deadline??Date.now()+2000)-Date.now(),2000));
  const raw=await this.exchange('/health','GET',undefined,remaining,context.signal??new AbortController().signal);
  const parsed=healthSchema.safeParse(raw);if(!parsed.success)throw new Fault('INVALID_RESPONSE');return parsed.data;
 }
 private async exchange(path:string,method:'POST'|'GET',body:string|undefined,remaining:number,signal:AbortSignal):Promise<unknown>{
  if(signal.aborted)throw new Fault('CANCELLED');if(!Number.isFinite(remaining)||remaining<=0)throw new Fault('PROVIDER_DEADLINE');
  const expires=performance.now()+remaining;
  return new Promise<unknown>((resolve,reject)=>{
   let req:ReturnType<typeof httpsRequest>|undefined;
   let settled=false;const finish=(error?:Fault,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(value);};
   const abort=()=>{finish(new Fault('CANCELLED'));req?.destroy();};
   const timer=setTimeout(()=>{finish(new Fault('PROVIDER_DEADLINE'));req?.destroy();},remaining);
   signal.addEventListener('abort',abort,{once:true});
   const dispatch=async()=>{
    const token=this.options.tokenLoader?await this.options.tokenLoader():this.options.token;
    if(settled)return;if(signal.aborted){abort();return;}
    if(performance.now()>=expires){finish(new Fault('PROVIDER_DEADLINE'));return;}
    if(this.options.tokenLoader&&(typeof token!=='string'||token.length>8192||!/^[\x21-\x7e]+$/.test(token)))throw new Fault('INVALID_REMOTE_CONFIGURATION');
    req=httpsRequest(new URL(path,this.url),{method,cert:this.options.cert,key:this.options.key,ca:this.options.ca,rejectUnauthorized:true,minVersion:'TLSv1.2',agent:false,headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(body)})}},res=>{
    const chunks:Buffer[]=[];let size=0;
    res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>64000){finish(new Fault('RESPONSE_LIMIT'));res.destroy();req?.destroy();}else chunks.push(chunk);});
    res.on('error',()=>finish(new Fault('PROVIDER_UNAVAILABLE')));
    res.on('aborted',()=>finish(new Fault('PROVIDER_UNAVAILABLE')));
    res.on('end',()=>{
     if(settled)return;if(performance.now()>=expires){finish(new Fault('PROVIDER_DEADLINE'));return;}
     let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{finish(new Fault('INVALID_RESPONSE'));return;}
     if(res.statusCode!==200){const code=raw&&typeof raw==='object'&&'code' in raw?String(raw.code):'';finish(new Fault(safeCodes.has(code)?code:'PROVIDER_UNAVAILABLE'));return;}finish(undefined,raw);
    });
   });
    req.on('error',()=>finish(new Fault('PROVIDER_UNAVAILABLE')));
    if(signal.aborted){abort();return;}req.end(body);
   };
   if(signal.aborted){abort();return;}
   void dispatch().catch(()=>{finish(new Fault('PROVIDER_UNAVAILABLE'));req?.destroy();});
  }).catch(error=>{throw error instanceof Fault?error:new Fault('PROVIDER_UNAVAILABLE');});
 }
}

import {choiceArgsSchema,type ChoiceArgs} from '../choice/contracts.js';
import {choiceSignal,choiceWithin} from '../choice/timing.js';
import {choiceRequestSchema,choiceResponseSchema,type ChoiceResponse} from './choice.js';
import {CHOICE_BODY_BYTES} from '../providers/choice.js';
/** Generic decision transport; caller_scope is supplied by the trusted host, never the public tool args. */
export class RemoteChoiceClient {
 private readonly url:URL;
 constructor(private readonly options:RemoteDecisionOptions){
  try{this.url=new URL(options.url);}catch{throw new Fault('INVALID_REMOTE_CONFIGURATION');}
  if(this.url.protocol!=='https:'||this.url.username||this.url.password||this.url.pathname!=='/'||this.url.search||this.url.hash||!options.cert||!options.key||!options.ca||!options.token||/[\r\n]/.test(options.token))throw new Fault('INVALID_REMOTE_CONFIGURATION');
 }
 async choose(callerScope:string,value:ChoiceArgs,parent:AbortSignal):Promise<ChoiceResponse>{
  const args=choiceArgsSchema.parse(value),request=choiceRequestSchema.parse({caller_scope:callerScope,args}),body=JSON.stringify(request);if(Buffer.byteLength(body)>CHOICE_BODY_BYTES)throw new Fault('REQUEST_TOO_LARGE');
  const context=choiceSignal(parent,args.timeout_ms),signal=context.signal;let req:ReturnType<typeof httpsRequest>|undefined;
  try{
   const token=await choiceWithin(Promise.resolve().then(()=>this.options.tokenLoader?this.options.tokenLoader():this.options.token),signal);
   if(typeof token!=='string'||token.length>8192||!/^[\x21-\x7e]+$/.test(token))throw new Fault('INVALID_REMOTE_CONFIGURATION');
   context.check();return await new Promise<ChoiceResponse>((resolve,reject)=>{
    let settled=false;const finish=(error?:Fault,result?:ChoiceResponse)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(result!);};
    const abort=()=>{finish(new Fault('CANCELLED'));req?.destroy();};signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
    req=httpsRequest(new URL('/v1/choices',this.url),{method:'POST',cert:this.options.cert,key:this.options.key,ca:this.options.ca,rejectUnauthorized:true,minVersion:'TLSv1.2',agent:false,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
     const chunks:Buffer[]=[];let bytes=0;res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>CHOICE_BODY_BYTES){finish(new Fault('RESPONSE_LIMIT'));res.destroy();req?.destroy();}else chunks.push(chunk);});
     res.on('error',()=>finish(new Fault('PROVIDER_UNAVAILABLE')));res.on('aborted',()=>finish(new Fault('PROVIDER_UNAVAILABLE')));
     res.on('end',()=>{if(settled)return;try{context.check();}catch{finish(new Fault('CANCELLED'));return;}let raw:unknown;try{raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{finish(new Fault('INVALID_RESPONSE'));return;}
      if(res.statusCode!==200){const code=raw&&typeof raw==='object'&&'code' in raw?String(raw.code):'';finish(new Fault(safeCodes.has(code)?code:'PROVIDER_UNAVAILABLE'));return;}
      const response=choiceResponseSchema.safeParse(raw);if(!response.success){finish(new Fault('INVALID_RESPONSE'));return;}finish(undefined,response.data);
     });
    });req.on('error',()=>finish(new Fault('PROVIDER_UNAVAILABLE')));if(signal.aborted){abort();return;}req.end(body);
   });
  }finally{context.close();}
 }
}
