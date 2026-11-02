import {Fault} from '../core/errors.js';
import {hostSchemas} from '../host/contracts.js';
import {idSchema} from '../core/contracts.js';
import {JobStore,jobId,envelope,type Job} from './jobs.js';
export interface OwnerContext{owner:string;token:string;local_instance_id?:string}
export interface MacClient{submit(job:Job):Promise<Job>;get(id:string):Promise<Job>}
export interface FrontOptions{store:JobStore;authorize:(context:Record<string,unknown>)=>Promise<OwnerContext>;legacyStatus:(context:Record<string,unknown>,request:string)=>Promise<unknown>;mac:MacClient}
/** The submission gate also surrounds legacy acknowledgements in the HTTP front. */
export class FrontBridge{
 private tail:Promise<void>=Promise.resolve();
 constructor(private options:FrontOptions){}
 async serial<T>(work:()=>Promise<T>):Promise<T>{const previous=this.tail;let release!:()=>void;this.tail=new Promise(resolve=>{release=resolve;});await previous;try{return await work();}finally{release();}}
 async submit(context:Record<string,unknown>,external:string,method:Job['method'],input:Record<string,unknown>){return this.serial(async()=>{
  idSchema.parse(external);const {owner,token}=await this.options.authorize(context),params={...input,host:'mac'};(method==='jev.host_tools'?hostSchemas.host_tools:hostSchemas.host_act).parse(params);
  const existing=this.options.store.get(jobId(owner,external));if(!existing&&await this.options.legacyStatus(context,external)!==undefined)throw new Fault('IDEMPOTENCY_CONFLICT');
  const claim=this.options.store.claim(owner,external,method,params,token);if(claim.fresh){const dispatched={...claim.job,delivery_status:'DISPATCHED' as const};this.options.store.put(dispatched);void this.options.mac.submit(dispatched).then(job=>this.options.store.accept(job),()=>{const current=this.options.store.get(dispatched.request_id);if(current&&current.delivery_status!=='COMPLETED')this.options.store.put({...current,delivery_status:'UNKNOWN'});/* Once dispatched, only GET is allowed. */}).catch(()=>{});return envelope(dispatched);}return envelope(claim.job);
 });}
 async known(context:Record<string,unknown>,external:string){const {owner}=await this.options.authorize(context);return this.options.store.get(jobId(owner,external));}
 async status(context:Record<string,unknown>,external:string){const job=await this.known(context,external);if(!job)return undefined;if(job.delivery_status!=='COMPLETED'&&job.delivery_status!=='REJECTED')try{this.options.store.accept(await this.options.mac.get(job.request_id));}catch{/* Missing or lost status never authorizes a replay. */}return envelope(this.options.store.get(job.request_id)!);}
}
