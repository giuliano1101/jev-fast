import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Fault} from '../core/errors.js';
import {idSchema,usageSchema} from '../core/contracts.js';
import {identitySchema,canonicalJson,type AuthenticatedIdentity} from './protocol.js';
export const INPUT_PRICE_USD_PER_MILLION=0.042;
export type AttemptUsage=z.infer<typeof usageSchema>;
export interface AttemptCompletion {http_status:number|null;usage:AttemptUsage|null}
/** Trusted host injection only. No response bodies, keys or model instructions enter this ledger. */
export interface AttemptRecorder {begin():string|Promise<string>;finish(attemptId:string,completion:AttemptCompletion):void|Promise<void>}
const scopeSchema=z.strictObject({policy_id:idSchema,identity:identitySchema,request_id:idSchema});
const completionSchema=z.strictObject({http_status:z.number().int().min(100).max(599).nullable(),usage:usageSchema.nullable()});
const tableSql="CREATE TABLE attempts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, policy_id TEXT NOT NULL, owner_id TEXT NOT NULL, device_id TEXT NOT NULL, agent_id TEXT NOT NULL, request_id TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, http_status INTEGER, input_tokens INTEGER, output_tokens INTEGER, input_price_usd_per_million_tokens REAL NOT NULL)";
const rowSchema=z.strictObject({id:z.uuid(),owner:z.uuid(),policy_id:idSchema,owner_id:idSchema,device_id:idSchema,agent_id:idSchema,request_id:idSchema,started_at:z.number().int().positive(),finished_at:z.number().int().positive().nullable(),http_status:z.number().int().min(100).max(599).nullable(),input_tokens:z.number().int().nonnegative().max(1e9).nullable(),output_tokens:z.number().int().nonnegative().max(1e9).nullable(),input_price_usd_per_million_tokens:z.number().finite().nonnegative()}).refine(r=>(r.input_tokens===null)===(r.output_tokens===null)&&(r.finished_at!==null||(r.http_status===null&&r.input_tokens===null)));
type Totals={attempts:number;known_usage_attempts:number;unknown_usage_attempts:number;input_tokens:number;output_tokens:number;known_input_cost_usd:number};
function totals(rows:z.infer<typeof rowSchema>[]):Totals {let known=0,input=0,output=0,cost=0;for(const r of rows)if(r.input_tokens!==null){known++;input+=r.input_tokens;output+=r.output_tokens!;cost+=r.input_tokens*r.input_price_usd_per_million_tokens/1e6;}return {attempts:rows.length,known_usage_attempts:known,unknown_usage_attempts:rows.length-known,input_tokens:input,output_tokens:output,known_input_cost_usd:cost};}
/** Accounting only: no allowance, expiry, reservation, request limit or cost limit. Pending attempts are unknown, including after restart. */
export class UsageLedger {
 private readonly db:DatabaseSync;private readonly instance=randomUUID();private closed=false;
 constructor(directory:string){
  const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});const dir=lstatSync(root);
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0||dir.uid!==process.getuid?.())throw new Fault('PRIVATE_STORAGE_REQUIRED');
  const path=join(root,'usage.sqlite');let existed=false;
  for(const suffix of ['','-wal','-shm'])try{const file=lstatSync(path+suffix);if(!suffix)existed=true;if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||(file.mode&0o077)!==0||file.uid!==process.getuid?.())throw new Fault('PRIVATE_STORAGE_REQUIRED');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  this.db=new DatabaseSync(path);chmodSync(path,0o600);
  try{
   this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
   const version=this.db.prepare('PRAGMA user_version').get()?.user_version;
   if(existed){const definitions=this.db.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'").all();if(version!==1||definitions.length!==1||definitions[0]?.sql!==tableSql)throw new Error();}
   else{if(version!==0)throw new Error();this.db.exec('BEGIN IMMEDIATE;'+tableSql+';PRAGMA user_version=1;COMMIT;');}
   if(this.db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error();this.rows();
  }catch{this.db.close();throw new Fault('USAGE_STORAGE_CORRUPT');}
 }
 private rows(){if(this.closed)throw new Fault('STORAGE_CLOSED');return this.db.prepare('SELECT * FROM attempts ORDER BY started_at,id').all().map(row=>rowSchema.parse(row));}
 private transaction<T>(fn:()=>T):T{if(this.closed)throw new Fault('STORAGE_CLOSED');this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){try{this.db.exec('ROLLBACK');}catch{this.closed=true;this.db.close();}throw error;}}
 recorder(scope:{policy_id:string;identity:AuthenticatedIdentity;request_id:string}):{begin():string;finish(attemptId:string,completion:AttemptCompletion):void}{
  const s=scopeSchema.parse(scope),i=s.identity;
  return {begin:()=>this.transaction(()=>{const id=randomUUID();this.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?)').run(id,this.instance,s.policy_id,i.owner_id,i.device_id,i.agent_id,s.request_id,Date.now(),INPUT_PRICE_USD_PER_MILLION);return id;}),finish:(id,value)=>{z.uuid().parse(id);const c=completionSchema.parse(value);this.transaction(()=>{const changed=this.db.prepare('UPDATE attempts SET finished_at=?,http_status=?,input_tokens=?,output_tokens=? WHERE id=? AND owner=? AND policy_id=? AND owner_id=? AND device_id=? AND agent_id=? AND request_id=? AND finished_at IS NULL').run(Date.now(),c.http_status,c.usage?.input_tokens??null,c.usage?.output_tokens??null,id,this.instance,s.policy_id,i.owner_id,i.device_id,i.agent_id,s.request_id);if(changed.changes!==1)throw new Fault('ATTEMPT_NOT_PENDING');});}};
 }
 summary(){const rows=this.rows(),byIdentity=new Map<string,typeof rows>(),byRequest=new Map<string,typeof rows>();for(const row of rows){const key=canonicalJson([row.policy_id,row.owner_id,row.device_id,row.agent_id]);const identityRows=byIdentity.get(key)??[];identityRows.push(row);byIdentity.set(key,identityRows);const requestKey=key+':'+row.request_id;const requestRows=byRequest.get(requestKey)??[];requestRows.push(row);byRequest.set(requestKey,requestRows);}const scope=(row:typeof rows[number])=>({policy_id:row.policy_id,identity:{owner_id:row.owner_id,device_id:row.device_id,agent_id:row.agent_id}});return {...totals(rows),input_price_usd_per_million_tokens:INPUT_PRICE_USD_PER_MILLION,output_cost_usd:0,by_identity:[...byIdentity.values()].map(group=>({...scope(group[0]!),...totals(group)})),by_request:[...byRequest.values()].map(group=>({...scope(group[0]!),request_id:group[0]!.request_id,...totals(group)}))};}
 close(){if(this.closed)return;this.db.close();this.closed=true;}
}
