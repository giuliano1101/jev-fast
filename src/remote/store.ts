import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Fault} from '../core/errors.js';
import {idSchema} from '../core/contracts.js';
import {identitySchema,responseSchema,type AuthenticatedIdentity,type DecisionResponse,canonicalJson} from './protocol.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const approvalSchema=z.strictObject({approval_id:idSchema,expires_at:z.number().int().positive(),max_requests:z.number().int().min(1).max(1000),max_cost_usd:z.number().positive().max(10),reservation_usd:z.number().positive().max(1)});
export type GatewayApproval=z.infer<typeof approvalSchema>;
const enrollmentSchema=identitySchema.extend({certificate_sha256:hash,expires_at:z.number().int().positive()});
const storedDecisionSchema=z.strictObject({id:z.string().regex(/^[a-zA-Z0-9_-]{1,100}:[a-zA-Z0-9_-]{1,100}:[a-zA-Z0-9_-]{1,100}:[a-zA-Z0-9_-]{1,100}$/),digest:hash,status:z.enum(['pending','complete','unknown','rejected']),owner:z.uuid(),reservations:z.number().int().min(0).max(2),response:z.string().max(64000).nullable(),code:idSchema.nullable(),cost:z.number().finite().min(0).max(10)}).superRefine((row,ctx)=>{
 if((row.status==='complete')!==(row.response!==null)||(row.status==='pending'||row.status==='complete')!==(row.code===null)||(row.status!=='complete'&&row.cost!==0))ctx.addIssue({code:'custom',message:'Invalid persisted decision state'});
});
const MAX_RECORDS=100000;
const tableSql=[
 "CREATE TABLE budgets(id TEXT PRIMARY KEY, config TEXT NOT NULL, requests INTEGER NOT NULL CHECK(requests>=0), reserved INTEGER NOT NULL CHECK(reserved>=0))",
 "CREATE TABLE principals(id TEXT PRIMARY KEY, enrollment TEXT NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)))",
 "CREATE TABLE decisions(id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','complete','unknown','rejected')), owner TEXT NOT NULL, reservations INTEGER NOT NULL CHECK(reservations BETWEEN 0 AND 2), response TEXT, code TEXT, cost REAL NOT NULL DEFAULT 0)"
];
const units=(value:number)=>Math.ceil(value*1e9);
const identityKey=(identity:AuthenticatedIdentity)=>{const i=identitySchema.parse(identity);return `${i.owner_id}:${i.device_id}:${i.agent_id}`;};
const decisionKey=(identity:AuthenticatedIdentity,key:string)=>`${identityKey(identity)}:${idSchema.parse(key)}`;
/** Decision-only durable accounting. SQL transactions reserve before a hosted attempt.
 * Existing pending rows are never retried by another instance; no response gets re-signed.
 */
export class GatewayStore {
 private readonly db:DatabaseSync;private readonly instance=randomUUID();private closed=false;
 constructor(directory:string){
  const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});const info=lstatSync(root);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.uid!==process.getuid?.())throw new Fault('PRIVATE_STORAGE_REQUIRED');
  const path=join(root,'gateway.sqlite');let existed=false;try{const file=lstatSync(path);existed=true;if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||(file.mode&0o077)!==0||file.uid!==process.getuid?.())throw new Fault('PRIVATE_STORAGE_REQUIRED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  this.db=new DatabaseSync(path);chmodSync(path,0o600);
  try{
   this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
   const version=this.db.prepare('PRAGMA user_version').get()?.user_version;
   if(existed){
    if(version!==1)throw new Fault('GATEWAY_STORAGE_CORRUPT');
    const definitions=this.db.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>String(row.sql));
    const expected=[...tableSql].sort((a,b)=>a.split(' ')[2]!.localeCompare(b.split(' ')[2]!));
    if(canonicalJson(definitions)!==canonicalJson(expected))throw new Fault('GATEWAY_STORAGE_CORRUPT');
   }else{
    if(version!==0)throw new Fault('GATEWAY_STORAGE_CORRUPT');
    this.db.exec('BEGIN IMMEDIATE;'+tableSql.join(';')+';PRAGMA user_version=1;COMMIT;');
   }
   if(this.db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Fault('GATEWAY_STORAGE_CORRUPT');
   for(const row of this.db.prepare('SELECT * FROM budgets').all()){const a=approvalSchema.parse(JSON.parse(String(row.config)));if(row.id!==a.approval_id||typeof row.requests!=='number'||row.requests<0||row.requests>a.max_requests||typeof row.reserved!=='number'||row.reserved!==row.requests*units(a.reservation_usd)||row.reserved>units(a.max_cost_usd))throw new Fault('GATEWAY_STORAGE_CORRUPT');}
   for(const row of this.db.prepare('SELECT * FROM principals').all()){const e=enrollmentSchema.parse(JSON.parse(String(row.enrollment)));if(row.id!==identityKey({owner_id:e.owner_id,device_id:e.device_id,agent_id:e.agent_id})||![0,1].includes(Number(row.revoked)))throw new Fault('GATEWAY_STORAGE_CORRUPT');}
   const decisions=this.db.prepare('SELECT * FROM decisions').all();if(decisions.length>MAX_RECORDS)throw new Fault('GATEWAY_STORAGE_CORRUPT');
   for(const value of decisions){const row=storedDecisionSchema.parse(value);if(row.status==='complete')responseSchema.parse(JSON.parse(row.response!));}
  }catch{this.db.close();throw new Fault('GATEWAY_STORAGE_CORRUPT');}
 }
 private transaction<T>(fn:()=>T):T {if(this.closed)throw new Fault('STORAGE_CLOSED');this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){try{this.db.exec('ROLLBACK');}catch{/* SQLite connection is unusable after ambiguous transaction. */this.closed=true;this.db.close();}throw e;}}
 configureBudget(value:GatewayApproval){const approval=approvalSchema.parse(value);if(units(approval.reservation_usd)>units(approval.max_cost_usd))throw new Fault('INVALID_BUDGET');this.transaction(()=>{const old=this.db.prepare('SELECT config FROM budgets WHERE id=?').get(approval.approval_id);const config=canonicalJson(approval);if(old){if(old.config!==config)throw new Fault('BUDGET_CONFIGURATION_CONFLICT');}else this.db.prepare('INSERT INTO budgets VALUES(?,?,0,0)').run(approval.approval_id,config);});}
 budget(id:string){const row=this.db.prepare('SELECT * FROM budgets WHERE id=?').get(idSchema.parse(id));if(!row)throw new Fault('BUDGET_UNAVAILABLE');return {approval:approvalSchema.parse(JSON.parse(String(row.config))),requests:Number(row.requests),reserved_usd:Number(row.reserved)/1e9};}
 begin(identity:AuthenticatedIdentity,key:string,digest:string):{status:'started'|'unknown'|'complete'|'rejected';response?:DecisionResponse;code?:string}{const id=decisionKey(identity,key);hash.parse(digest);return this.transaction(()=>{
  const prior=this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id);
  if(prior){if(prior.digest!==digest)throw new Fault('IDEMPOTENCY_CONFLICT');if(prior.status==='complete')return {status:'complete',response:responseSchema.parse(JSON.parse(String(prior.response)))};if(prior.status==='rejected')return {status:'rejected',code:String(prior.code)};return {status:'unknown'};}
  if(Number(this.db.prepare('SELECT count(*) AS n FROM decisions').get()!.n)>=MAX_RECORDS)throw new Fault('STORAGE_CAPACITY');
  this.db.prepare("INSERT INTO decisions(id,digest,status,owner,reservations) VALUES(?,?,'pending',?,0)").run(id,digest,this.instance);return {status:'started'};
 });}
 reserve(identity:AuthenticatedIdentity,key:string,approvalId:string){return this.transaction(()=>{
  const id=decisionKey(identity,key),row=this.db.prepare('SELECT status,owner,reservations FROM decisions WHERE id=?').get(id);if(!row||row.status!=='pending'||row.owner!==this.instance)throw new Fault('DECISION_NOT_PENDING');
  const b=this.budget(approvalId);if(b.approval.expires_at<=Date.now())throw new Fault('LIVE_NOT_AUTHORIZED');if(b.requests>=b.approval.max_requests||units(b.reserved_usd)+units(b.approval.reservation_usd)>units(b.approval.max_cost_usd)||Number(row.reservations)>=2)throw new Fault('BUDGET_EXHAUSTED');
  this.db.prepare('UPDATE budgets SET requests=requests+1,reserved=reserved+? WHERE id=?').run(units(b.approval.reservation_usd),approvalId);this.db.prepare('UPDATE decisions SET reservations=reservations+1 WHERE id=?').run(id);return this.budget(approvalId);
 });}
 complete(identity:AuthenticatedIdentity,key:string,value:unknown,knownCost=0){const response=responseSchema.parse(value);if(!Number.isFinite(knownCost)||knownCost<0||knownCost>10)throw new Fault('INVALID_COST');const encoded=JSON.stringify(response);if(Buffer.byteLength(encoded)>64000)throw new Fault('RESPONSE_LIMIT');this.finish(identity,key,'complete',encoded,null,knownCost);}
 reject(identity:AuthenticatedIdentity,key:string,code:string){this.finish(identity,key,'rejected',null,idSchema.parse(code),0);}
 markUnknown(identity:AuthenticatedIdentity,key:string){this.finish(identity,key,'unknown',null,'PROVIDER_UNAVAILABLE',0);}
 private finish(identity:AuthenticatedIdentity,key:string,status:string,response:string|null,code:string|null,cost:number){this.transaction(()=>{const changed=this.db.prepare("UPDATE decisions SET status=?,response=?,code=?,cost=? WHERE id=? AND status='pending' AND owner=?").run(status,response,code,cost,decisionKey(identity,key),this.instance);if(changed.changes!==1)throw new Fault('DECISION_NOT_PENDING');});}
 enroll(value:z.infer<typeof enrollmentSchema>){const entry=enrollmentSchema.parse(value);if(entry.expires_at<=Date.now())throw new Fault('EXPIRED_ENROLLMENT');const identity=identitySchema.parse({owner_id:entry.owner_id,device_id:entry.device_id,agent_id:entry.agent_id});this.transaction(()=>{this.db.prepare('INSERT INTO principals VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET enrollment=excluded.enrollment,revoked=0').run(identityKey(identity),canonicalJson(entry));});}
 revoke(identity:AuthenticatedIdentity){this.transaction(()=>{if(this.db.prepare('UPDATE principals SET revoked=1 WHERE id=?').run(identityKey(identity)).changes!==1)throw new Fault('PRINCIPAL_NOT_FOUND');});}
 authorize(identity:AuthenticatedIdentity,certificateHash:string):AuthenticatedIdentity {hash.parse(certificateHash);const row=this.db.prepare('SELECT enrollment,revoked FROM principals WHERE id=?').get(identityKey(identity));if(!row||row.revoked!==0)throw new Fault('FORBIDDEN');const enrolled=enrollmentSchema.parse(JSON.parse(String(row.enrollment)));if(enrolled.expires_at<=Date.now()||enrolled.certificate_sha256!==certificateHash)throw new Fault('FORBIDDEN');return {...identity};}
 stats(){return {decisions:Number(this.db.prepare('SELECT count(*) AS n FROM decisions').get()!.n),pending_or_unknown:Number(this.db.prepare("SELECT count(*) AS n FROM decisions WHERE status IN ('pending','unknown')").get()!.n),principals:Number(this.db.prepare('SELECT count(*) AS n FROM principals WHERE revoked=0').get()!.n)};}
 close(){if(this.closed)return;this.db.close();this.closed=true;}
}
