import {offlineWindowsChoice} from '../fixtures/windows-choice.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrivateStore} from '../../src/windows/store.js';
import {JevNetworkClient,type ToolPort,type JsonObject} from '../../src/windows/network-client.js';
import {ActionRouter,routeCapability,type Executor,type ActionIntent} from '../../src/windows/router.js';
import {HostWorkflow,type HostStep} from '../../src/windows/host-workflow.js';

async function fixture(handler:(name:string,args:JsonObject)=>Promise<unknown>){
 const root=await mkdtemp(join(tmpdir(),'jev-windows-recovery-')),store=new PrivateStore(join(root,'journal'));await store.initialize();
 const port:ToolPort={call:handler,close:async()=>{}};
 const network=new JevNetworkClient(store,port,1,50);
 return {store,network,router:new ActionRouter(store,network),async close(){await store.close();await rm(root,{recursive:true,force:true});}};
}
const ready={enabled:true,connector_online:true,local_ready:true,continuation_supported:true,continuation_token:'private-test-continuation'};
const completed=(id:unknown,result:unknown)=>({request_id:id,delivery_status:'COMPLETED',reply:{ok:true,result}});

test('Windows router only selects an executor for the actual target environment',()=>{
 assert.equal(routeCapability({capability:'browser',environment:'windows',registered:['remote-browser']}).route,'codex');
 assert.deepEqual(routeCapability({capability:'browser',environment:'windows',registered:['windows-browser']}),{route:'jev',executor:'windows-browser'});
 assert.equal(routeCapability({capability:'shell',environment:'windows',registered:['windows-desktop']}).route,'codex');
 assert.equal(routeCapability({capability:'desktop',environment:'remote',registered:['windows-desktop']}).route,'codex');
 assert.equal(routeCapability({capability:'browser',environment:'android',registered:['remote-browser']}).route,'codex');
 assert.equal(routeCapability({capability:'mobile',environment:'windows',registered:['android']}).route,'codex');
});
test('lost submit response queries original request, persists continuation and never replays after reopening',async()=>{
 let submissions=0,queries=0;
 const f=await fixture(async(name,args)=>{
  if(name==='jev.network_status')return ready;
  assert.equal(args.continuation_token,ready.continuation_token);
  if(name==='jev.choose_action'){submissions++;throw Error('response lost');}
  queries++;return queries===1?{request_id:args.request_id,delivery_status:'DISPATCHED'}:completed(args.request_id,{selected_id:'one'});
 });
 try{
  assert.deepEqual(await f.network.request('stable','jev.choose_action',{}),{selected_id:'one'});
  const reopened=new JevNetworkClient(f.store,{call:async()=>{throw Error('must use cached outcome');},close:async()=>{}});
  assert.deepEqual(await reopened.request('stable','jev.choose_action',{}),{selected_id:'one'});
  assert.equal(submissions,1);assert.equal(queries,2);
  await assert.rejects(reopened.request('stable','jev.choose_action',{changed:true}),/REQUEST_ID_CONFLICT/);
 }finally{await f.close();}
});
test('invalid continuation and missing delivery retain uncertainty across process recovery',async()=>{
 let submitted=0,statusCalls=0;
 const f=await fixture(async(name)=>{if(name==='jev.network_status'){statusCalls++;return ready;}if(name==='jev.choose_action'){submitted++;throw Error('invalid continuation');}throw Error('request not found');});
 try{
  await assert.rejects(f.network.request('original','jev.choose_action',{}),/NETWORK_OUTCOME_UNKNOWN/);
  await assert.rejects(f.network.request('original','jev.choose_action',{}),/NETWORK_OUTCOME_UNKNOWN/);
  await assert.rejects(f.network.release(),/UNRESOLVED_REQUEST_CONTEXT_RETAINED/);
  assert.equal(submitted,1);assert.equal(statusCalls,1);
 }finally{await f.close();}
});
test('operator off prevents dispatch and never silently falls back',async()=>{
 let calls=0;const f=await fixture(async name=>{calls++;assert.equal(name,'jev.network_status');return {...ready,enabled:false};});
 try{await assert.rejects(f.network.request('stopped','jev.choose_action',{}),/JEV_NOT_READY_OPERATOR_STATE/);assert.equal(calls,1);assert.equal(await f.store.read('request-stopped'),undefined);}finally{await f.close();}
});
function executor(overrides:Partial<Executor>={}){
 let executions=0;let met=true;const e:Executor={name:'windows-browser',resource:'browser-session-one',observe:async()=>({snapshot_id:'snapshot',state:{visible:'test'}}),validate:async()=>{},execute:async()=>{executions++;return {clicked:true};},verify:async()=>({met,state:{done:met}}),...overrides};
 return {e,get executions(){return executions;},setMet(value:boolean){met=value;}};
}
const intent:ActionIntent={operation_id:'intent-one',target:'session',snapshot_id:'snapshot',task:'Complete authorized test',actions:[{id:'click',description:'Click the visible button',action:{operation:'click'}}],expected:{text:'done'}};
const decisions=async(name:string,args:JsonObject)=>name==='jev.network_status'?ready:completed(args.request_id,offlineWindowsChoice(args.params,'click'));
test('a completed but unverified action is never replayed and can be verified with a fresh read',async()=>{
 const f=await fixture(decisions),x=executor();x.setMet(false);
 try{
  const first=await f.router.act(x.e,intent);assert.equal(first.execution,'executed');assert.equal(first.verified,false);
  const second=await f.router.act(x.e,intent);assert.equal(second.verified,false);assert.equal(x.executions,1);
  x.setMet(true);assert.equal((await f.router.verifyKnown(x.e,intent.operation_id)).verified,true);assert.equal(x.executions,1);
 }finally{await f.close();}
});
test('lost physical acknowledgement quarantines the resource, including attempts with new keys',async()=>{
 const f=await fixture(decisions);let physical=0;const x=executor({execute:async()=>{physical++;throw Error('after physical click');}});
 try{
  await assert.rejects(f.router.act(x.e,intent),/LOCAL_ACTION_UNKNOWN_NO_REPLAY/);
  await assert.rejects(f.router.act(x.e,intent),/LOCAL_ACTION_UNKNOWN_NO_REPLAY/);
  await assert.rejects(f.router.act(x.e,{...intent,operation_id:'different-key'}),/RESOURCE_OUTCOME_UNKNOWN/);
  assert.equal((await f.router.inspect(intent.operation_id)).execution,'unknown');assert.equal(physical,1);
 }finally{await f.close();}
});
test('changing the snapshot after a decision prevents physical execution',async()=>{
 const f=await fixture(decisions);let validations=0;
 const x=executor({validate:async()=>{if(++validations===2)throw Error('page changed');}});
 try{await assert.rejects(f.router.act(x.e,intent),/page changed/);assert.equal(x.executions,0);assert.equal((await f.router.inspect(intent.operation_id)).phase,'rejected');}finally{await f.close();}
});
test('a durable executing record after a crash cannot become a second physical operation',async()=>{
 const f=await fixture(decisions),x=executor();
 try{
  await f.router.act(x.e,intent);
  const record=await f.store.read<Record<string,unknown>>('action-'+intent.operation_id);assert.ok(record);record.phase='executing';await f.store.write('action-'+intent.operation_id,record);
  await assert.rejects(new ActionRouter(f.store,f.network).act(x.e,intent),/LOCAL_ACTION_UNKNOWN_NO_REPLAY/);assert.equal(x.executions,1);
 }finally{await f.close();}
});
test('mutating caller candidates during the decision cannot change the authorized physical action',async()=>{
 let entered:()=>void=()=>{},finish:()=>void=()=>{};const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{finish=r;});
 const f=await fixture(async(name,args)=>{if(name==='jev.network_status')return ready;entered();await gate;return await decisions(name,args);});
 let executed:unknown;const x=executor({execute:async(_target,action)=>{executed=action;return {done:true};}}),mutable=structuredClone(intent);
 try{const pending=f.router.act(x.e,mutable);await started;mutable.actions[0]!.action.operation='unauthorized-change';finish();await pending;assert.deepEqual(executed,{operation:'click'});}finally{await f.close();}
});
test('verification cannot be rebound to another physical executor',async()=>{
 const f=await fixture(decisions),x=executor();try{await f.router.act(x.e,intent);await assert.rejects(f.router.verifyKnown({...x.e,resource:'another-session'},intent.operation_id),/EXECUTOR_BINDING_MISMATCH/);}finally{await f.close();}
});
test('named host steps retain unknown effects and isolate workflow progress',async()=>{
 let calls=0;const f=await fixture(async(name,args)=>{if(name==='jev.network_status')return ready;calls++;return completed(args.request_id,{decision:{provider:'jev',model:'jev-1.14.0'},execution:'unknown',selected_id:'home',result:{content:[]}});});
 const host=new HostWorkflow(f.store,f.network),step:HostStep={workflow_id:'workflow-one',step_id:'home',host:'android',task:'Authorized test HOME',state:{foreground:'observed'},actions:[{id:'home',tool:'mobile_press_button',arguments:{button:'HOME'},description:'Press HOME'}]};
 try{await assert.rejects(host.step(step),/HOST_ACTION_UNKNOWN/);await assert.rejects(host.step(step),/HOST_ACTION_UNKNOWN/);await assert.rejects(host.step({...step,step_id:'new-key'}),/HOST_OUTCOME_UNKNOWN/);assert.equal(calls,1);assert.equal((await host.progress('workflow-one')).steps.length,1);assert.equal((await host.progress('unrelated')).steps.length,0);}finally{await f.close();}
});
test('mobile workflow prevents a requested media volume above the existing five percent limit',async()=>{
 const f=await fixture(async()=>{throw Error('must reject before remote call');});try{await assert.rejects(new HostWorkflow(f.store,f.network).step({workflow_id:'volume',step_id:'set',host:'android',task:'Volume check',state:{},actions:[{id:'volume',tool:'mobile_set_media_volume',arguments:{percent:6},description:'Set volume'}]}),/MEDIA_VOLUME_LIMIT/);}finally{await f.close();}
});
test('volume-up cannot bypass the limit directly or inside nested actual mobile batches',async()=>{
 const f=await fixture(async()=>{throw Error('must reject before remote call');}),host=new HostWorkflow(f.store,f.network);
 const up={name:'mobile_press_button',arguments:{button:'VOLUME_UP'}},batch={name:'mobile_batch_commands',arguments:{steps:[up]}};
 try{for(const action of [up,batch,{name:'mobile_batch_commands',arguments:{steps:[batch]}}])await assert.rejects(host.step({workflow_id:'volume-guard',step_id:action===up?'direct':action===batch?'batch':'nested',host:'android',task:'Check that volume increase is refused',state:{},actions:[{id:'volume',tool:action.name,arguments:action.arguments,description:'Attempt a forbidden volume increase'}]}),/MEDIA_VOLUME_LIMIT/);}finally{await f.close();}
});
test('cancelling while Jev decides retains its result but prevents local input',async()=>{
 const abort=new AbortController();const f=await fixture(async(name,args)=>{if(name==='jev.network_status')return ready;const result=await decisions(name,args);abort.abort();return result;});const x=executor();
 try{await assert.rejects(f.router.act(x.e,intent,abort.signal),/CANCELLED_BEFORE_INPUT/);assert.equal(x.executions,0);assert.equal((await f.router.inspect(intent.operation_id)).execution,'not_executed');}finally{await f.close();}
});
test('operator off after the decision prevents local input even when that decision was valid',async()=>{
 let statuses=0;const f=await fixture(async(name,args)=>name==='jev.network_status'?{...ready,enabled:++statuses===1}:await decisions(name,args));const x=executor();
 try{await assert.rejects(f.router.act(x.e,intent),/JEV_NOT_READY_OPERATOR_STATE/);assert.equal(x.executions,0);assert.equal((await f.router.inspect(intent.operation_id)).phase,'selected');}finally{await f.close();}
});
test('a structurally signed decision for different request content cannot authorize local input',async()=>{
 const f=await fixture(async(name,args)=>name==='jev.network_status'?ready:completed(args.request_id,offlineWindowsChoice({...args.params as JsonObject,task:'another task'},'click')));const x=executor();
 try{await assert.rejects(f.router.act(x.e,intent),/JEV_DECISION_BINDING_MISMATCH/);assert.equal(x.executions,0);}finally{await f.close();}
});
test('fresh verification failure cannot retain an earlier verified success flag',async()=>{
 const f=await fixture(decisions),x=executor();try{assert.equal((await f.router.act(x.e,intent)).verified,true);x.setMet(false);const result=await f.router.verifyKnown(x.e,intent.operation_id);assert.equal(result.execution,'executed');assert.equal(result.verified,false);assert.equal(x.executions,1);}finally{await f.close();}
});

test('an uncertain host step reconciles only its original request while new steps remain quarantined',async()=>{
 let submissions=0,queries=0,available=false;
 const f=await fixture(async(name,args)=>{
  if(name==='jev.network_status')return ready;
  if(name==='jev.host_act'){submissions++;throw Error('lost original response');}
  assert.equal(name,'jev.request_status');queries++;if(!available)throw Error('query temporarily unavailable');
  return completed(args.request_id,{decision:{provider:'jev'},execution:'executed',selected_id:'home',result:{content:[{type:'text',text:'{"foreground":"launcher"}'}]}});
 });
 const host=new HostWorkflow(f.store,f.network),step:HostStep={workflow_id:'recovery-flow',step_id:'home',host:'android',task:'Return the test phone home',state:{observed:true},actions:[{id:'home',tool:'mobile_press_button',arguments:{button:'HOME'},description:'Go home'}]};
 try{
  await assert.rejects(host.step(step),/NETWORK_OUTCOME_UNKNOWN/);
  await assert.rejects(host.step({...step,step_id:'new-home'}),/HOST_OUTCOME_UNKNOWN/);
  available=true;assert.equal((await host.step(step)).execution,'executed');
  assert.equal((await host.step(step)).execution,'executed');assert.equal(submissions,1);assert.equal(queries,2);
  assert.equal((await host.progress(step.workflow_id)).steps[0]?.phase,'executed');
 }finally{await f.close();}
});

test('operator off before a host step creates no phantom resource quarantine',async()=>{
 const f=await fixture(async name=>{assert.equal(name,'jev.network_status');return {...ready,enabled:false};}),host=new HostWorkflow(f.store,f.network);
 try{
  await assert.rejects(host.step({workflow_id:'stopped',step_id:'home',host:'android',task:'Authorized test',state:{},actions:[{id:'home',tool:'mobile_press_button',arguments:{button:'HOME'},description:'Go home'}]}),/JEV_NOT_READY_OPERATOR_STATE/);
  assert.deepEqual(await f.store.keys('host-quarantine-'),[]);assert.deepEqual((await host.progress('stopped')).steps,[]);
 }finally{await f.close();}
});
