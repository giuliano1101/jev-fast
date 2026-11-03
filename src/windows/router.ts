import {canonicalDigest} from '../remote/protocol.js';
import {Fault,ExecutionNotStarted} from '../core/errors.js';
import {PrivateStore} from './store.js';
import {JevNetworkClient,type JsonObject} from './network-client.js';
import {choiceArgsSchema} from '../choice/contracts.js';
import {choiceResponseSchema} from '../remote/choice.js';
import {validatePublicDecision} from '../local/cloud.js';

export interface Candidate {id:string;description:string;action:JsonObject}
export interface Observation {snapshot_id:string;state:JsonObject;candidates?:Candidate[]}
export interface Executor {
 name:string;resource:string;
 observe(target:string,snapshot?:string):Promise<Observation>;
 validate(target:string,snapshot:string,action:JsonObject):Promise<void>;
 execute(target:string,action:JsonObject,signal?:AbortSignal):Promise<unknown>;
 verify(target:string,expected:JsonObject,result:unknown):Promise<{met:boolean;state:unknown}>;
}
export interface ActionIntent {operation_id:string;target:string;snapshot_id:string;task:string;actions:Candidate[];expected:JsonObject}
interface ActionRecord {digest:string;executor:string;resource:string;phase:'deciding'|'selected'|'executing'|'executed'|'verified'|'rejected'|'unknown';intent:ActionIntent;request_id:string;selected_id?:string;decision?:JsonObject;result?:unknown;verification?:unknown;code?:string;started:number;elapsed_ms?:number}
export function routeCapability(input:{capability:string;environment:'windows'|'remote'|'android';registered:string[]}){
 const name=input.capability==='browser'?(input.environment==='windows'?'windows-browser':input.environment==='remote'?'remote-browser':undefined):input.capability==='desktop'&&input.environment==='windows'?'windows-desktop':input.capability==='mobile'&&input.environment==='android'?'android':undefined;
 return name&&input.registered.includes(name)?{route:'jev',executor:name}:{route:'codex',reason:'NO_EXECUTOR_FOR_TARGET_ENVIRONMENT'};
}
export class ActionRouter {
 constructor(readonly store:PrivateStore,readonly network:JevNetworkClient,readonly resources:PrivateStore=store){}
 async act(executor:Executor,input:ActionIntent,signal?:AbortSignal){
  if(signal?.aborted)throw new Fault('CANCELLED_BEFORE_INPUT');
  const intent=JSON.parse(JSON.stringify(input)) as ActionIntent;
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(intent.operation_id)||!intent.actions.length||new Set(intent.actions.map(a=>a.id)).size!==intent.actions.length)throw new Fault('INVALID_ACTION_INTENT');
  const key='action-'+intent.operation_id,digest=canonicalDigest({executor:executor.name,intent});
  const release=await this.resources.lease(executor.resource);
  try{
   let record=await this.store.read<ActionRecord>(key);
   if(record&&record.digest!==digest)throw new Fault('OPERATION_ID_CONFLICT');
   if(record?.phase==='verified'||record?.phase==='executed')return this.report(record);
   if(record?.phase==='rejected')throw new Fault(record.code??'ACTION_REJECTED');
   if(record?.phase==='executing'||record?.phase==='unknown')throw new Fault('LOCAL_ACTION_UNKNOWN_NO_REPLAY');
   const quarantine='quarantine-'+canonicalDigest(executor.resource);
   if(await this.resources.read(quarantine))throw new Fault('RESOURCE_OUTCOME_UNKNOWN');
   if(!record){
    for(const candidate of intent.actions)await executor.validate(intent.target,intent.snapshot_id,candidate.action);
    record={digest,executor:executor.name,resource:executor.resource,phase:'deciding',intent,request_id:intent.operation_id+'-decision',started:Date.now()};await this.store.write(key,record);
   }
   if(record.phase==='deciding'){
    const observation=await executor.observe(intent.target,intent.snapshot_id);
    if(observation.snapshot_id!==intent.snapshot_id)throw new Fault('STALE_SNAPSHOT');
    const params=choiceArgsSchema.parse({idempotency_key:intent.operation_id,task:intent.task,state:{...observation.state,candidate_actions:intent.actions.map(a=>({id:a.id,action:a.action}))},actions:intent.actions.map(a=>({id:a.id,description:a.description}))});
    const parsed=choiceResponseSchema.safeParse(await this.network.request(record.request_id,'jev.choose_action',params,signal));
    if(!parsed.success)throw new Fault('INVALID_JEV_DECISION');
    try{validatePublicDecision(parsed.data,params);}catch{throw new Fault('JEV_DECISION_BINDING_MISMATCH');}
    const value=parsed.data as unknown as JsonObject;
    record.decision=value;record.selected_id=value.selected_id as string;record.phase='selected';await this.store.write(key,record);
   }
   const selected=intent.actions.find(a=>a.id===record.selected_id);if(!selected)throw new Fault('INVALID_JEV_DECISION');
   if(signal?.aborted){record.phase='rejected';record.code='CANCELLED_BEFORE_INPUT';await this.store.write(key,record);throw new Fault(record.code);}
   // A cached decision is not a grant to execute after an operator has turned this connection off.
   await this.network.ready();
   try{await executor.validate(intent.target,intent.snapshot_id,selected.action);}catch(error){record.phase='rejected';record.code=error instanceof Fault?error.code:'PREFLIGHT_REJECTED';await this.store.write(key,record);throw error;}
   if(signal?.aborted){record.phase='rejected';record.code='CANCELLED_BEFORE_INPUT';await this.store.write(key,record);throw new Fault(record.code);}
   await this.resources.write(quarantine,{operation_id:intent.operation_id,target:intent.target});
   record.phase='executing';await this.store.write(key,record);
   try{record.result=await executor.execute(intent.target,selected.action,signal);record.phase='executed';await this.store.write(key,record);await this.resources.remove(quarantine);}
   catch(error){
    if(error instanceof ExecutionNotStarted){record.phase='rejected';record.code=error.code;await this.store.write(key,record);await this.resources.remove(quarantine);throw error;}
    record.phase='unknown';record.code='LOCAL_ACTION_UNKNOWN_NO_REPLAY';await this.store.write(key,record);throw new Fault(record.code);
   }
   return await this.verify(executor,record);
  }finally{await release();}
 }
 async inspect(operationId:string){const record=await this.store.read<ActionRecord>('action-'+operationId);if(!record)throw new Fault('LOCAL_ACTION_NOT_FOUND');return this.report(record);}
 async verifyKnown(executor:Executor,operationId:string){
  const release=await this.resources.lease(executor.resource);
  try{const record=await this.store.read<ActionRecord>('action-'+operationId);if(!record)throw new Fault('LOCAL_ACTION_NOT_FOUND');if(record.executor!==executor.name||record.resource!==executor.resource)throw new Fault('EXECUTOR_BINDING_MISMATCH');if(record.phase!=='executed'&&record.phase!=='verified')throw new Fault('LOCAL_ACTION_UNKNOWN_NO_REPLAY');return await this.verify(executor,record);}finally{await release();}
 }
 private async verify(executor:Executor,record:ActionRecord){
  try{const verification=await executor.verify(record.intent.target,record.intent.expected,record.result);record.verification=verification;record.phase=verification.met?'verified':'executed';}
  catch{record.verification={met:false,code:'VERIFICATION_UNAVAILABLE'};record.phase='executed';}
  record.elapsed_ms??=Date.now()-record.started;await this.store.write('action-'+record.intent.operation_id,record);return this.report(record);
 }
 private report(record:ActionRecord){
  return {operation_id:record.intent.operation_id,request_id:record.request_id,target:record.intent.target,executor:record.executor,phase:record.phase,execution:record.phase==='verified'||record.phase==='executed'?'executed':record.phase==='unknown'||record.phase==='executing'?'unknown':'not_executed',verified:record.phase==='verified',selected_id:record.selected_id,provider:record.decision?.provider,model:record.decision?.model,usage:record.decision?.usage,result:record.result,verification:record.verification,code:record.code,elapsed_ms:record.elapsed_ms};
 }
}
