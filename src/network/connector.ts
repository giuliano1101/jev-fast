import {request as httpsRequest} from 'node:https';
import {randomUUID} from 'node:crypto';
import {isAbsolute,basename,resolve} from 'node:path';
import {z} from 'zod';
import {Fault} from '../core/errors.js';
import {ipcCall,readCredential,safeCode} from '../service/ipc.js';
import {bindingSchema,canonicalJson,MAX_BODY,normalizeRequest,replySchema,syncReplySchema,type Delivery,type Outcome,type Sync} from './protocol.js';
import {ConnectorJournal} from './store.js';
import {tokenSchema,type NetworkToken} from './server.js';
export interface ConnectorOptions {url:string;deviceId:string;agentId:string;journalDir:string;credentialFile:string;token:NetworkToken;ca?:Buffer;pollMs?:number;}
const healthSchema=z.strictObject({ready:z.boolean(),instance_id:z.uuid()});
const ambiguous=new Set(['TRANSPORT_TIMEOUT','RESPONSE_LOST','SERVICE_UNAVAILABLE','INVALID_RESPONSE','FRAME_TOO_LARGE']);
/** HTTPS only, no redirects, fixed absolute deadline and strict byte caps. */
async function syncRequest(options:ConnectorOptions,body:Sync){
 if(options.token.expiresAt<=Date.now())throw new Fault('NETWORK_UNAUTHORIZED');
 const data=canonicalJson(body);if(Buffer.byteLength(data)>MAX_BODY)throw new Fault('NETWORK_BODY_LIMIT');
 return new Promise<z.infer<typeof syncReplySchema>>((resolve,reject)=>{
  let settled=false;
  const finish=(error?:Fault,value?:z.infer<typeof syncReplySchema>)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){req.destroy();reject(error);}else resolve(value!);};
  const req=httpsRequest(new URL('/connector/sync',options.url),{method:'POST',ca:options.ca,rejectUnauthorized:true,agent:false,headers:{authorization:'Bearer '+options.token.token,'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{
   if(res.statusCode!==200){res.resume();finish(new Fault(res.statusCode===409?'CONNECTOR_FENCED':res.statusCode===401?'NETWORK_UNAUTHORIZED':'NETWORK_UNAVAILABLE'));return;}
   let size=0;const chunks:Buffer[]=[];
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_BODY)finish(new Fault('NETWORK_BODY_LIMIT'));else chunks.push(chunk);});
   res.on('error',()=>finish(new Fault('NETWORK_UNAVAILABLE')));res.on('end',()=>{try{finish(undefined,syncReplySchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));}catch{finish(new Fault('NETWORK_INVALID_RESPONSE'));}});
  });
  const timer=setTimeout(()=>finish(new Fault('NETWORK_TIMEOUT')),5000);req.on('error',()=>finish(new Fault('NETWORK_UNAVAILABLE')));req.end(data);
 });
}
export async function startConnector(options:ConnectorOptions):Promise<{stop():Promise<void>;done:Promise<void>;failureCode():string|undefined}> {
 tokenSchema.parse(options.token);const binding=bindingSchema.parse({device_id:options.deviceId,agent_id:options.agentId});
 const url=new URL(options.url);if(url.protocol!=='https:'||url.origin!==options.url||url.username||url.password)throw new Fault('HTTPS_ORIGIN_REQUIRED');
 if(!isAbsolute(options.credentialFile)||basename(options.credentialFile)!=='client-a.json'||!isAbsolute(options.journalDir))throw new Fault('PRIVATE_CLIENT_A_REQUIRED');
 const pollMs=options.pollMs??250;if(!Number.isInteger(pollMs)||pollMs<25||pollMs>1000)throw new Fault('INVALID_NETWORK_LIMIT');
 const journal=new ConnectorJournal(options.journalDir,{url:url.origin,...binding,credentialFile:resolve(options.credentialFile)});
 const connectorId=randomUUID(),inflight=new Set<Promise<void>>();let failure:string|undefined;let stopping=false,wake:(()=>void)|undefined,stopPromise:Promise<void>|undefined;
 const sleep=(ms:number)=>new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=undefined;resolve();},ms);wake=()=>{clearTimeout(timer);wake=undefined;resolve();};});
 async function health(){try{const credential=await readCredential(options.credentialFile);return healthSchema.parse(await ipcCall(credential,'service.local_health',{}));}catch{return null;}}
 async function execute(job:Delivery){
  let outcome:Outcome={kind:'unknown'};
  try{
   if(stopping||Date.now()>=job.expires_at)throw new Fault('STALE_DELIVERY');
   // This fresh credential is used for BOTH preflight and execution. Never reread after ambiguity.
   const credential=await readCredential(options.credentialFile),preflight=healthSchema.parse(await ipcCall(credential,'service.local_health',{}));
   if(!preflight.ready||preflight.instance_id!==job.local_instance_id||Date.now()>=job.expires_at||stopping)throw new Fault('STALE_DELIVERY');
   try{const result=await ipcCall(credential,job.method,job.params);outcome={kind:'reply',reply:replySchema.parse({ok:true,result})};}
   catch(error){const code=safeCode(error);if(!(error instanceof Fault)||ambiguous.has(code))outcome={kind:'unknown'};else outcome={kind:'reply',reply:{ok:false,error:{code}}};}
   if(Buffer.byteLength(canonicalJson(outcome))>24000)outcome={kind:'unknown'};
  }catch{/* Preflight/credential failures cannot prove that the requested operation executed. */}
  journal.finish(job.request_id,outcome);
 }
 async function exchange(capacity:number){
  const current=await health(),pending=journal.pending();
  const response=await syncRequest(options,{connector_id:connectorId,ready:current?.ready??false,local_instance_id:current?.instance_id??null,capacity,results:pending?[pending]:[]});
  // Never acknowledge an unrelated result, even from an authenticated but damaged peer.
  for(const ack of response.acks){if(!pending||ack.request_id!==pending.request_id||ack.delivery_nonce!==pending.delivery_nonce)throw new Fault('NETWORK_INVALID_RESPONSE');journal.ack(ack.request_id,ack.delivery_nonce);}
  if(response.job){
   const job=response.job;if(job.device_id!==binding.device_id||job.agent_id!==binding.agent_id||capacity===0)throw new Fault('NETWORK_INVALID_RESPONSE');
   const normalized=normalizeRequest(job.method,{request_id:job.request_id,params:job.params});if(canonicalJson(normalized.params)!==canonicalJson(job.params))throw new Fault('NETWORK_INVALID_RESPONSE');
   if(journal.claim(job)){const task=execute(job);inflight.add(task);void task.finally(()=>inflight.delete(task)).catch(()=>{failure='JOURNAL_WRITE_FAILED';stopping=true;wake?.();});}
  }
 }
 const loop=(async()=>{
  let backoff=pollMs;
  while(!stopping){try{await exchange(Math.max(0,4-inflight.size));backoff=pollMs;}catch(error){if(error instanceof Fault&&['CONNECTOR_FENCED','NETWORK_UNAUTHORIZED','NETWORK_BODY_LIMIT','NETWORK_INVALID_RESPONSE','JOURNAL_CONFLICT','DELIVERY_CONFLICT','STORAGE_CLOSED'].includes(error.code)){failure=error.code;stopping=true;break;}backoff=Math.min(backoff*2,1000);}
   if(!stopping)await sleep(backoff);
  }
 })();
 const stop=()=>stopPromise??=(async()=>{stopping=true;wake?.();await loop;await Promise.allSettled([...inflight]);
  // Graceful stop saves all replies first, then attempts bounded reconciliation. Failure keeps the audit pending.
  try{for(let count=0;count<4&&journal.pending();count++)await exchange(0);}catch{/* Reconnect will resend the exact persisted outcome. */}finally{journal.close();}
 })();
 // Automatic fatal fencing drains without requiring the embedding process to notice.
 const done=loop.then(()=>stop());
 return {stop,done,failureCode:()=>failure};
}
