import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,openSync,closeSync,writeFileSync,unlinkSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {Fault} from '../core/errors.js';
import {idSchema} from '../core/contracts.js';
import {bindingSchema,canonicalDigest,canonicalJson,deliverySchema,methodSchema,nonceSchema,normalizeRequest,outcomeSchema,statuses,syncSchema,type Delivery,type Envelope,type Outcome,type Receipt,type Sync} from './protocol.js';
const TABLES=['CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)','CREATE TABLE records(id TEXT PRIMARY KEY, data TEXT NOT NULL)'];
const CAP=10000;
/** Private, single-process SQLite audit. Stale locks require explicit operator recovery. */
class Audit<T> {
 private db!:DatabaseSync;private lock:number;private closed=false;private readonly lockPath:string;
 constructor(directory:string,profile:unknown,private schema:z.ZodType<T>){
  const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});privatePath(root,true);this.lockPath=join(root,'owner.lock');
  try{this.lock=openSync(this.lockPath,'wx',0o600);writeFileSync(this.lock,JSON.stringify({pid:process.pid})+'\n');}catch{throw new Fault('STORAGE_OWNED');}
  try{
   const path=join(root,'network.sqlite');let existed=false;
   try{privatePath(path);existed=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   for(const suffix of ['-wal','-shm'])try{privatePath(path+suffix);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   this.db=new DatabaseSync(path);chmodSync(path,0o600);
   this.db.exec('PRAGMA trusted_schema=OFF;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=1000;');
   if(existed){
    if(this.db.prepare('PRAGMA user_version').get()?.user_version!==1)throw new Error();
    const sql=this.db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.sql);
    if(canonicalJson(sql)!==canonicalJson(TABLES))throw new Error();
    const meta=this.db.prepare('SELECT * FROM metadata').all();if(meta.length!==1||meta[0]!.key!=='profile'||meta[0]!.value!==canonicalJson(profile))throw new Error();
   }else this.db.exec('BEGIN IMMEDIATE;'+TABLES.join(';')+';PRAGMA user_version=1;COMMIT;');
   if(!existed)this.db.prepare('INSERT INTO metadata VALUES(?,?)').run('profile',canonicalJson(profile));
   if(this.db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error();
   const rows=this.db.prepare('SELECT * FROM records').all();if(rows.length>CAP)throw new Error();
   for(const row of rows){idSchema.parse(row.id);const data=this.schema.parse(JSON.parse(String(row.data)));if((data as {request_id:string}).request_id!==row.id||Buffer.byteLength(String(row.data))>64000)throw new Error();}
  }catch{this.db?.close();closeSync(this.lock);unlinkSync(this.lockPath);throw new Fault('STORAGE_CORRUPT');}
 }
 all():T[]{this.assertOpen();return this.db.prepare('SELECT data FROM records ORDER BY rowid').all().map(row=>this.schema.parse(JSON.parse(String(row.data))));}
 get(id:string):T|undefined{this.assertOpen();const row=this.db.prepare('SELECT data FROM records WHERE id=?').get(idSchema.parse(id));return row?this.schema.parse(JSON.parse(String(row.data))):undefined;}
 put(id:string,value:T){this.assertOpen();const data=canonicalJson(this.schema.parse(value));if(Buffer.byteLength(data)>64000)throw new Fault('RECORD_TOO_LARGE');
  if(!this.get(id)&&Number(this.db.prepare('SELECT count(*) AS n FROM records').get()!.n)>=CAP)throw new Fault('STORAGE_CAPACITY');
  this.db.prepare('INSERT INTO records VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,data);
 }
 private assertOpen(){if(this.closed)throw new Fault('STORAGE_CLOSED');}
 close(){if(this.closed)return;this.closed=true;this.db.close();closeSync(this.lock);unlinkSync(this.lockPath);}
}
function privatePath(path:string,directory=false){const s=lstatSync(path);if(s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o777)!==(directory?0o700:0o600)||!(directory?s.isDirectory():s.isFile())||(!directory&&s.nlink!==1))throw new Fault('PRIVATE_STORAGE_REQUIRED');}
const rowSchema=z.strictObject({request_id:idSchema,method:methodSchema,params:z.json(),digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),delivery_status:z.enum(statuses),created_at:z.number().int().positive(),expires_at:z.number().int().positive(),local_instance_id:z.uuid().nullable(),delivery_nonce:nonceSchema.nullable(),result_deadline:z.number().int().positive().nullable(),outcome:outcomeSchema.nullable()}).superRefine((r,ctx)=>{
 try{
  const norm=normalizeRequest(r.method,{request_id:r.request_id,params:r.params});
  if(canonicalJson(norm.params)!==canonicalJson(r.params)||canonicalDigest({method:r.method,params:r.params})!==r.digest||r.expires_at<r.created_at)throw new Error();
  const sent=['DISPATCHED','COMPLETED','UNKNOWN'].includes(r.delivery_status);
  if(sent!==(r.delivery_nonce!==null)||sent!==(r.result_deadline!==null)||((sent||r.delivery_status==='QUEUED')&&r.local_instance_id===null))throw new Error();
  if((r.delivery_status==='COMPLETED')!==(r.outcome?.kind==='reply')||(r.outcome?.kind==='unknown'&&r.delivery_status!=='UNKNOWN'))throw new Error();
 }catch{ctx.addIssue({code:'custom',message:'Invalid durable request'});}
});
type Row=z.infer<typeof rowSchema>;
export interface RelayStoreOptions {directory:string;deviceId:string;agentId:string;leaseMs?:number;queueTtlMs?:number;responseTtlMs?:number;}
export class RelayStore {
 private audit:Audit<Row>;private lease?:{id:string;seen:number;ready:boolean;instance:string|null};
 readonly binding;readonly leaseMs:number;readonly queueTtlMs:number;readonly responseTtlMs:number;
 constructor(options:RelayStoreOptions){
  this.binding=bindingSchema.parse({device_id:options.deviceId,agent_id:options.agentId});this.leaseMs=options.leaseMs??3000;this.queueTtlMs=options.queueTtlMs??5000;this.responseTtlMs=options.responseTtlMs??70000;
  if(!Number.isInteger(this.leaseMs)||this.leaseMs<100||this.leaseMs>30000||!Number.isInteger(this.queueTtlMs)||this.queueTtlMs<100||this.queueTtlMs>10000)throw new Fault('INVALID_NETWORK_LIMIT');
  if(!Number.isInteger(this.responseTtlMs)||this.responseTtlMs<100||this.responseTtlMs>120000)throw new Fault('INVALID_NETWORK_LIMIT');
  this.audit=new Audit(options.directory,{kind:'relay-v1',...this.binding},rowSchema);
  for(const row of this.audit.all())if(row.delivery_status==='QUEUED')this.audit.put(row.request_id,{...row,delivery_status:'REJECTED'});else if(row.delivery_status==='DISPATCHED')this.audit.put(row.request_id,{...row,delivery_status:'UNKNOWN'});
 }
 private refresh(){const now=Date.now();for(const row of this.audit.all()){
  if(row.delivery_status==='QUEUED'&&(row.expires_at<=now||!this.online()||!this.lease!.ready||row.local_instance_id!==this.lease!.instance))this.audit.put(row.request_id,{...row,delivery_status:'REJECTED'});
  if(row.delivery_status==='DISPATCHED'&&(!this.online()||row.local_instance_id!==this.lease!.instance||row.result_deadline!<=now))this.audit.put(row.request_id,{...row,delivery_status:'UNKNOWN'});
 }}
 private online(){return !!this.lease&&Date.now()-this.lease.seen<this.leaseMs;}
 status(){this.refresh();return {connector_online:this.online(),local_ready:this.online()&&this.lease!.ready,local_instance_id:this.online()?this.lease!.instance:null};}
 submit(method:string,value:unknown):Envelope{
  const request=normalizeRequest(method,value),digest=canonicalDigest({method,params:request.params});this.refresh();const prior=this.audit.get(request.request_id);
  if(prior){if(prior.digest!==digest)throw new Fault('IDEMPOTENCY_CONFLICT');return envelope(prior);}
  if(this.audit.all().filter(r=>r.delivery_status==='QUEUED').length>=32)throw new Fault('QUEUE_CAPACITY');
  const ready=this.online()&&this.lease!.ready,now=Date.now();
  const row=rowSchema.parse({...request,method,digest,delivery_status:ready?'QUEUED':'REJECTED',created_at:now,expires_at:now+this.queueTtlMs,local_instance_id:ready?this.lease!.instance:null,delivery_nonce:null,result_deadline:null,outcome:null});this.audit.put(row.request_id,row);return envelope(row);
 }
 get(id:string):Envelope{this.refresh();const row=this.audit.get(id);if(!row)throw new Fault('REQUEST_NOT_FOUND');return envelope(row);}
 sync(value:Sync){
  const input=syncSchema.parse(value),now=Date.now();
  if(this.online()&&this.lease!.id!==input.connector_id)throw new Fault('CONNECTOR_FENCED');
  // Expire the previous lease before a new heartbeat can make old work look live.
  this.refresh();this.lease={id:input.connector_id,seen:now,ready:input.ready,instance:input.local_instance_id};this.refresh();
  const acks: {request_id:string;delivery_nonce:string}[]=[];
  for(const result of input.results){this.complete(result);acks.push({request_id:result.request_id,delivery_nonce:result.delivery_nonce});}
  let job:Delivery|null=null;
  if(input.ready&&input.capacity>0){const row=this.audit.all().find(r=>r.delivery_status==='QUEUED');if(row){
   const delivery_nonce=randomBytes(32).toString('hex');this.audit.put(row.request_id,{...row,delivery_status:'DISPATCHED',delivery_nonce,result_deadline:Date.now()+this.responseTtlMs});
   job=deliverySchema.parse({...this.binding,request_id:row.request_id,method:row.method,params:row.params,delivery_nonce,expires_at:row.expires_at,local_instance_id:row.local_instance_id});
  }}
  return {acks,job};
 }
 private complete(receipt:Receipt){
  const row=this.audit.get(receipt.request_id);if(!row||row.delivery_nonce!==receipt.delivery_nonce||!['DISPATCHED','UNKNOWN','COMPLETED'].includes(row.delivery_status))throw new Fault('RECEIPT_CONFLICT');
  if(row.outcome&&canonicalJson(row.outcome)!==canonicalJson(receipt.outcome)){
   if(!(row.outcome.kind==='unknown'&&receipt.outcome.kind==='reply'))throw new Fault('RECEIPT_CONFLICT');
  }
  this.audit.put(row.request_id,{...row,outcome:receipt.outcome,delivery_status:receipt.outcome.kind==='reply'?'COMPLETED':'UNKNOWN'});
 }
 close(){this.audit.close();}
}
function envelope(row:Row):Envelope{return {request_id:row.request_id,delivery_status:row.delivery_status,...(row.outcome?.kind==='reply'?{reply:row.outcome.reply}:{})};}
const journalRowSchema=z.strictObject({request_id:idSchema,delivery:deliverySchema,outcome:outcomeSchema.nullable(),acked:z.boolean()}).superRefine((r,ctx)=>{
 try{const norm=normalizeRequest(r.delivery.method,{request_id:r.request_id,params:r.delivery.params});if(r.request_id!==r.delivery.request_id||(r.acked&&r.outcome===null)||canonicalJson(norm.params)!==canonicalJson(r.delivery.params))throw new Error();}
 catch{ctx.addIssue({code:'custom',message:'Invalid durable connector claim'});}
});
type JournalRow=z.infer<typeof journalRowSchema>;
export class ConnectorJournal {
 private audit:Audit<JournalRow>;
 constructor(directory:string,profile:unknown){
  const binding=z.object({device_id:idSchema,agent_id:idSchema}).parse(profile);
  const boundSchema=journalRowSchema.refine(row=>row.delivery.device_id===binding.device_id&&row.delivery.agent_id===binding.agent_id);
  this.audit=new Audit(directory,{kind:'connector-v1',profile},boundSchema);for(const row of this.audit.all())if(row.outcome===null)this.audit.put(row.request_id,{...row,outcome:{kind:'unknown'}});}
 claim(job:Delivery):boolean{const parsed=deliverySchema.parse(job);const prior=this.audit.get(parsed.request_id);if(prior){if(canonicalJson(prior.delivery)!==canonicalJson(parsed))throw new Fault('DELIVERY_CONFLICT');return false;}this.audit.put(parsed.request_id,{request_id:parsed.request_id,delivery:parsed,outcome:null,acked:false});return true;}
 finish(id:string,outcome:Outcome){const row=this.audit.get(id);if(!row||row.outcome!==null)throw new Fault('JOURNAL_CONFLICT');this.audit.put(id,{...row,outcome:outcomeSchema.parse(outcome)});}
 pending():Receipt|undefined{const row=this.audit.all().find(r=>!r.acked&&r.outcome!==null);return row?{request_id:row.request_id,delivery_nonce:row.delivery.delivery_nonce,outcome:row.outcome!}:undefined;}
 ack(id:string,nonce:string){const row=this.audit.get(id);if(!row||row.delivery.delivery_nonce!==nonce||!row.outcome)throw new Fault('JOURNAL_CONFLICT');this.audit.put(id,{...row,acked:true});}
 close(){this.audit.close();}
}
