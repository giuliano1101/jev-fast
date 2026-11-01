import {request as httpsRequest,Agent} from 'node:https';
import {isAbsolute,basename,resolve,join,dirname} from 'node:path';
import {lstat,open,unlink} from 'node:fs/promises';
import {z} from 'zod';
import {Fault} from '../core/errors.js';
import {ipcCall,readCredential,safeCode} from '../service/ipc.js';
import {bindingSchema,canonicalJson,MAX_BODY,normalizeRequest,replySchema,type Delivery,type Outcome} from './protocol.js';
import {manualSyncReplySchema} from './manual-protocol.js';
import {ConnectorJournal} from './store.js';
export interface ManualConnectorOptions {accessMode?:'manual';url:string;name:string;deviceId:string;agentId:string;journalDir:string;credentialFile:string;ca?:Buffer;pollMs?:number;}
const healthSchema=z.strictObject({ready:z.boolean(),instance_id:z.uuid()});
const ambiguous=new Set(['TRANSPORT_TIMEOUT','RESPONSE_LOST','SERVICE_UNAVAILABLE','INVALID_RESPONSE','FRAME_TOO_LARGE']);
async function post<T>(options:ManualConnectorOptions,path:string,body:unknown,schema:z.ZodType<T>,agent:Agent):Promise<T>{
 const data=canonicalJson(body);if(Buffer.byteLength(data)>MAX_BODY)throw new Fault('NETWORK_BODY_LIMIT');
 return new Promise<T>((done,fail)=>{
  let settled=false;const finish=(error?:Fault,value?:T)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){req.destroy();fail(error);}else done(value!);};
  const req=httpsRequest(new URL(path,options.url),{method:'POST',ca:options.ca,rejectUnauthorized:true,agent,headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{
   if(res.statusCode!==200){res.resume();finish(new Fault(res.statusCode===410?'HANDLE_EXPIRED':res.statusCode===409?'CONNECTOR_FENCED':'NETWORK_UNAVAILABLE'));return;}
   let size=0;const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_BODY)finish(new Fault('NETWORK_BODY_LIMIT'));else chunks.push(chunk);});res.on('error',()=>finish(new Fault('NETWORK_UNAVAILABLE')));res.on('end',()=>{try{finish(undefined,schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));}catch{finish(new Fault('NETWORK_INVALID_RESPONSE'));}});
  });const timer=setTimeout(()=>finish(new Fault('NETWORK_TIMEOUT')),5000);req.on('error',()=>finish(new Fault('NETWORK_UNAVAILABLE')));req.end(data);
 });
}
/** One trusted network reconciliation channel per local coordinator runtime. Stale locks require operator recovery. */
async function acquireRuntimeLock(credentialFile:string){
 const runtime=dirname(resolve(credentialFile));let info;
 try{info=await lstat(runtime);}catch{throw new Fault('PRIVATE_CLIENT_A_REQUIRED');}
 if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o700)throw new Fault('PRIVATE_CLIENT_A_REQUIRED');
 const path=join(runtime,'network-connector.lock');let file;
 try{file=await open(path,'wx',0o600);}catch(error){throw new Fault((error as NodeJS.ErrnoException).code==='EEXIST'?'CONNECTOR_ALREADY_RUNNING':'CONNECTOR_LOCK_FAILED');}
 const owned=await file.stat();let released=false;
 const release=async()=>{if(released)return;released=true;try{const current=await lstat(path).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});if(current&&current.dev===owned.dev&&current.ino===owned.ino)await unlink(path);}finally{await file.close();}};
 try{await file.writeFile(JSON.stringify({pid:process.pid})+'\n');}catch(error){await release();throw error;}
 return release;
}
export async function startManualConnector(options:ManualConnectorOptions):Promise<{stop():Promise<void>;done:Promise<void>;failureCode():string|undefined;registrationId():string|undefined}>{
 const binding=bindingSchema.parse({device_id:options.deviceId,agent_id:options.agentId});
 if(!z.string().min(1).max(96).refine(v=>!/[\p{Cc}\p{Cf}]/u.test(v)).safeParse(options.name).success)throw new Fault('INVALID_NAME');
 const url=new URL(options.url);if(url.protocol!=='https:'||url.origin!==options.url||url.username||url.password)throw new Fault('HTTPS_ORIGIN_REQUIRED');
 if(!isAbsolute(options.credentialFile)||basename(options.credentialFile)!=='client-a.json'||!isAbsolute(options.journalDir))throw new Fault('PRIVATE_CLIENT_A_REQUIRED');
 const pollMs=options.pollMs??250;if(!Number.isInteger(pollMs)||pollMs<25||pollMs>1000)throw new Fault('INVALID_NETWORK_LIMIT');
 const releaseRuntimeLock=await acquireRuntimeLock(options.credentialFile);let journal:ConnectorJournal;
 try{journal=new ConnectorJournal(join(options.journalDir,'manual'),{url:url.origin,...binding,credentialFile:resolve(options.credentialFile)});}catch(error){await releaseRuntimeLock();throw error;}
 const agent=new Agent({keepAlive:true,agentKeepAliveTimeoutBuffer:100});
 const inflight=new Set<Promise<void>>(),ackedRevocations=new Set<string>(),invalidated=new Set<string>();let owners:string[]=[],handle:string|undefined,localInstance:string|undefined,failure:string|undefined,stopping=false,wake:(()=>void)|undefined,stopPromise:Promise<void>|undefined;
 const sleep=(ms:number)=>new Promise<void>(done=>{const timer=setTimeout(()=>{wake=undefined;done();},ms);wake=()=>{clearTimeout(timer);wake=undefined;done();};});
 async function health(){try{const credential=await readCredential(options.credentialFile);return healthSchema.parse(await ipcCall(credential,'service.local_health',{}));}catch{return null;}}
 async function reconcile(next:string[]){const credential=await readCredential(options.credentialFile);await ipcCall(credential,'service.network_reconcile',{owners:next});owners=next;}
 async function execute(job:Delivery){let outcome:Outcome={kind:'unknown'};
  try{
   if(stopping||!job.network_owner||!owners.includes(job.network_owner)||(job.expires_at!==null&&Date.now()>=job.expires_at))throw new Fault('STALE_DELIVERY');
   const credential=await readCredential(options.credentialFile),preflight=healthSchema.parse(await ipcCall(credential,'service.local_health',{}));
   if(!preflight.ready||preflight.instance_id!==job.local_instance_id||(job.expires_at!==null&&Date.now()>=job.expires_at)||stopping||!owners.includes(job.network_owner))throw new Fault('STALE_DELIVERY');
   try{const result=await ipcCall(credential,'service.network_dispatch',{owner:job.network_owner,method:job.method,params:job.params});outcome={kind:'reply',reply:replySchema.parse({ok:true,result})};}
   catch(error){const code=safeCode(error);if(code==='OWNER_REVOKED')invalidated.add(job.network_owner);outcome=!(error instanceof Fault)||ambiguous.has(code)?{kind:'unknown'}:{kind:'reply',reply:{ok:false,error:{code}}};}
   if(Buffer.byteLength(canonicalJson(outcome))>MAX_BODY)outcome={kind:'unknown'};
  }catch{/* A stale or uncertain job never receives a new dispatch key. */}
  journal.finish(job.request_id,outcome);
 }
 async function exchange(capacity:number){
  const current=await health();
  if(current?.ready&&localInstance!==current.instance_id){await reconcile([]);localInstance=current.instance_id;}
  if(!handle){const registered=await post(options,'/connector/register',{name:options.name,...binding},z.strictObject({handle:z.uuid(),enabled:z.literal(false)}),agent);handle=registered.handle;}
  const pending=journal.pending(),sentRevoked=[...ackedRevocations],sentInvalidated=[...invalidated];
  const response=await post(options,'/connector/sync',{handle,sync:{connector_id:handle,ready:current?.ready??false,local_instance_id:current?.instance_id??null,capacity,results:pending?[pending]:[]},revoked:sentRevoked,invalidated:sentInvalidated},manualSyncReplySchema,agent);
  for(const owner of sentRevoked)ackedRevocations.delete(owner);for(const owner of sentInvalidated)invalidated.delete(owner);
  for(const ack of response.acks){if(!pending||ack.request_id!==pending.request_id||ack.delivery_nonce!==pending.delivery_nonce)throw new Fault('NETWORK_INVALID_RESPONSE');journal.ack(ack.request_id,ack.delivery_nonce);}
  if(!response.enabled&&response.owners.length)throw new Fault('NETWORK_INVALID_RESPONSE');
  const desired=stopping?[]:response.owners.filter(owner=>!response.revocations.includes(owner));
  if(current?.ready){
   try{await reconcile(desired);for(const owner of response.revocations)ackedRevocations.add(owner);}
   catch(error){if(safeCode(error)==='OWNER_REVOKED'){for(const owner of desired)invalidated.add(owner);await reconcile([]);for(const owner of response.revocations)ackedRevocations.add(owner);}else throw error;}
  }else{owners=[];localInstance=undefined;}
  if(response.job){
   const job=response.job;if(job.device_id!==binding.device_id||job.agent_id!==binding.agent_id||!job.network_owner||capacity===0)throw new Fault('NETWORK_INVALID_RESPONSE');
   const normalized=normalizeRequest(job.method,{request_id:job.request_id,params:job.params});if(canonicalJson(normalized.params)!==canonicalJson(job.params))throw new Fault('NETWORK_INVALID_RESPONSE');
   if(journal.claim(job)){const task=execute(job);inflight.add(task);void task.finally(()=>inflight.delete(task)).catch(()=>{failure='JOURNAL_WRITE_FAILED';stopping=true;wake?.();});}
  }
 }
 const loop=(async()=>{let backoff=pollMs;while(!stopping){try{await exchange(1);backoff=pollMs;}catch(error){const code=safeCode(error);if(code==='HANDLE_EXPIRED'){for(const owner of owners)invalidated.add(owner);await reconcile([]).catch(()=>{});handle=undefined;}else if(['CONNECTOR_FENCED','NETWORK_BODY_LIMIT','NETWORK_INVALID_RESPONSE','JOURNAL_CONFLICT','DELIVERY_CONFLICT','STORAGE_CLOSED'].includes(code)){failure=code;stopping=true;break;}backoff=Math.min(backoff*2,1000);}if(!stopping)await sleep(backoff);}})();
 const stop=()=>stopPromise??=(async()=>{stopping=true;wake?.();for(const owner of owners)invalidated.add(owner);await reconcile([]).catch(()=>{});await loop;await reconcile([]).catch(()=>{});await Promise.allSettled([...inflight]);try{while(journal.pending()||invalidated.size||ackedRevocations.size){const before=canonicalJson({pending:journal.pending()??null,invalidated:[...invalidated],revoked:[...ackedRevocations]});await exchange(0);if(before===canonicalJson({pending:journal.pending()??null,invalidated:[...invalidated],revoked:[...ackedRevocations]}))break;}}catch{/* Preserve exact journal receipts for next approved process. */}finally{agent.destroy();try{journal.close();}finally{await releaseRuntimeLock();}}})();
 const done=loop.then(()=>stop());return {stop,done,failureCode:()=>failure,registrationId:()=>handle};
}
