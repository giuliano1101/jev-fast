import type {ProcedureStore} from './procedure-store.js';
import type {EvidenceTruth,ProcedureScope,ProcedureStep,TrialEvidence} from './workflow-contracts.js';
import {procedureScopeSchema,workflowIdSchema,workflowSchemas} from './workflow-contracts.js';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {validateReconciliation,type ExecutionJournal,type PendingExecution,type TrustedReconciliationProof} from './execution-journal.js';
export interface HybridObservation {observationId:string;stateKey:string;readiness:'pending'|'settled'|'unobservable';predicates:Record<string,EvidenceTruth>;visibleActionIds:string[]}
export interface HybridAction extends ProcedureStep {deterministic:boolean}
export interface HybridCatalog {actions:readonly HybridAction[];predicateIds:readonly string[]}
export interface HybridContext {signal:AbortSignal;deadline:number}
export interface HybridBinding {actionId:string;observationId:string;token:string}
export interface HybridAdapter {
 observe(context:HybridContext):Promise<HybridObservation>;
 bind(actionId:string,observation:HybridObservation,context:HybridContext):Promise<HybridBinding|null>;
 execute(binding:HybridBinding,context:HybridContext):Promise<{status:'executed'|'unknown'|'rejected'}>;
}
export interface HybridDecisionRequest {sessionId:string;goalPredicates:string[];observation:HybridObservation;actionIds:string[];candidates:string[];remainingActions:number;reason:string}
export type HybridPlanner=(request:HybridDecisionRequest,context:HybridContext)=>Promise<unknown>;
export interface HybridSessionOptions {policy?:'learned'|'catalog';sessionId:string;leaseKey:string;scope:ProcedureScope;goalPredicates:string[];catalog:HybridCatalog;adapter:HybridAdapter;journal?:ExecutionJournal;jev?:HybridPlanner;teacher?:HybridPlanner;signal?:AbortSignal;settle?:{maxDurationMs?:number;maxObservations?:number};budget?:{maxActions?:number;maxDurationMs?:number;maxDecisions?:number};authorizeDecision?:(request:{executor:'jev'|'teacher';decisions:number;actions:number;remainingMs:number},context:HybridContext)=>Promise<boolean>;procedure?:{store:ProcedureStore;id:string};now?:()=>number}
export interface HybridEvent {type:string;atMs:number;route?:string;reason?:string;actionId?:string;durationMs?:number}
export interface HybridResult {status:'SUCCEEDED'|'FAILED'|'UNKNOWN';reason:string;actions:number;decisions:number;teacherHandoffs:number;executors:{direct:number;jev:number;teacher:number};events:HybridEvent[];elapsedMs:number;evidencePersisted?:boolean}
const leases=new Map<string,symbol>();
const unresolved=new Map<string,PendingExecution>();
class Stop extends Error {}
const truth=z.union([z.boolean(),z.literal('unknown')]);
const observationSchema=z.strictObject({observationId:workflowIdSchema,stateKey:workflowIdSchema,readiness:z.enum(['pending','settled','unobservable']),predicates:z.record(workflowIdSchema,truth),visibleActionIds:z.array(workflowIdSchema).max(64)});
const settlingSchema=z.strictObject({maxDurationMs:z.number().int().min(1).max(10000).default(2000),maxObservations:z.number().int().min(1).max(6).default(3)});
const jevSchema=z.strictObject({actionId:workflowIdSchema,confidence:z.number().min(0).max(1)});
/** Trusted host adapters own observation, binding and physical input. Planners receive only data.
 * policy='catalog' is explicit trusted-host approval of the static catalog, not learned evidence.
 * It is never accepted from a planner response or a public MCP request. Default policy is learned.
 * Trusted hosts may extend each read-only settle barrier to 10 seconds / 6 observations;
 * defaults remain 2 seconds / 3 observations and the shared session deadline always wins.
 * One process-local lease spans every mode. Hosts must also serialize this surface across processes.
 */
export async function runHybridSession(options:HybridSessionOptions):Promise<HybridResult> {
 const now=options.now??Date.now;const started=now();
 const result:HybridResult={status:'FAILED',reason:'INVALID_INPUT',actions:0,decisions:0,teacherHandoffs:0,executors:{direct:0,jev:0,teacher:0},events:[],elapsedMs:0};
 const policy=options.policy===undefined?'learned':options.policy;
 if(!z.enum(['learned','catalog']).safeParse(policy).success||(policy==='catalog'&&options.procedure!==undefined))return result;
 const settling=settlingSchema.safeParse(options.settle===undefined?{}:options.settle);
 if(!settling.success)return result;
 const settleBudget=settling.data;
 const event=(type:string,detail:Omit<HybridEvent,'type'|'atMs'>={})=>{result.events.push({type,atMs:Math.max(0,now()-started),...detail});};
 const budget={maxActions:options.budget?.maxActions??12,maxDurationMs:options.budget?.maxDurationMs??300000,maxDecisions:options.budget?.maxDecisions??13};
 if(!z.strictObject({maxActions:z.number().int().min(1).max(12),maxDurationMs:z.number().int().min(1).max(300000),maxDecisions:z.number().int().min(1).max(13)}).safeParse(budget).success ||
   !workflowIdSchema.safeParse(options.sessionId).success||!workflowIdSchema.safeParse(options.leaseKey).success||!procedureScopeSchema.safeParse(options.scope).success)return result;
 const catalog=structuredClone(options.catalog);const goals=[...options.goalPredicates];const scope=structuredClone(options.scope);
 const publicCatalog={actionIds:catalog.actions.map(a=>a.actionId),predicateIds:catalog.predicateIds};
 const stepSchema=workflowSchemas(publicCatalog).definition.shape.steps.element.extend({deterministic:z.boolean()});
 if(!catalog.actions.length||catalog.actions.length>64||new Set(publicCatalog.actionIds).size!==catalog.actions.length||!z.array(stepSchema).safeParse(catalog.actions).success||
   !goals.length||goals.some(id=>!catalog.predicateIds.includes(id))||new Set(goals).size!==goals.length)return result;
 if(leases.has(options.leaseKey)){result.reason='LEASE_BUSY';return result;}
 if(unresolved.has(options.leaseKey)){result.status='UNKNOWN';result.reason='SURFACE_QUARANTINED';return result;}
 const owner=Symbol();leases.set(options.leaseKey,owner);let inFlightExecution:Promise<unknown>|undefined;
 const local=new AbortController();const deadline=started+budget.maxDurationMs;const context={signal:local.signal,deadline};
 const abort=()=>local.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
 let initialObservation:HybridObservation|undefined;let uncertain=false;let observation:HybridObservation|undefined;let startStateKey='unobserved';let regression=false;
 const attempted=new Set<string>();let plan:string[]|undefined;let noProgress=0;const seen=new Map<string,number>();let executed:HybridAction[]=[];
 let quarantined=false;let match:ReturnType<ProcedureStore['match']>|undefined;let lastExecutor:'teacher'|'jev'|'direct'='direct';
 const check=()=>{if(options.signal?.aborted||local.signal.aborted)throw new Stop('CANCELLED');if(now()>=deadline)throw new Stop('DEADLINE');};
 async function invoke<T>(fn:()=>Promise<T>,kind:string,limit=deadline):Promise<T> {
   check();const before=now();let timer:ReturnType<typeof setTimeout>|undefined;let onAbort:(()=>void)|undefined;
   try {
     const task=Promise.resolve().then(()=>{check();return fn();});
     const bound=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Stop(limit<deadline?'SETTLE_TIMEOUT':'DEADLINE')),Math.max(1,limit-now()));onAbort=()=>reject(new Stop('CANCELLED'));local.signal.addEventListener('abort',onAbort,{once:true});});
     const value=await Promise.race([task,bound]);check();if(now()>=limit)throw new Stop(limit<deadline?'SETTLE_TIMEOUT':'DEADLINE');return value;
   } finally {if(timer)clearTimeout(timer);if(onAbort)local.signal.removeEventListener('abort',onAbort);event(kind,{durationMs:Math.max(0,now()-before)});}
 }
 async function observe(limit=deadline):Promise<HybridObservation> {
   const parsed=observationSchema.safeParse(await invoke(()=>options.adapter.observe(context),'observe',limit));
   if(!parsed.success||parsed.data.visibleActionIds.some(id=>!publicCatalog.actionIds.includes(id))||Object.keys(parsed.data.predicates).some(id=>!catalog.predicateIds.includes(id)))throw new Stop('INVALID_OBSERVATION');
   return parsed.data;
 }
 const all=(o:HybridObservation,ids:readonly string[])=>ids.every(id=>o.predicates[id]===true);
 const settled=(o:HybridObservation,ids:readonly string[])=>o.readiness==='settled'&&ids.every(id=>typeof o.predicates[id]==='boolean');
 async function settle(o:HybridObservation,ids:readonly string[]):Promise<HybridObservation> {
   if(settled(o,ids))return o;
   const until=Math.min(deadline,now()+settleBudget.maxDurationMs);event('settle');
   for(let i=0;i<settleBudget.maxObservations&&!settled(o,ids);i++) {try{
     await invoke(()=>new Promise<void>(resolve=>setTimeout(resolve,50*(i+1))),'settle-wait',until);
     o=await observe(until);}catch(error){if(error instanceof Stop&&error.message==='SETTLE_TIMEOUT')break;throw error;}}
   return o;
 }
 const candidates=(o:HybridObservation,activeOnly:boolean)=>catalog.actions.filter(a=>o.visibleActionIds.includes(a.actionId)&&all(o,a.preconditions)&&settled(o,a.postconditions)&&!all(o,a.postconditions)&&(!activeOnly||policy==='catalog'||match?.procedure?.definition.steps.some(s=>isDeepStrictEqual(s,strip(a)))));
 function strip(a:HybridAction):ProcedureStep {const {deterministic:_deterministic,...step}=a;return step;}
 function followsDefinition(steps:ProcedureStep[]):boolean {
   let index=0;
   for(const step of steps) {
     if(executed[index]&&isDeepStrictEqual(step,strip(executed[index]!)))index++;
     else if(!initialObservation||!all(initialObservation,step.postconditions))return false;
   }
   return index===executed.length;
 }
 async function decide(executor:'teacher'|'jev',reason:string):Promise<unknown> {
   check();if(result.actions>=budget.maxActions)throw new Stop('ACTION_BUDGET');if(result.decisions>=budget.maxDecisions)throw new Stop('DECISION_BUDGET');
   if(options.authorizeDecision&&!await invoke(()=>options.authorizeDecision!({executor,decisions:result.decisions,actions:result.actions,remainingMs:Math.max(0,deadline-now())},context),'authorize'))throw new Stop('DECISION_BUDGET');
   check();const callback=executor==='teacher'?options.teacher:options.jev;if(!callback)throw new Stop(executor==='teacher'?'TEACHER_UNAVAILABLE':'JEV_UNAVAILABLE');
   result.decisions++;
   return invoke(()=>callback({sessionId:options.sessionId,goalPredicates:[...goals],observation:structuredClone(observation!),actionIds:[...publicCatalog.actionIds],candidates:candidates(observation!,executor==='jev').map(a=>a.actionId),remainingActions:budget.maxActions-result.actions,reason},context),executor);
 }
 async function handoff(reason:string):Promise<void> {
   if(policy==='learned'&&regression&&!quarantined&&options.procedure&&observation) {
     const {store,id}=options.procedure;const prior=store.get(id);
     if(prior)await invoke(()=>store.recordTrial(id,prior.revision,{trialId:`${options.sessionId.slice(0,64)}.regression`,startStateKey,executor:lastExecutor,completedAt:now(),independentlyVerified:false,terminal:false,actionUnknown:false,regression:true,predicates:{...observation!.predicates}},now()),'quarantine');
     quarantined=true;
   }
   if(result.teacherHandoffs)throw new Stop('HANDOFF_LIMIT');
   result.teacherHandoffs++;event('route',{route:'TEACHER',reason});
   const response=await decide('teacher',reason);
   const parsed=z.strictObject({actionIds:z.array(workflowIdSchema.refine(id=>publicCatalog.actionIds.includes(id))).min(1).max(12)}).safeParse(response);
   if(!parsed.success)throw new Stop('INVALID_TEACHER_PLAN');plan=[...parsed.data.actionIds];
 }
 const state=(o:HybridObservation)=>JSON.stringify([o.stateKey,o.predicates]);
 async function record():Promise<boolean> {
   if(policy!=='learned'||!options.procedure||!observation||startStateKey==='unobserved')return false;
   const {store,id}=options.procedure;const completedAt=now();const verified=result.status==='SUCCEEDED'&&executed.length>0&&observation.readiness==='settled'&&all(observation,goals)&&!uncertain;
   const evidence:TrialEvidence={trialId:options.sessionId,startStateKey,executor:result.executors.teacher>0?'teacher':lastExecutor,completedAt,independentlyVerified:verified,terminal:verified?true:observation.readiness==='settled'?false:'unknown',actionUnknown:uncertain,regression,predicates:{...observation.predicates}};
   const prior=store.get(id);
   const definition={schemaVersion:1 as const,procedureId:id,scope,ttlMs:7*86400000,goalPredicates:goals,steps:executed.map(strip)};
   if(prior&&result.status==='SUCCEEDED'&&result.executors.teacher>0&&!regression&&executed.length&&
     (match?.status==='EXPIRED'||!isDeepStrictEqual(prior.definition.scope,scope)||!followsDefinition(prior.definition.steps))) {
     await store.revise(id,prior.revision,definition,evidence,completedAt);
   } else if(prior&&isDeepStrictEqual(prior.definition.scope,scope))await store.recordTrial(id,prior.revision,evidence,completedAt);
   else if(!prior&&result.status==='SUCCEEDED'&&result.executors.teacher>0&&executed.length)await store.create({schemaVersion:1,procedureId:id,scope,ttlMs:7*86400000,goalPredicates:goals,steps:executed.map(strip)},evidence,completedAt);
   else return false;
   return true;
 }
 try {
   check();
   const pending=await invoke(async()=>options.journal?.getPending(options.leaseKey),'journal-read');
   if(pending){unresolved.set(options.leaseKey,pending);uncertain=true;throw new Stop('SURFACE_QUARANTINED');}
   match=options.procedure?.store.match(options.procedure.id,scope,now());
   if(match?.status==='ACTIVE'&&!isDeepStrictEqual([...match.procedure!.definition.goalPredicates].sort(),[...goals].sort()))match={...match,status:'EXPIRED',reason:'SCOPE_MISMATCH'};
   observation=await observe();initialObservation=structuredClone(observation);startStateKey=observation.stateKey;
   for(let iteration=0;iteration<40;iteration++) {
     check();observation=await settle(observation,goals);
     if(settled(observation,goals)&&all(observation,goals)){result.status='SUCCEEDED';result.reason='GOAL_VERIFIED';event('route',{route:'DONE',reason:result.reason});break;}
     if(result.actions>=budget.maxActions)throw new Stop('ACTION_BUDGET');
     if(!settled(observation,goals)) {if(plan)throw new Stop('STATE_UNOBSERVABLE');await handoff('STATE_UNOBSERVABLE');observation=await observe();continue;}
     if(!plan&&((policy==='learned'&&match?.status!=='ACTIVE')||regression||noProgress>=2)){await handoff(regression?'INVARIANT_LOST':noProgress>=2?'NO_PROGRESS':'PROCEDURE_NOT_ACTIVE');}
     let selected:string|undefined;let executor:'direct'|'jev'|'teacher';
     if(plan) {executor='teacher';selected=plan.shift();if(!selected)throw new Stop('PLAN_EXHAUSTED');}
     else {
       const allowed=candidates(observation,true);const direct=allowed.filter(a=>a.deterministic);
       if(allowed.length===1&&direct.length===1){executor='direct';selected=direct[0]!.actionId;event('route',{route:'DIRECT'});}
       else {executor='jev';event('route',{route:'JEV'});
         if(policy==='catalog'&&!options.jev){await handoff('JEV_UNAVAILABLE');continue;}
         let raw:unknown;
         try{raw=await decide('jev','BOUNDED_CHOICE');}catch(error){if(error instanceof Stop)throw error;await handoff('DECISION_FAILED');continue;}
         const decision=jevSchema.safeParse(raw);
         if(!decision.success||decision.data.confidence<.9||!allowed.some(a=>a.actionId===decision.data.actionId)){await handoff('DECISION_REJECTED');continue;}
         selected=decision.data.actionId;
       }
     }
     const action=catalog.actions.find(a=>a.actionId===selected)!;
     const fresh=await observe();if(fresh.observationId===observation.observationId)throw new Stop('STALE_OBSERVATION');
     observation=await settle(fresh,[...goals,...action.preconditions,...action.postconditions]);
     if(!settled(observation,[...goals,...action.preconditions])) {
       if(executor!=='teacher'){await handoff('STATE_UNOBSERVABLE');continue;}throw new Stop('STATE_UNOBSERVABLE');
     }
     if(!settled(observation,action.postconditions)) {
       if(executor!=='teacher'){await handoff('POSTCONDITION_UNOBSERVABLE');continue;}throw new Stop('POSTCONDITION_UNOBSERVABLE');
     }
     if(!all(observation,action.preconditions)||!observation.visibleActionIds.includes(action.actionId)) {
       if(executor!=='teacher'){regression=true;await handoff('PRECONDITION_FAILED');continue;}throw new Stop('PRECONDITION_FAILED');
     }
     // Already satisfied steps are skipped rather than toggled or replayed.
     if(all(observation,action.postconditions))continue;
     if(attempted.has(action.actionId)&&!action.safeRepeat)throw new Stop('UNSAFE_REPEAT');
     const binding=await invoke(()=>options.adapter.bind(action.actionId,structuredClone(observation!),context),'bind');
     if(!binding||binding.actionId!==action.actionId||binding.observationId!==observation.observationId||typeof binding.token!=='string'||!binding.token) {
       if(executor!=='teacher'){regression=true;await handoff('INVALID_BINDING');continue;}throw new Stop('INVALID_BINDING');
     }
     check();if(result.actions>=budget.maxActions)throw new Stop('ACTION_BUDGET');
     const pending:PendingExecution={schemaVersion:1,eventId:randomUUID(),leaseKey:options.leaseKey,sessionId:options.sessionId,actionId:action.actionId,observationId:observation.observationId,startedAt:now()};
     unresolved.set(options.leaseKey,pending);uncertain=true;
     if(options.journal)await invoke(()=>options.journal!.begin(pending),'journal-begin');
     check();
     const before=observation;attempted.add(action.actionId);result.actions++;result.executors[executor]++;lastExecutor=executor;uncertain=true;event('execute',{actionId:action.actionId,route:executor.toUpperCase()});
     const outcome=await invoke(async()=>{
       const task=Promise.resolve().then(()=>options.adapter.execute(structuredClone(binding),context));inFlightExecution=task;
       try{return await task;}finally{inFlightExecution=undefined;}
     },'execute-result');
     if(!outcome||outcome.status==='unknown')throw new Stop('ACTION_UNKNOWN');
     if(outcome.status!=='executed'&&outcome.status!=='rejected')throw new Stop('ACTION_UNKNOWN');
     if(options.journal)await invoke(()=>options.journal!.acknowledge(pending,outcome.status as 'executed'|'rejected'),'journal-acknowledge');
     unresolved.delete(options.leaseKey);uncertain=false;if(outcome.status==='rejected')throw new Stop('ACTION_REJECTED');
     observation=await settle(await observe(),[...goals,...action.postconditions]);
     if(!settled(observation,[...goals,...action.postconditions])){if(executor!=='teacher'){await handoff('POSTCONDITION_UNKNOWN');continue;}throw new Stop('POSTCONDITION_UNKNOWN');}
     const lost=goals.some(id=>before.predicates[id]===true&&observation!.predicates[id]===false&&!action.mayInvalidate.includes(id));
     if(lost||!all(observation,action.postconditions)){regression=true;if(executor!=='teacher'){await handoff('POSTCONDITION_FAILED');continue;}throw new Stop('POSTCONDITION_FAILED');}
     executed=[...executed,action];
     const key=state(observation);const repeats=(seen.get(key)??0)+1;seen.set(key,repeats);
     noProgress=state(before)===key?noProgress+1:0;
     if((noProgress>=2||repeats>=2)&&!all(observation,goals)){noProgress=2;if(executor==='teacher')throw new Stop('NO_PROGRESS');}
   }
   if(result.reason==='INVALID_INPUT')result.reason='ITERATION_LIMIT';
 } catch(error) {result.status=uncertain?'UNKNOWN':'FAILED';result.reason=error instanceof Stop?error.message:'CALLBACK_FAILED';}
 finally {
   // No following session may enter while a timed-out physical input remains in flight.
   const release=()=>{if(leases.get(options.leaseKey)===owner)leases.delete(options.leaseKey);};
   if(inFlightExecution)void inFlightExecution.then(release,release);else release();
   local.abort();options.signal?.removeEventListener('abort',abort);result.elapsedMs=Math.max(0,now()-started);
 }
 if(policy==='learned'&&options.procedure) {
   result.evidencePersisted=false;let timer:ReturnType<typeof setTimeout>|undefined;
   try {
     if(now()>=deadline)throw new Stop('EVIDENCE_DEADLINE');
     result.evidencePersisted=await Promise.race([record(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Stop('EVIDENCE_DEADLINE')),Math.max(1,deadline-now()));})]);
   }catch(error){event('storage',{reason:error instanceof Stop?error.message:'EVIDENCE_WRITE_FAILED'});}finally{if(timer)clearTimeout(timer);}
 }
 result.elapsedMs=Math.max(0,now()-started);
 return result;
}
/** Explicit trusted host reconciliation. `verify` must only read authoritative current state;
 * no teacher response is accepted as verification and no planner receives this capability.
 * A late physical callback cannot clear quarantine. An in-flight action cannot be reconciled.
 */
export async function reconcileHybridSurface(options:{leaseKey:string;journal?:ExecutionJournal;verify:(pending:Readonly<PendingExecution>,context:HybridContext)=>Promise<unknown>;signal?:AbortSignal;maxDurationMs?:number}):Promise<{status:'RESOLVED'|'UNKNOWN'|'BUSY'|'CLEAR';reason:string}> {
 const duration=options.maxDurationMs??2000;
 if(!workflowIdSchema.safeParse(options.leaseKey).success||!Number.isInteger(duration)||duration<1||duration>2000)return {status:'UNKNOWN',reason:'INVALID_INPUT'};
 if(leases.has(options.leaseKey))return {status:'BUSY',reason:'LEASE_BUSY'};
 const owner=Symbol();leases.set(options.leaseKey,owner);const controller=new AbortController();const deadline=Date.now()+duration;const context=Object.freeze({signal:controller.signal,deadline});
 const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
 let timer:ReturnType<typeof setTimeout>|undefined;let rejectAbort:(()=>void)|undefined;let active=true;
 const check=()=>{if(!active||Date.now()>=deadline)throw new Error('DEADLINE');if(controller.signal.aborted)throw new Error('CANCELLED');};
 try {
   const operation=(async()=>{
     check();const stored=await options.journal?.getPending(options.leaseKey);check();
     const memory=unresolved.get(options.leaseKey);
     if(stored&&memory&&!isDeepStrictEqual(stored,memory))throw new Error('EVENT_MISMATCH');
     const pending=stored??memory;if(!pending)return {status:'CLEAR' as const,reason:'NO_PENDING_ACTION'};
     unresolved.set(options.leaseKey,pending);
     const proof:TrustedReconciliationProof=validateReconciliation(pending,await options.verify(Object.freeze(structuredClone(pending)),context));check();
     // Desktop may record an explicit unconfirmed human review. Hybrid still requires executed or not-executed.
     if(proof.verdict!=='executed'&&proof.verdict!=='not-executed')throw new Error('INVALID_RECONCILIATION');
     if(options.journal){if(!stored)throw new Error('JOURNAL_EVENT_MISSING');await options.journal.reconcile(pending,proof);check();}
     unresolved.delete(options.leaseKey);return {status:'RESOLVED' as const,reason:proof.verdict==='executed'?'ACTION_CONFIRMED':'ACTION_NOT_EXECUTED'};
   })();
   const stopped=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('DEADLINE')),Math.max(1,deadline-Date.now()));rejectAbort=()=>reject(new Error('CANCELLED'));controller.signal.addEventListener('abort',rejectAbort,{once:true});if(controller.signal.aborted)rejectAbort();});
   return await Promise.race([operation,stopped]);
 }catch(error){return {status:'UNKNOWN',reason:error instanceof Error&&['INVALID_RECONCILIATION','EVENT_MISMATCH','JOURNAL_EVENT_MISSING','DEADLINE','CANCELLED'].includes(error.message)?error.message:'RECONCILIATION_FAILED'};}
 finally{active=false;controller.abort();options.signal?.removeEventListener('abort',abort);if(rejectAbort)controller.signal.removeEventListener('abort',rejectAbort);if(timer)clearTimeout(timer);if(leases.get(options.leaseKey)===owner)leases.delete(options.leaseKey);}
}
