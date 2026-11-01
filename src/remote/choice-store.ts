import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Fault} from '../core/errors.js';
import {choiceArgsSchema,type ChoiceArgs} from '../choice/contracts.js';
import {canonicalJson,canonicalDigest,identitySchema} from './protocol.js';
import {choiceResponseSchema,type ChoiceResponse,type ChoiceOwner} from './choice.js';
const tableSql="CREATE TABLE choices(id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','complete','unknown')), owner TEXT NOT NULL, response TEXT)";
/** Separate durable namespace. Pending/unknown requests can never dispatch again, including after restart. */
export class ChoiceStore {
 private readonly db:DatabaseSync;private readonly instance=randomUUID();private closed=false;
 constructor(directory:string){
  const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});const dir=lstatSync(root);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0||dir.uid!==process.getuid?.())throw new Fault('PRIVATE_STORAGE_REQUIRED');
  const path=join(root,'choice.sqlite');let existed=false;for(const suffix of ['','-wal','-shm'])try{const file=lstatSync(path+suffix);if(!suffix)existed=true;if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||(file.mode&0o077)!==0||file.uid!==process.getuid?.())throw new Fault('PRIVATE_STORAGE_REQUIRED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  this.db=new DatabaseSync(path);chmodSync(path,0o600);
  try{this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');const version=this.db.prepare('PRAGMA user_version').get()?.user_version;
   if(existed){const definitions=this.db.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'").all();if(version!==1||definitions.length!==1||definitions[0]?.sql!==tableSql)throw new Error();}else{if(version!==0)throw new Error();this.db.exec('BEGIN IMMEDIATE;'+tableSql+';PRAGMA user_version=1;COMMIT;');}
   if(this.db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error();for(const row of this.db.prepare('SELECT * FROM choices').all()){if(typeof row.id!=='string'||!/^sha256:[a-f0-9]{64}$/.test(row.id)||typeof row.digest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(row.digest)||!['pending','complete','unknown'].includes(String(row.status))||typeof row.owner!=='string'||!/^[a-f0-9-]{36}$/.test(row.owner)||(row.status==='complete')!==(row.response!==null))throw new Error();if(row.response!==null)choiceResponseSchema.parse(JSON.parse(String(row.response)));}
  }catch{this.db.close();throw new Fault('CHOICE_STORAGE_CORRUPT');}
 }
 private transaction<T>(fn:()=>T):T{if(this.closed)throw new Fault('STORAGE_CLOSED');this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){try{this.db.exec('ROLLBACK');}catch{this.closed=true;this.db.close();}throw error;}}
 private key(scope:ChoiceOwner,args:ChoiceArgs){const identity=identitySchema.parse(scope.identity);if(typeof scope.caller_scope!=='string'||!scope.caller_scope)throw new Fault('FORBIDDEN');return canonicalDigest({identity,caller_scope:scope.caller_scope,idempotency_key:choiceArgsSchema.parse(args).idempotency_key});}
 begin(scope:ChoiceOwner,args:ChoiceArgs):{status:'started'|'unknown'}|{status:'complete';response:ChoiceResponse}{const key=this.key(scope,args),digest=canonicalDigest(args);return this.transaction(()=>{const row=this.db.prepare('SELECT * FROM choices WHERE id=?').get(key);if(row){if(row.digest!==digest)throw new Fault('IDEMPOTENCY_CONFLICT');return row.status==='complete'?{status:'complete',response:choiceResponseSchema.parse(JSON.parse(String(row.response)))}:{status:'unknown'};}this.db.prepare("INSERT INTO choices VALUES(?,?,'pending',?,NULL)").run(key,digest,this.instance);return {status:'started'};});}
 complete(scope:ChoiceOwner,args:ChoiceArgs,response:ChoiceResponse){this.finish(scope,args,'complete',canonicalJson(choiceResponseSchema.parse(response)));}
 markUnknown(scope:ChoiceOwner,args:ChoiceArgs){this.finish(scope,args,'unknown',null);}
 private finish(scope:ChoiceOwner,args:ChoiceArgs,status:'complete'|'unknown',response:string|null){this.transaction(()=>{const result=this.db.prepare("UPDATE choices SET status=?,response=? WHERE id=? AND digest=? AND status='pending' AND owner=?").run(status,response,this.key(scope,args),canonicalDigest(args),this.instance);if(result.changes!==1)throw new Fault('DECISION_NOT_PENDING');});}
 close(){if(!this.closed){this.db.close();this.closed=true;}}
}
