import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {Fault} from '../core/errors.js';
import {Audit} from './store.js';
const nameSchema=z.string().min(1).max(96).refine(v=>!/[\p{Cc}\p{Cf}]/u.test(v));
const rowSchema=z.strictObject({request_id:z.uuid(),id:z.uuid(),type:z.enum(['ai','device']),name:nameSchema,firstSeen:z.number(),lastSeen:z.number(),generation:z.number().int().nonnegative(),enabled:z.boolean(),desiredEnabled:z.boolean().optional(),owner:z.string().nullable(),revocations:z.array(z.string()),state:z.enum(['pending','enabled','stopping','offline']),localInstance:z.uuid().nullable().default(null),grantDevice:z.uuid().nullable().default(null),grantInstance:z.uuid().nullable().default(null)}).transform(row=>({...row,desiredEnabled:row.desiredEnabled??(row.type==='device'&&row.enabled)}));
export type AdmissionRecord=z.infer<typeof rowSchema>;
/** Names are labels. Only random connection instances in this runtime can be admitted. */
export class AdmissionRegistry {
 private audit:Audit<AdmissionRecord>;private live=new Set<string>();private runtime=randomUUID();private closed=false;
 constructor(directory:string,readonly sessionTtlMs:number|null=null,readonly deviceTtlMs=3000){
  if((sessionTtlMs!==null&&(!Number.isSafeInteger(sessionTtlMs)||sessionTtlMs<100))||!Number.isInteger(deviceTtlMs)||deviceTtlMs<100||deviceTtlMs>30000)throw new Fault('INVALID_NETWORK_LIMIT');
  this.audit=new Audit(directory,{kind:'manual-admission-v1'},rowSchema);
  for(const row of this.audit.all())this.audit.put(row.id,{...row,enabled:false,owner:null,state:'offline',revocations:[...row.revocations,...(row.owner?[row.owner]:[])]});
 }
 register(type:'ai'|'device',name:string){
  if(!nameSchema.safeParse(name).success)throw new Fault('INVALID_NAME');
  const id=randomUUID(),now=Date.now();const row:AdmissionRecord={request_id:id,id,type,name,firstSeen:now,lastSeen:now,generation:0,enabled:false,desiredEnabled:false,owner:null,revocations:[],state:'pending',localInstance:null,grantDevice:null,grantInstance:null};
  this.audit.put(id,row);this.live.add(id);return row;
 }
 /** Possession of the private device handle can restore its registration after relay restart.
  * It preserves manual off and generation; it never resurrects any AI owner. */
 resumeRegistration(id:string){const row=this.audit.get(id);if(!row||row.type!=='device')throw new Fault('DEVICE_RESUME_INVALID');if(this.live.has(id))return this.get(id);this.audit.put(id,{...row,enabled:false,owner:null,state:'pending',lastSeen:Date.now(),localInstance:null});this.live.add(id);return this.get(id);}
 private expire(){for(const row of this.audit.all())if(this.live.has(row.id)&&(row.type!=='ai'||this.sessionTtlMs!==null)&&Date.now()-row.lastSeen>=(row.type==='ai'?this.sessionTtlMs!:this.deviceTtlMs)){
  if(row.type==='ai')this.disconnect(row.id);
  else if(row.state!=='offline'){this.disable(row);this.audit.put(row.id,{...this.audit.get(row.id)!,state:'offline'});for(const ai of this.audit.all())if(ai.type==='ai'&&ai.enabled&&ai.grantDevice===row.id)this.disable(ai);}
 }}
 isLive(id:string){this.expire();return this.live.has(id);}
 get(id:string){this.expire();const row=this.audit.get(id);if(!row)throw new Fault('CONNECTION_NOT_FOUND');return this.display(row);}
 private display(row:AdmissionRecord){
  if(row.type!=='device'||row.enabled)return row;
  if(this.audit.all().some(r=>r.type==='ai'&&r.grantDevice===row.id&&r.revocations.length))return {...row,state:'stopping' as const};
  return row.state==='stopping'?{...row,state:this.live.has(row.id)?'pending' as const:'offline' as const}:row;
 }
 list(){this.expire();return this.audit.all().map(row=>this.display(row));}
 updateDeviceInstance(id:string,instance:string|null){this.get(id);const row=this.audit.get(id)!;if(row.type!=='device')throw new Fault('INVALID_REQUEST');if(row.localInstance&&row.localInstance!==instance)for(const ai of this.audit.all())if(ai.type==='ai'&&ai.enabled&&ai.grantDevice===id)this.disable(ai);this.audit.put(id,{...row,localInstance:instance});}
 touch(id:string){if(!this.isLive(id))throw new Fault('HANDLE_EXPIRED');const row=this.audit.get(id)!;this.audit.put(id,{...row,lastSeen:Date.now(),state:row.state==='offline'?'pending':row.state});return this.get(id);}
 setEnabled(id:string,enabled:boolean){
  const row=this.get(id);if(!this.live.has(id))throw new Fault('CONNECTION_OFFLINE');
  if(!enabled){
   // Manual off changes durable intent even if heartbeat expiry already removed the active grant.
   const disabled=row.type==='device'?{...row,desiredEnabled:false}:row;
   if(row.type==='device')this.audit.put(id,disabled);
   if(row.enabled)this.disable(disabled);
   if(row.type==='device')for(const ai of this.audit.all())if(ai.type==='ai'&&ai.enabled&&ai.grantDevice===id)this.disable(ai);
   return this.get(id);
  }
  if(row.enabled){if(row.type==='device'&&!row.desiredEnabled)this.audit.put(id,{...row,desiredEnabled:true});return this.get(id);}
  if(row.revocations.length||row.state==='stopping')throw new Fault('REVOCATION_PENDING');
  const active=this.audit.all().find(r=>r.type==='device'&&r.enabled&&this.live.has(r.id));
  if(row.type==='device'&&active)throw new Fault('DEVICE_ALREADY_ENABLED');
  if(row.type==='ai'&&!active)throw new Fault('DEVICE_NOT_ENABLED');
  if(row.type==='ai'&&!active!.localInstance)throw new Fault('DEVICE_NOT_READY');
  const generation=row.generation+1,owner=row.type==='ai'?'network-'+createHash('sha256').update(`${this.runtime}:${id}:${generation}:${active!.id}`).digest('hex'):null;
  this.audit.put(id,{...row,generation,enabled:true,desiredEnabled:row.type==='device'?true:row.desiredEnabled,owner,state:'enabled',grantDevice:row.type==='ai'?active!.id:null,grantInstance:row.type==='ai'?active!.localInstance:null});return this.get(id);
 }
 /** Restore only the operator's desired device after a fresh same-registration ready heartbeat.
  * This never re-enables an AI owner, moves another selected device, or skips revocation drain. */
 resumeDevice(id:string,ready:boolean){
  const row=this.get(id);if(row.type!=='device')throw new Fault('INVALID_REQUEST');
  if(row.enabled||!row.desiredEnabled||!ready||!row.localInstance||!this.live.has(id)||row.state==='stopping'||row.revocations.length)return row;
  if(this.audit.all().some(other=>other.type==='device'&&other.enabled&&this.live.has(other.id)))return row;
  return this.setEnabled(id,true);
 }
 private disable(row:AdmissionRecord){this.audit.put(row.id,{...row,enabled:false,owner:null,revocations:[...row.revocations,...(row.owner?[row.owner]:[])],state:row.owner||row.revocations.length?'stopping':'pending'});}
 disconnect(id:string){const row=this.audit.get(id);if(!row||!this.live.has(id))return;this.live.delete(id);this.disable(row);const updated=this.audit.get(id)!;this.audit.put(id,{...updated,state:updated.revocations.length?'stopping':'offline'});if(row.type==='device')for(const ai of this.audit.all())if(ai.type==='ai'&&ai.enabled)this.disable(ai);}
 owners(deviceId:string){const device=this.get(deviceId);return device.type==='device'&&device.enabled&&this.isLive(deviceId)?this.list().filter(r=>r.type==='ai'&&r.enabled&&this.live.has(r.id)).map(r=>r.owner!):[];}
 revocations(){return [...new Set(this.list().flatMap(r=>r.revocations))];}
 revocationsFor(deviceId:string,instance:string|null){return [...new Set(this.list().filter(r=>r.type==='ai'&&(r.grantDevice===deviceId||(this.audit.get(deviceId)?.enabled&&instance!==null&&r.grantInstance===instance))).flatMap(r=>r.revocations))];}
 ackRevocations(owners:readonly string[]){for(const row of this.audit.all()){const remaining=row.revocations.filter(owner=>!owners.includes(owner));if(remaining.length!==row.revocations.length)this.audit.put(row.id,{...row,revocations:remaining,state:remaining.length?'stopping':row.enabled?'enabled':this.live.has(row.id)?'pending':'offline'});}}
 close(){if(this.closed)return;this.closed=true;for(const id of [...this.live])this.disconnect(id);this.audit.close();}
}
