export interface PendingExecution {schemaVersion:1;eventId:string;leaseKey:string;sessionId:string;actionId:string;observationId:string;startedAt:number}
export interface TrustedReconciliationProof {eventId:string;leaseKey:string;actionId:string;observationId:string;evidenceId:string;verdict:'executed'|'not-executed'|'unconfirmed'}
export interface ExecutionJournal {
 getPending(leaseKey:string):Promise<PendingExecution|undefined>;
 begin(event:PendingExecution):Promise<void>;
 acknowledge(event:PendingExecution,status:'executed'|'rejected'):Promise<void>;
 reconcile(event:PendingExecution,proof:TrustedReconciliationProof):Promise<void>;
}
import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {workflowIdSchema} from './workflow-contracts.js';
const pendingSchema=z.strictObject({schemaVersion:z.literal(1),eventId:z.uuid(),leaseKey:workflowIdSchema,sessionId:workflowIdSchema,actionId:workflowIdSchema,observationId:workflowIdSchema,startedAt:z.number().int().nonnegative()});
const proofSchema=z.strictObject({eventId:z.uuid(),leaseKey:workflowIdSchema,actionId:workflowIdSchema,observationId:workflowIdSchema,evidenceId:workflowIdSchema,verdict:z.enum(['executed','not-executed','unconfirmed'])});
const resolutionSchema=z.strictObject({event:pendingSchema,status:z.enum(['executed','rejected','reconciled']),proof:proofSchema.optional()});
const stateSchema=z.strictObject({schemaVersion:z.literal(1),pending:z.array(pendingSchema).max(10000),resolved:z.array(resolutionSchema).max(10000)});
type JournalState=z.infer<typeof stateSchema>;
export function validateReconciliation(event:PendingExecution,value:unknown):TrustedReconciliationProof {
 const result=proofSchema.safeParse(value);
 if(!result.success||result.data.eventId!==event.eventId||result.data.leaseKey!==event.leaseKey||result.data.actionId!==event.actionId||result.data.observationId===event.observationId)throw new Error('INVALID_RECONCILIATION');
 return result.data;
}
/** Trusted host-owned, fail-closed physical input journal. begin() is durable before input;
 * unresolved events survive restart and are never erased by a late adapter callback. A stale
 * owner.lock requires operator verification, rather than guessing that its owner is dead.
 */
export class FileExecutionJournal implements ExecutionJournal {
 private tail:Promise<void>=Promise.resolve();private closing:Promise<void>|undefined;private closed=false;private uncertain=false;
 private constructor(readonly directory:string,private readonly lock:FileHandle,private state:JournalState){}
 static async open(directory:string):Promise<FileExecutionJournal>{
   await mkdir(directory,{recursive:true,mode:0o700});let lock:FileHandle;
   try{lock=await open(join(directory,'owner.lock'),'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('JOURNAL_BUSY');throw error;}
   try{
     await lock.writeFile(JSON.stringify({pid:process.pid,token:randomUUID()}));await lock.sync();
     let state:JournalState={schemaVersion:1,pending:[],resolved:[]};
     try{state=stateSchema.parse(JSON.parse(await readFile(join(directory,'executions.json'),'utf8')));validateState(state);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('JOURNAL_CORRUPT');}
     return new FileExecutionJournal(directory,lock,state);
   }catch(error){await lock.close();await unlink(join(directory,'owner.lock'));throw error;}
 }
 private readable(){if(this.closed)throw new Error('JOURNAL_CLOSED');if(this.uncertain)throw new Error('JOURNAL_WRITE_UNCERTAIN');}
 async getPending(leaseKey:string):Promise<PendingExecution|undefined>{this.readable();const pending=this.state.pending.find(p=>p.leaseKey===leaseKey);return pending?structuredClone(pending):undefined;}
 begin(value:PendingExecution):Promise<void>{return this.change(state=>{
   const event=pendingSchema.parse(value);
   if(state.pending.some(p=>p.leaseKey===event.leaseKey))throw new Error('SURFACE_QUARANTINED');
   if([...state.pending,...state.resolved.map(r=>r.event)].some(p=>p.eventId===event.eventId))throw new Error('DUPLICATE_EVENT');
   state.pending.push(event);
 });}
 acknowledge(event:PendingExecution,status:'executed'|'rejected'):Promise<void>{return this.change(state=>{if(status!=='executed'&&status!=='rejected')throw new Error('INVALID_ACKNOWLEDGEMENT');this.take(state,event);state.resolved.push({event:structuredClone(event),status});});}
 reconcile(event:PendingExecution,proof:TrustedReconciliationProof):Promise<void>{return this.change(state=>{const verified=validateReconciliation(event,proof);this.take(state,event);state.resolved.push({event:structuredClone(event),status:'reconciled',proof:verified});});}
 private take(state:JournalState,event:PendingExecution){const index=state.pending.findIndex(p=>isDeepStrictEqual(p,event));if(index<0)throw new Error('EVENT_MISMATCH');state.pending.splice(index,1);}
 private change(update:(state:JournalState)=>void):Promise<void>{
   if(this.closing||this.closed)return Promise.reject(new Error('JOURNAL_CLOSED'));
   const task=this.tail.then(async()=>{
     this.readable();const next=structuredClone(this.state);update(next);stateSchema.parse(next);validateState(next);
     const temporary=join(this.directory,`${randomUUID()}.tmp`);let renamed=false;
     try{
       const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(next));await file.sync();}finally{await file.close();}
       await rename(temporary,join(this.directory,'executions.json'));renamed=true;
       const directory=await open(this.directory,'r');try{await directory.sync();}finally{await directory.close();}
       this.state=next;
     }catch(error){if(renamed){this.uncertain=true;throw new Error('JOURNAL_WRITE_UNCERTAIN');}await unlink(temporary).catch(()=>{});throw error;}
   });this.tail=task.then(()=>{},()=>{});return task;
 }
 close():Promise<void>{if(this.closing)return this.closing;this.closing=this.tail.then(async()=>{this.closed=true;await this.lock.close();await unlink(join(this.directory,'owner.lock'));});return this.closing;}
}
function validateState(state:JournalState):void {
 const events=[...state.pending,...state.resolved.map(r=>r.event)];
 if(new Set(events.map(e=>e.eventId)).size!==events.length||new Set(state.pending.map(e=>e.leaseKey)).size!==state.pending.length)throw new Error('INVALID_JOURNAL');
 for(const resolution of state.resolved){if(resolution.status==='reconciled'){validateReconciliation(resolution.event,resolution.proof);}else if(resolution.proof)throw new Error('INVALID_JOURNAL');}
}
