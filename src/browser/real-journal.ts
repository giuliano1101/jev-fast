import {readFile,open,rename,unlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Ledger} from '../session/ledger.js';
import {Fault} from '../core/errors.js';
import type {RealBrowserActionResult} from './real-contracts.js';
const recordSchema=z.strictObject({owner:z.string().min(1),session_id:z.string().min(1),digest:z.string().min(1),status:z.enum(['pending','completed','unknown']),result:z.json().optional()}).refine(record=>record.status!=='completed'||record.result!==undefined);
const journalSchema=z.strictObject({version:z.literal(1),records:z.record(z.string(),recordSchema)});
export interface RealJournalRecord {owner:string;session_id:string;digest:string;status:'pending'|'completed'|'unknown';result?:RealBrowserActionResult}
interface State {version:1;records:Record<string,RealJournalRecord>}
/** Private atomic audit. The standard ledger provides proven exclusive ownership and stale-PID recovery only. */
export class RealBrowserJournal {
 private tail=Promise.resolve();private uncertain=false;private closed=false;
 private constructor(private directory:string,private lock:Ledger,private state:State){}
 static async open(directory:string){
  await mkdir(directory,{recursive:true,mode:0o700});const lock=await Ledger.open(join(directory,'ownership'));
  try{
   let state:State={version:1,records:{}};
   try{const parsed=journalSchema.safeParse(JSON.parse(await readFile(join(directory,'actions.json'),'utf8')));if(!parsed.success)throw new Fault('STORAGE_CORRUPT');state=parsed.data as unknown as State;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Fault('STORAGE_CORRUPT');}
   const journal=new RealBrowserJournal(directory,lock,state);
   // A previous process may have dispatched an input. Never infer that it did not.
   await journal.change(draft=>{for(const record of Object.values(draft.records))if(record.status==='pending'){record.status='unknown';record.result={execution:'unknown',reason:'PROCESS_RESTART'};}});
   return journal;
  }catch(error){await lock.close();throw error;}
 }
 find(key:string){if(this.uncertain)throw new Fault('STORAGE_WRITE_UNCERTAIN');const record=this.state.records[key];return record?structuredClone(record):undefined;}
 private change(mutator:(state:State)=>void):Promise<void>{
  const operation=this.tail.then(async()=>{
   if(this.closed)throw new Fault('STORAGE_CLOSED');if(this.uncertain)throw new Fault('STORAGE_WRITE_UNCERTAIN');
   const draft=structuredClone(this.state);mutator(draft);if(!journalSchema.safeParse(draft).success)throw new Fault('STORAGE_CORRUPT');
   const temporary=join(this.directory,'actions-'+randomUUID()+'.tmp');let renamed=false;
   try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(draft));await file.sync();}finally{await file.close();}await rename(temporary,join(this.directory,'actions.json'));renamed=true;const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}this.state=draft;}
   catch(error){if(renamed){this.uncertain=true;throw new Fault('STORAGE_WRITE_UNCERTAIN');}await unlink(temporary).catch(()=>{});throw error;}
  });this.tail=operation.catch(()=>{});return operation;
 }
 begin(key:string,record:Omit<RealJournalRecord,'status'|'result'>){return this.change(state=>{if(Object.hasOwn(state.records,key))throw new Fault('IDEMPOTENCY_CONFLICT');state.records[key]={...record,status:'pending'};});}
 finish(key:string,result:RealBrowserActionResult){return this.change(state=>{const record=state.records[key];if(!record)throw new Fault('STORAGE_CORRUPT');record.status=result.execution==='executed'?'completed':'unknown';record.result=structuredClone(result);});}
 async close(){await this.tail;this.closed=true;await this.lock.close();}
}
