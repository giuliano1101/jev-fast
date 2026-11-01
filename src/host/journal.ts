import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Fault} from '../core/errors.js';
import {canonicalDigest,canonicalJson} from '../remote/protocol.js';
import {choiceResponseSchema,type ChoiceResponse} from '../remote/choice.js';
import {hostActionResultSchema,unknownHostResult,type HostActArgs,type HostActionResult} from './contracts.js';
const tableSql="CREATE TABLE host_actions(id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','complete','unknown')), writer TEXT NOT NULL, decision TEXT, response TEXT)";
export type HostJournalPrior={status:'started'}|{status:'complete';response:HostActionResult}|{status:'unknown';response?:HostActionResult};
/** Digests scope by authenticated owner, configured host, and stable idempotency key. No raw task/state/arguments are persisted. */
export class HostJournal {
 private readonly db:DatabaseSync;private readonly writer=randomUUID();private closed=false;
 constructor(directory:string){
  const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});const dir=lstatSync(root);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0||dir.uid!==process.getuid?.())throw new Fault('PRIVATE_STORAGE_REQUIRED');
  const path=join(root,'host.sqlite');let existed=false;for(const suffix of ['','-wal','-shm'])try{const file=lstatSync(path+suffix);if(!suffix)existed=true;if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||(file.mode&0o077)!==0||file.uid!==process.getuid?.())throw new Fault('PRIVATE_STORAGE_REQUIRED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  this.db=new DatabaseSync(path);chmodSync(path,0o600);
  try{this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');const version=this.db.prepare('PRAGMA user_version').get()?.user_version;
   if(existed){const definitions=this.db.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'").all();if(version!==1||definitions.length!==1||definitions[0]?.sql!==tableSql)throw new Error();}else{if(version!==0)throw new Error();this.db.exec('BEGIN IMMEDIATE;'+tableSql+';PRAGMA user_version=1;COMMIT;');}
   if(this.db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error();for(const row of this.db.prepare('SELECT * FROM host_actions').all()){if(typeof row.id!=='string'||!/^sha256:[a-f0-9]{64}$/.test(row.id)||typeof row.digest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(row.digest)||!['pending','complete','unknown'].includes(String(row.status))||typeof row.writer!=='string'||!/^[a-f0-9-]{36}$/.test(row.writer)||(row.status==='complete'&&row.response===null))throw new Error();if(row.decision!==null)choiceResponseSchema.parse(JSON.parse(String(row.decision)));if(row.response!==null)hostActionResultSchema.parse(JSON.parse(String(row.response)));}
  }catch{this.db.close();throw new Fault('HOST_STORAGE_CORRUPT');}
 }
 private transaction<T>(fn:()=>T):T{if(this.closed)throw new Fault('STORAGE_CLOSED');this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){try{this.db.exec('ROLLBACK');}catch{this.closed=true;this.db.close();}throw error;}}
 private key(owner:string,args:HostActArgs){if(!owner)throw new Fault('FORBIDDEN');return canonicalDigest({owner,host:args.host,idempotency_key:args.idempotency_key});}
 begin(owner:string,args:HostActArgs):HostJournalPrior{return this.transaction(()=>{const key=this.key(owner,args),digest=canonicalDigest(args),row=this.db.prepare('SELECT * FROM host_actions WHERE id=?').get(key);if(row){if(row.digest!==digest)throw new Fault('IDEMPOTENCY_CONFLICT');const response=row.response===null?undefined:hostActionResultSchema.parse(JSON.parse(String(row.response)));if(row.status==='complete')return {status:'complete',response:response!};const decision=row.decision===null?undefined:choiceResponseSchema.parse(JSON.parse(String(row.decision)));return {status:'unknown',...(response?{response}:decision?{response:unknownHostResult(decision)}:{})};}this.db.prepare("INSERT INTO host_actions VALUES(?,?,'pending',?,NULL,NULL)").run(key,digest,this.writer);return {status:'started'};});}
 selected(owner:string,args:HostActArgs,decision:ChoiceResponse){this.update(owner,args,'decision=?',[canonicalJson(choiceResponseSchema.parse(decision))]);}
 complete(owner:string,args:HostActArgs,response:HostActionResult){this.update(owner,args,"status='complete',response=?",[canonicalJson(hostActionResultSchema.parse(response))]);}
 unknown(owner:string,args:HostActArgs,response?:HostActionResult){this.update(owner,args,"status='unknown',response=?",[response?canonicalJson(hostActionResultSchema.parse(response)):null]);}
 private update(owner:string,args:HostActArgs,set:string,values:(string|null)[]){this.transaction(()=>{const result=this.db.prepare(`UPDATE host_actions SET ${set} WHERE id=? AND digest=? AND status='pending' AND writer=?`).run(...values,this.key(owner,args),canonicalDigest(args),this.writer);if(result.changes!==1)throw new Fault('HOST_ACTION_NOT_PENDING');});}
 close(){if(!this.closed){this.db.close();this.closed=true;}}
}
