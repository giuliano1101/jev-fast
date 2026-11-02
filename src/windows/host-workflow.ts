import {z} from 'zod';
import {Fault} from '../core/errors.js';
import {canonicalDigest} from '../remote/protocol.js';
import {JevNetworkClient,type JsonObject} from './network-client.js';
import {PrivateStore} from './store.js';

const readTools=new Set(['mobile_get_foreground_app','mobile_list_elements_on_screen','mobile_take_screenshot','mobile_list_apps','mobile_list_available_devices','mobile_get_screen_size','mobile_get_orientation','mobile_get_media_volume']);
function checkMediaVolume(tool:string,args:JsonObject,depth=0){
 if(tool==='mobile_press_button'&&String(args.button).toUpperCase()==='VOLUME_UP')throw new Fault('MEDIA_VOLUME_LIMIT');
 if(tool==='mobile_set_media_volume'){
  const value=args.volume??args.percent;if(typeof value!=='number'||value<0||value>5)throw new Fault('MEDIA_VOLUME_LIMIT');
 }
 if(tool==='mobile_batch_commands'){
  if(depth>=16||!Array.isArray(args.steps))throw new Fault('INVALID_HOST_BATCH');
  for(const item of args.steps){if(!item||typeof item!=='object'||typeof item.name!=='string'||!item.arguments||typeof item.arguments!=='object'||Array.isArray(item.arguments))throw new Fault('INVALID_HOST_BATCH');checkMediaVolume(item.name,item.arguments,depth+1);}
 }
}
export const hostStepSchema=z.strictObject({
 workflow_id:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),step_id:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),host:z.string().min(1),task:z.string().min(1),state:z.record(z.string(),z.unknown()),
 actions:z.array(z.strictObject({id:z.string().min(1),tool:z.string().min(1),arguments:z.record(z.string(),z.unknown()),description:z.string().min(1)})).min(1),
});
export type HostStep=z.infer<typeof hostStepSchema>;
export function hostPayload(result:JsonObject){
 const backend=result.result as {content?:Array<{type:string;text?:string}>}|undefined;
 return (backend?.content??[]).filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text??'') as unknown;}catch{return c.text;}});
}
export class HostWorkflow {
 constructor(readonly store:PrivateStore,readonly network:JevNetworkClient,readonly resources:PrivateStore=store){}
 async tools(host:string,requestId:string){return await this.network.request(requestId,'jev.host_tools',{host}) as JsonObject;}
 async step(raw:HostStep,signal?:AbortSignal){
  if(signal?.aborted)throw new Fault('CANCELLED_BEFORE_DISPATCH');
  const input=hostStepSchema.parse(raw),digest=canonicalDigest(input),key='host-step-'+canonicalDigest({workflow:input.workflow_id,step:input.step_id});
  const request_id='host-'+canonicalDigest({workflow:input.workflow_id,step:input.step_id}).replace('sha256:','');
  const release=await this.resources.lease('host-'+input.host);
  try{
   const previous=await this.store.read<{digest:string;phase:string;result?:JsonObject}>(key);
   if(previous&&previous.digest!==digest)throw new Fault('WORKFLOW_STEP_CONFLICT');
   if(previous?.phase==='unknown')throw new Fault('HOST_ACTION_UNKNOWN');
   if(previous?.result)return previous.result;
   const readOnly=input.actions.every(a=>readTools.has(a.tool));
   const isolation=await this.resources.read<{workflow_id:string;step_id:string;request_id:string}>('host-quarantine-'+canonicalDigest(input.host));
   // Only the same immutable step may reconcile its original remote request. New keys stay blocked.
   if(!readOnly&&isolation&&(!previous||isolation.workflow_id!==input.workflow_id||isolation.step_id!==input.step_id||isolation.request_id!==request_id))throw new Fault('HOST_OUTCOME_UNKNOWN');
   for(const action of input.actions)checkMediaVolume(action.tool,action.arguments);
   if(!previous)await this.network.ready();
   await this.store.write(key,{digest,request_id,workflow_id:input.workflow_id,step_id:input.step_id,phase:'submitted'});
   if(!readOnly)await this.resources.write('host-quarantine-'+canonicalDigest(input.host),{workflow_id:input.workflow_id,step_id:input.step_id,request_id});
   const result=await this.network.request(request_id,'jev.host_act',{host:input.host,idempotency_key:request_id,task:input.task,state:input.state,actions:input.actions},signal) as JsonObject;
   if((result.decision as JsonObject|undefined)?.provider!=='jev')throw new Fault('INVALID_JEV_DECISION');
   if(result.execution!=='executed'){await this.store.write(key,{digest,request_id,workflow_id:input.workflow_id,step_id:input.step_id,phase:'unknown',result});throw new Fault('HOST_ACTION_UNKNOWN');}
   if(!readOnly)await this.resources.remove('host-quarantine-'+canonicalDigest(input.host));
   const report={request_id,execution:'executed',verified:false,decision:result.decision,selected_id:result.selected_id,result:result.result,payload:hostPayload(result),note:'Read a fresh host state to verify the task postcondition; execution is not completion.'};
   await this.store.write(key,{digest,request_id,workflow_id:input.workflow_id,step_id:input.step_id,phase:'executed',result:report});return report;
  }finally{await release();}
 }
 async progress(workflowId:string){
  const items=[];
  for(const key of await this.store.keys('host-step-')){const r=await this.store.read<{workflow_id:string;step_id:string;request_id:string;phase:string;result?:JsonObject}>(key);if(r?.workflow_id===workflowId)items.push({step_id:r.step_id,request_id:r.request_id,phase:r.phase,execution:r.result?.execution});}
  return {workflow_id:workflowId,steps:items,note:'Request ids identify immutable steps; do not use a new workflow id to replay an uncertain action.'};
 }
}
