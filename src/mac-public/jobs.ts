import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {Audit} from '../network/store.js';
import {canonicalDigest} from '../remote/protocol.js';
import {Fault} from '../core/errors.js';
export const jobSchema=z.object({request_id:z.string(),owner:z.string(),external:z.string(),method:z.enum(['jev.host_tools','jev.host_act']),params:z.record(z.string(),z.unknown()),token:z.string(),digest:z.string(),delivery_status:z.enum(['QUEUED','DISPATCHED','RUNNING','COMPLETED','REJECTED','UNKNOWN']),reply:z.unknown().optional()});
export type Job=z.infer<typeof jobSchema>;
export function jobId(owner:string,request:string){return createHash('sha256').update(owner+'\0'+request).digest('hex');}
export class JobStore{
 private audit:Audit<Job>;
 constructor(directory:string){this.audit=new Audit(directory,{kind:'public-mac-jobs-v1'},jobSchema);for(const job of this.audit.all())if(['QUEUED','DISPATCHED','RUNNING'].includes(job.delivery_status))this.put({...job,delivery_status:'UNKNOWN'});}
 get(id:string){return this.audit.get(id);}
 all(){return this.audit.all();}
 put(job:Job){this.audit.put(job.request_id,job);}
 claim(owner:string,external:string,method:Job['method'],params:Record<string,unknown>,token:string){const id=jobId(owner,external),digest=canonicalDigest({method,params}),prior=this.get(id);if(prior){if(prior.digest!==digest)throw new Fault('IDEMPOTENCY_CONFLICT');return {fresh:false,job:prior};}const job:Job={request_id:id,owner,external,method,params,token,digest,delivery_status:'QUEUED'};this.put(job);return {fresh:true,job};}
 accept(job:Job){const local=this.get(job.request_id);if(!local||local.owner!==job.owner||local.digest!==job.digest)throw new Fault('RECEIPT_CONFLICT');if(local.delivery_status==='COMPLETED'){if(job.delivery_status!=='COMPLETED'||canonicalDigest(local.reply)!==canonicalDigest(job.reply))throw new Fault('RECEIPT_CONFLICT');return;}if(local.delivery_status==='UNKNOWN'&&['QUEUED','DISPATCHED','RUNNING'].includes(job.delivery_status))return;this.put({...local,delivery_status:job.delivery_status,...(job.reply===undefined?{}:{reply:job.reply})});}
 close(){this.audit.close();}
}
export function envelope(job:Job){return {request_id:job.external,delivery_status:job.delivery_status==='RUNNING'?'DISPATCHED':job.delivery_status,...(job.reply===undefined?{}:{reply:job.reply})};}
/** Native images are lifted only from this additive executor; legacy responses never pass here. */
export function liftImages(value:unknown):CallToolResult{
 const images:CallToolResult['content']=[];
 function copy(item:unknown):unknown{if(Array.isArray(item))return item.map(copy).filter(part=>part!==undefined);if(item&&typeof item==='object'){const obj=item as Record<string,unknown>;if(obj.type==='image'&&typeof obj.data==='string'&&typeof obj.mimeType==='string'){images.push({type:'image',data:obj.data,mimeType:obj.mimeType});return undefined;}return Object.fromEntries(Object.entries(obj).map(([key,part])=>[key,copy(part)]).filter(([,part])=>part!==undefined));}return item;}
 const stripped=copy(value);return {content:[{type:'text',text:JSON.stringify(stripped)},...images]};
}
