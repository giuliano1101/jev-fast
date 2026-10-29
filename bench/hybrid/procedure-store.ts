import type {ProcedureDefinition,ProcedureScope,TrialEvidence,WorkflowCatalog} from './workflow-contracts.js';
export type ProcedureStatus='DRAFT'|'PROBATION'|'ACTIVE'|'QUARANTINED'|'EXPIRED';
export interface ProcedureSnapshot {
  schemaVersion:1; definitionVersion:number; revision:number; status:ProcedureStatus;
  createdAt:number; recordedAt:number; expiresAt:number; definition:ProcedureDefinition; trials:TrialEvidence[];
}
export interface ProcedureMatch {
  status:ProcedureStatus|'MISSING'; reason:'MATCH'|'MISSING'|'TTL_EXPIRED'|'SCOPE_MISMATCH'|'NOT_ACTIVE'; procedure?:ProcedureSnapshot;
}

import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {parseProcedureDefinition,parseTrialEvidence,procedureScopeSchema,workflowSchemas} from './workflow-contracts.js';

const HISTORY_LIMIT=10000;
const timestamp=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const statusSchema=z.enum(['DRAFT','PROBATION','ACTIVE','QUARANTINED','EXPIRED']);
function persistedSchema(catalog:WorkflowCatalog) {
  const schemas=workflowSchemas(catalog);
  const snapshot=z.strictObject({schemaVersion:z.literal(1),definitionVersion:z.number().int().positive(),revision:z.number().int().positive(),
    status:statusSchema,createdAt:timestamp,recordedAt:timestamp,expiresAt:timestamp,definition:schemas.definition,trials:z.array(schemas.evidence).min(1).max(HISTORY_LIMIT)});
  return z.strictObject({schemaVersion:z.literal(1),history:z.array(snapshot).max(HISTORY_LIMIT)});
}
function validTime(now:number):void {if(!timestamp.safeParse(now).success)throw new Error('INVALID_TIME');}
function qualifies(definition:ProcedureDefinition,trial:TrialEvidence):boolean {
  return trial.independentlyVerified && trial.terminal===true && !trial.actionUnknown && trial.regression===false
    && definition.goalPredicates.every(id=>trial.predicates[id]===true);
}
function demonstration(definition:ProcedureDefinition,trial:TrialEvidence):void {
  if(trial.executor!=='teacher'||!qualifies(definition,trial))throw new Error('INVALID_DEMONSTRATION');
}
function classify(previous:ProcedureSnapshot,trials:TrialEvidence[],now:number):ProcedureStatus {
  if(previous.status==='QUARANTINED'||trials.some(t=>t.regression===true ||
    (t.independentlyVerified&&t.terminal===true&&previous.definition.goalPredicates.some(id=>t.predicates[id]===false))))return 'QUARANTINED';
  if(previous.status==='EXPIRED'||now>=previous.expiresAt)return 'EXPIRED';
  const good=trials.filter(t=>qualifies(previous.definition,t));
  return good.length>=3&&new Set(good.map(t=>t.startStateKey)).size>=2&&!trials.some(t=>t.actionUnknown)?'ACTIVE':'PROBATION';
}
/** Local research store. One exclusive owner, append-only revisions, atomic fsync/rename snapshots.
 * Bounded to 10,000 snapshots/trials; repeated full evidence snapshots have quadratic storage growth.
 * Parameters and recovery policy remain bound by the trusted host; definitions store public semantic steps only.
 * Stale owner.lock files deliberately require operator verification/removal; never steal a live lease.
 * Evidence must originate from the trusted independent verifier, never a teacher's own success claim.
 */
export class ProcedureStore {
  private tail:Promise<void>=Promise.resolve();
  private closed=false;
  private closing:Promise<void>|undefined;
  private storageUncertain=false;
  private constructor(readonly directory:string,private readonly catalog:WorkflowCatalog,private readonly lock:FileHandle,private history:ProcedureSnapshot[]) {}
  static async open(directory:string,catalog:WorkflowCatalog):Promise<ProcedureStore> {
    await mkdir(directory,{recursive:true,mode:0o700});
    let lock:FileHandle;
    try {lock=await open(join(directory,'owner.lock'),'wx',0o600);}
    catch(error) {if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('STORAGE_BUSY');throw error;}
    try {
      await lock.writeFile(JSON.stringify({pid:process.pid,token:randomUUID()}));await lock.sync();
      let history:ProcedureSnapshot[]=[];
      try {
        const raw=JSON.parse(await readFile(join(directory,'procedures.json'),'utf8')) as unknown;
        history=persistedSchema(catalog).parse(raw).history;
        validateHistory(history);
      } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('STORAGE_CORRUPT');}
      return new ProcedureStore(directory,structuredClone(catalog),lock,history);
    } catch(error) {await lock.close();await unlink(join(directory,'owner.lock'));throw error;}
  }
  get(id:string,revision?:number):ProcedureSnapshot|undefined {
    this.assertReadable();
    const result=this.history.findLast(s=>s.definition.procedureId===id&&(revision===undefined||s.revision===revision));
    return result?structuredClone(result):undefined;
  }
  match(id:string,scope:ProcedureScope,now=Date.now()):ProcedureMatch {
    validTime(now);
    const parsed=procedureScopeSchema.safeParse(scope);
    if(!parsed.success)throw new Error('INVALID_SCOPE');
    const procedure=this.get(id);
    if(!procedure)return {status:'MISSING',reason:'MISSING'};
    if(now<procedure.createdAt)throw new Error('INVALID_TIME');
    if(now>=procedure.expiresAt)return {status:'EXPIRED',reason:'TTL_EXPIRED',procedure};
    if(!isDeepStrictEqual(procedure.definition.scope,parsed.data))return {status:'EXPIRED',reason:'SCOPE_MISMATCH',procedure};
    return {status:procedure.status,reason:procedure.status==='ACTIVE'?'MATCH':'NOT_ACTIVE',procedure};
  }
  create(value:unknown,evidence:unknown,now=Date.now()):Promise<ProcedureSnapshot> {
    return this.change(()=>{
      const definition=parseProcedureDefinition(value,this.catalog);
      if(this.get(definition.procedureId))throw new Error('PROCEDURE_EXISTS');
      const trial=this.checkTrial(evidence,now);
      demonstration(definition,trial);
      return {schemaVersion:1,definitionVersion:1,revision:1,status:'DRAFT',createdAt:now,recordedAt:now,
        expiresAt:now+definition.ttlMs,definition,trials:[trial]};
    });
  }
  recordTrial(id:string,revision:number,evidence:unknown,now=Date.now()):Promise<ProcedureSnapshot> {
    return this.change(()=>{
      const previous=this.checkRevision(id,revision,now);
      const trial=this.checkTrial(evidence,now,previous.createdAt);
      const trials=[...previous.trials,trial];
      return {...previous,revision:revision+1,recordedAt:now,status:classify(previous,trials,now),trials};
    });
  }
  revise(id:string,revision:number,value:unknown,evidence:unknown,now=Date.now()):Promise<ProcedureSnapshot> {
    return this.change(()=>{
      const previous=this.checkRevision(id,revision,now);
      const definition=parseProcedureDefinition(value,this.catalog);
      if(definition.procedureId!==id)throw new Error('PROCEDURE_ID_MISMATCH');
      const trial=this.checkTrial(evidence,now);
      demonstration(definition,trial);
      return {schemaVersion:1,definitionVersion:previous.definitionVersion+1,revision:revision+1,status:'DRAFT',
        createdAt:now,recordedAt:now,expiresAt:now+definition.ttlMs,definition,trials:[trial]};
    });
  }
  private assertReadable():void {if(this.closed)throw new Error('STORAGE_CLOSED');if(this.storageUncertain)throw new Error('STORAGE_WRITE_UNCERTAIN');}
  private checkRevision(id:string,revision:number,now:number):ProcedureSnapshot {
    validTime(now);
    const previous=this.get(id);
    if(!previous)throw new Error('PROCEDURE_MISSING');
    if(previous.revision!==revision)throw new Error('REVISION_CONFLICT');
    if(now<previous.recordedAt)throw new Error('INVALID_TIME');
    return previous;
  }
  private checkTrial(evidence:unknown,now:number,minTime=0):TrialEvidence {
    validTime(now);
    const trial=parseTrialEvidence(evidence,this.catalog);
    if(trial.completedAt>now||trial.completedAt<minTime)throw new Error('INVALID_EVIDENCE_TIME');
    if(this.history.some(s=>s.trials.some(t=>t.trialId===trial.trialId)))throw new Error('DUPLICATE_TRIAL');
    return trial;
  }
  private change(build:()=>ProcedureSnapshot):Promise<ProcedureSnapshot> {
    if(this.closing||this.closed)return Promise.reject(new Error('STORAGE_CLOSED'));
    const task=this.tail.then(async()=>{
      this.assertReadable();
      if(this.history.length>=HISTORY_LIMIT)throw new Error('HISTORY_LIMIT');
      const snapshot=build();
      const parsed=persistedSchema(this.catalog).safeParse({schemaVersion:1,history:[...this.history,snapshot]});
      if(!parsed.success)throw new Error('INVALID_SNAPSHOT');
      const next=parsed.data.history;
      validateHistory(next);
      const temporary=join(this.directory,`procedures-${randomUUID()}.tmp`);
      let renamed=false;
      try {
        const file=await open(temporary,'wx',0o600);
        try {await file.writeFile(JSON.stringify({schemaVersion:1,history:next}));await file.sync();}
        finally {await file.close();}
        await rename(temporary,join(this.directory,'procedures.json'));renamed=true;
        const directory=await open(this.directory,'r');try {await directory.sync();}finally {await directory.close();}
        this.history=next;
        return structuredClone(snapshot);
      } catch(error) {
        if(renamed){this.storageUncertain=true;throw new Error('STORAGE_WRITE_UNCERTAIN');}
        await unlink(temporary).catch(()=>{});throw error;
      }
    });
    this.tail=task.then(()=>{},()=>{});
    return task;
  }
  close():Promise<void> {
    if(this.closing)return this.closing;
    // Drain accepted writes under the lease, while refusing newly submitted mutations.
    this.closing=this.tail.then(async()=>{
      this.closed=true;await this.lock.close();await unlink(join(this.directory,'owner.lock'));
    });
    return this.closing;
  }
}
/** Replay immutable history on load, rather than trusting persisted ACTIVE status or evidence counts. */
function validateHistory(history:ProcedureSnapshot[]):void {
  const latest=new Map<string,ProcedureSnapshot>();
  const trialIds=new Set<string>();
  for(const snapshot of history) {
    const prior=latest.get(snapshot.definition.procedureId);
    if(snapshot.revision!==(prior?.revision??0)+1||snapshot.expiresAt!==snapshot.createdAt+snapshot.definition.ttlMs||
      !Number.isSafeInteger(snapshot.expiresAt)||snapshot.recordedAt<snapshot.createdAt||
      (prior&&snapshot.recordedAt<prior.recordedAt))throw new Error('INVALID_HISTORY');
    const newVersion=!prior||snapshot.definitionVersion===prior.definitionVersion+1;
    let added:TrialEvidence|undefined;
    if(newVersion) {
      if(snapshot.definitionVersion!==(prior?.definitionVersion??0)+1||snapshot.status!=='DRAFT'||snapshot.trials.length!==1||snapshot.createdAt!==snapshot.recordedAt)throw new Error('INVALID_HISTORY');
      added=snapshot.trials[0]!;demonstration(snapshot.definition,added);
    } else {
      if(!prior||snapshot.definitionVersion!==prior.definitionVersion||!isDeepStrictEqual(snapshot.definition,prior.definition)||
        snapshot.createdAt!==prior.createdAt||snapshot.trials.length!==prior.trials.length+1||
        !isDeepStrictEqual(snapshot.trials.slice(0,-1),prior.trials)||snapshot.status!==classify(prior,snapshot.trials,snapshot.recordedAt))throw new Error('INVALID_HISTORY');
      added=snapshot.trials.at(-1)!;
      if(added.completedAt<snapshot.createdAt)throw new Error('INVALID_HISTORY');
    }
    if(added.completedAt>snapshot.recordedAt||trialIds.has(added.trialId))throw new Error('INVALID_HISTORY');
    trialIds.add(added.trialId);latest.set(snapshot.definition.procedureId,snapshot);
  }
}
