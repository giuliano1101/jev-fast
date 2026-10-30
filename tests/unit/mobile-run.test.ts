import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MobileTransport,type MobileElement} from '../../bench/mobile/transport.js';
import type {ExecutionJournal,PendingExecution} from '../../bench/hybrid/execution-journal.js';
const runnerPath='../../bench/mobile/run.js';
async function api(){const module=await import(runnerPath).catch(()=>null);assert.ok(module,'mobile host runner must be implemented');return module;}
const scope={applicationId:'android-settings',pageType:'home',accountScope:'a'.repeat(64),language:'zh-CN',environmentFingerprint:'b'.repeat(64),observerVersion:'mobile-v1'};
function journal():ExecutionJournal {let pending:PendingExecution|undefined;return {getPending:async()=>pending,begin:async value=>{pending=value;},acknowledge:async()=>{pending=undefined;},reconcile:async()=>{throw Error('NO_AUTO_RECONCILIATION');}};}
function node(text:string,identifier?:string,label?:string):MobileElement{return {ref:'@e1',type:'android.widget.TextView',text,...(identifier?{identifier}:{}),...(label?{label}:{}),coordinates:{x:20,y:200,width:200,height:60}};}
const nodes=(...values:MobileElement[])=>values.map((v,i)=>({...v,ref:`@e${i+1}`}));
const home=()=>nodes(node('搜索设置项','com.android.settings:id/animated_hint'),node('蓝牙','android:id/title'),node('连接与共享','android:id/title'));
const bluetooth=()=>nodes(node('蓝牙','android:id/title'),node('','android:id/switch_widget'),node('',undefined,'转到上一层级'));
function rig(start=home()){let screen=start;const calls:string[]=[];const transport=new MobileTransport({callTool:async req=>{calls.push(req.name);if(req.name!=='mobile_list_elements_on_screen')screen=bluetooth();return {content:[{type:'text',text:req.name==='mobile_list_elements_on_screen'?`Found these elements on screen: ${JSON.stringify(screen)}`:'ok'}]};}},{device:'SECRET_DEVICE'});return {transport,calls};}
const base=()=>({journal:journal(),taskId:'M1',trialId:'synthetic_1',scope,mode:'teacher-plan',teacher:async()=>({actionIds:['open_bluetooth']})});

test('teacher plan is explicitly a host smoke test with real journaled actions',async()=>{
 const {runMobileTrial}=await api();const r=rig();const report=await runMobileTrial({...base(),transport:r.transport});
 assert.equal(report.label,'host-plan-smoke-not-jev');assert.equal(report.result.status,'SUCCEEDED');assert.equal(report.result.actions,1);assert.equal(report.result.executors.teacher,1);assert.equal(report.accounting.request_count,0);assert.ok(!JSON.stringify(report).includes('SECRET_DEVICE'));
});
test('wrong starting page cannot be a zero-action successful trial',async()=>{
 const {runMobileTrial}=await api();const r=rig(bluetooth());const report=await runMobileTrial({...base(),transport:r.transport});
 assert.equal(report.result.reason,'RESET_REJECTED');assert.equal(report.result.status,'FAILED');assert.equal(report.result.actions,0);assert.ok(r.calls.every(name=>name==='mobile_list_elements_on_screen'));
});
test('missing journal and missing or expired authorization reject before UI',async()=>{
 const {runMobileTrial}=await api();
 for(const overrides of [{journal:undefined},{mode:'jev',provider:undefined},{mode:'jev',provider:{key:'key',authorization:{approval_id:'test',public_controls_only:true,expires_at:1},reserve:()=>{}}}]){
  const r=rig();await assert.rejects(()=>runMobileTrial({...base(),transport:r.transport,...overrides}));assert.equal(r.calls.length,0);
 }
});
test('Jev accounting stays out of the strict controller choice response',async()=>{
 const {runMobileTrial}=await api();const r=rig();let reservations=0;
 const report=await runMobileTrial({...base(),transport:r.transport,mode:'jev',teacher:undefined,provider:{key:'secret-key',authorization:{approval_id:'test',public_controls_only:true,expires_at:Date.now()+60000},reserve:()=>{reservations++;},transport:async()=>new Response(JSON.stringify({model:'jev-1.14.0',answers:{action:{type:'choice',choice:'open_bluetooth',confidence:.99}},usage:{input_tokens:100,output_tokens:0}}))}});
 assert.equal(report.result.status,'SUCCEEDED');assert.equal(report.result.executors.jev,1);assert.equal(report.result.teacherHandoffs,0);assert.equal(report.accounting.request_count,1);assert.equal(reservations,1);assert.equal(report.providerEvents[0].status,'decided');assert.deepEqual(report.providerEvents[0].usage,{input_tokens:100,output_tokens:0});assert.ok(!JSON.stringify(report).includes('secret-key'));
});
test('provider errors retain conservative accounting without private messages',async()=>{
 const {runMobileTrial}=await api();const r=rig();const report=await runMobileTrial({...base(),transport:r.transport,mode:'jev',teacher:undefined,provider:{key:'secret-key',authorization:{approval_id:'test',public_controls_only:true,expires_at:Date.now()+60000},reserve:()=>{},transport:async()=>{throw Error('SECRET_PROVIDER');}}});
 assert.equal(report.result.status,'FAILED');assert.equal(report.result.actions,0);assert.equal(report.accounting.request_count,1);assert.equal(report.accounting.unknown_usage_requests,1);assert.equal(report.providerEvents[0].code,'PROVIDER_TRANSPORT_ERROR');assert.ok(!JSON.stringify(report).includes('SECRET_PROVIDER'));
});
test('CLI expired authorization and absent ledger reject before connection',async()=>{
 const {runMobileCli}=await api();const root=await mkdtemp(join(tmpdir(),'mobile-run-'));const config=join(root,'config.json'),approval=join(root,'approval.json');
 await writeFile(config,JSON.stringify({serverCommand:'unused',serverArgs:[],device:'SECRET_DEVICE',runtimeDirectory:join(root,'runtime'),scope}),{mode:0o600});
 await writeFile(approval,JSON.stringify({approval_id:'test',public_controls_only:true,expires_at:1}),{mode:0o600});let connects=0;
 await assert.rejects(()=>runMobileCli(['--config',config,'--task','M1','--trial','test','--mode','jev','--approval-file',approval,'--key-file',join(root,'missing-key'),'--budget-dir',join(root,'missing-budget'),'--output',join(root,'report.json')],{connect:async()=>{connects++;throw Error('MUST_NOT_CONNECT');}}));
 assert.equal(connects,0);await assert.rejects(()=>readFile(join(root,'missing-budget','budget.json')));
});

test('home preflight followed by externally reached goal cannot count as trial success',async()=>{
 const {runMobileTrial}=await api();let reads=0;const transport=new MobileTransport({callTool:async()=>({content:[{type:'text',text:`Found these elements on screen: ${JSON.stringify(++reads<=2?home():bluetooth())}`}]})},{device:'synthetic'});
 const report=await runMobileTrial({...base(),transport});assert.equal(report.result.status,'FAILED');assert.equal(report.result.reason,'NO_ACTION_TRIAL');
});
test('existing-only budget never initializes missing state and preserves reservation count',async()=>{
 const {RequestBudget}=await import('../../bench/live/access.js');
 const existing=(RequestBudget as unknown as {openExisting?:(directory:string,options:{maxUsd:number;maxRequests:number;expiresAt:number})=>ReturnType<typeof RequestBudget.open>}).openExisting;
 assert.equal(typeof existing,'function','RequestBudget needs a noncreating existing-only entrypoint');
 const root=await mkdtemp(join(tmpdir(),'mobile-existing-budget-')),options={maxUsd:2,maxRequests:200,expiresAt:Date.now()+60000};
 const missing=join(root,'missing');assert.throws(()=>existing!(missing,options));await assert.rejects(()=>readFile(join(missing,'budget.json')));
 const empty=join(root,'empty');const {mkdir}=await import('node:fs/promises');await mkdir(empty,{mode:0o700});assert.throws(()=>existing!(empty,options));await assert.rejects(()=>readFile(join(empty,'budget.json')));
 const dir=join(root,'existing');const first=RequestBudget.open(dir,options);first.reserve();first.reserve();first.close();
 const next=existing!(dir,options);assert.equal(next.summary().requests,2);next.close();
});
test('CLI executes supplied host plan and closes connection while writing only a public report',async()=>{
 const {runMobileCli}=await api();const root=await mkdtemp(join(tmpdir(),'mobile-cli-host-'));const config=join(root,'config.json'),plan=join(root,'plan.json'),output=join(root,'report.json');
 await writeFile(config,JSON.stringify({serverCommand:'host-command',serverArgs:[],device:'SECRET_DEVICE',runtimeDirectory:join(root,'runtime'),scope}),{mode:0o600});await writeFile(plan,JSON.stringify(['open_bluetooth']),{mode:0o600});let closed=0,screen=home();
 const report=await runMobileCli(['--config',config,'--task','M1','--trial','host1','--mode','teacher-plan','--plan',plan,'--output',output],{connect:async()=>({client:{callTool:async(req:{name:string})=>{if(req.name!=='mobile_list_elements_on_screen')screen=bluetooth();return {content:[{type:'text',text:req.name==='mobile_list_elements_on_screen'?`Found these elements on screen: ${JSON.stringify(screen)}`:'ok'}]};}},close:async()=>{closed++;}})});
 assert.equal(closed,1);assert.equal(report.result.status,'SUCCEEDED');const saved=await readFile(output,'utf8');assert.ok(!saved.includes('SECRET_DEVICE'));assert.ok(!saved.includes('host-command'));assert.ok(saved.includes('host-plan-smoke-not-jev'));
});

test('CLI unwritable output rejects before connecting the host',async()=>{
 const {runMobileCli}=await api();const root=await mkdtemp(join(tmpdir(),'mobile-cli-output-'));const config=join(root,'config.json'),plan=join(root,'plan.json');
 await writeFile(config,JSON.stringify({serverCommand:'unused',serverArgs:[],device:'SECRET_DEVICE',runtimeDirectory:join(root,'runtime'),scope}),{mode:0o600});await writeFile(plan,JSON.stringify(['open_bluetooth']),{mode:0o600});let closed=0,screen=home();
 await assert.rejects(()=>runMobileCli(['--config',config,'--task','M1','--trial','output1','--mode','teacher-plan','--plan',plan,'--output',join(root,'absent','report.json')],{connect:async()=>({client:{callTool:async(req:{name:string})=>{if(req.name!=='mobile_list_elements_on_screen')screen=bluetooth();return {content:[{type:'text',text:req.name==='mobile_list_elements_on_screen'?`Found these elements on screen: ${JSON.stringify(screen)}`:'ok'}]};}},close:async()=>{closed++;}})}));
 assert.equal(closed,0);await assert.rejects(()=>readFile(join(root,'runtime','journal','owner.lock')));
});

test('existing output rejects before connecting and is never overwritten',async()=>{
 const {runMobileCli}=await api();const root=await mkdtemp(join(tmpdir(),'mobile-cli-existing-'));const config=join(root,'config.json'),plan=join(root,'plan.json'),output=join(root,'report.json');
 await writeFile(config,JSON.stringify({serverCommand:'unused',serverArgs:[],device:'SECRET_DEVICE',runtimeDirectory:join(root,'runtime'),scope}),{mode:0o600});await writeFile(plan,JSON.stringify(['open_bluetooth']),{mode:0o600});await writeFile(output,'original evidence',{mode:0o600});let connections=0;
 await assert.rejects(()=>runMobileCli(['--config',config,'--task','M1','--trial','existing','--mode','teacher-plan','--plan',plan,'--output',output],{connect:async()=>{connections++;throw Error('MUST_NOT_CONNECT');}}));
 assert.equal(connections,0);assert.equal(await readFile(output,'utf8'),'original evidence');
});
test('output is durably reserved before connection and changed ownership prevents replacement',async()=>{
 const {runMobileCli}=await api();const root=await mkdtemp(join(tmpdir(),'mobile-cli-reserve-'));const config=join(root,'config.json'),plan=join(root,'plan.json'),output=join(root,'report.json');
 await writeFile(config,JSON.stringify({serverCommand:'unused',serverArgs:[],device:'SECRET_DEVICE',runtimeDirectory:join(root,'runtime'),scope}),{mode:0o600});await writeFile(plan,JSON.stringify(['open_bluetooth']),{mode:0o600});let closed=0;
 await assert.rejects(()=>runMobileCli(['--config',config,'--task','M1','--trial','reserved','--mode','teacher-plan','--plan',plan,'--output',output],{connect:async()=>{
  const marker=JSON.parse(await readFile(output,'utf8'));assert.equal(marker.status,'PREFLIGHT_NOT_COMPLETED');assert.equal(marker.trialId,'reserved');
  const {rename}=await import('node:fs/promises');await rename(output,join(root,'retained-placeholder.json'));await writeFile(output,'replacement evidence',{mode:0o600});
  return {client:{callTool:async()=>({content:[{type:'text',text:`Found these elements on screen: ${JSON.stringify(bluetooth())}`}]})},close:async()=>{closed++;}};
 }}));
 assert.equal(closed,1);assert.equal(await readFile(output,'utf8'),'replacement evidence');
});

test('Jev approval expiry stops physical input even after a valid provider decision',async()=>{
 const {runMobileTrial}=await api();let reads=0,inputs=0;
 const transport=new MobileTransport({callTool:async(req)=>{
  if(req.name==='mobile_list_elements_on_screen'){if(++reads===5)await new Promise(resolve=>setTimeout(resolve,150));}
  else inputs++;
  return {content:[{type:'text',text:req.name==='mobile_list_elements_on_screen'?`Found these elements on screen: ${JSON.stringify(inputs?bluetooth():home())}`:'ok'}]};
 }},{device:'synthetic'});
 const report=await runMobileTrial({...base(),transport,mode:'jev',teacher:undefined,provider:{key:'secret-key',authorization:{approval_id:'expiring',public_controls_only:true,expires_at:Date.now()+100},reserve:()=>{},transport:async()=>new Response(JSON.stringify({model:'jev-1.14.0',answers:{action:{type:'choice',choice:'open_bluetooth',confidence:.99}}}))}});
 assert.notEqual(report.result.status,'SUCCEEDED');assert.equal(inputs,0);assert.equal(report.accounting.request_count,1);
});

test('mobile settle barrier waits for slow verified browser observation before returning to Settings',async()=>{
 const {runMobileTrial}=await api();
 const search=(text='')=>nodes(node(text,'com.android.settings:id/search_src_text'),node('取消','com.android.settings:id/animated_cancel_button'),...(text?[node('字体与显示','android:id/title'),node('public path','com.android.settings:id/breadcrumb')]:[]));
 const font=()=>nodes(node('字体与显示'),node('字体大小','com.android.settings:id/title_font_size'),node('显示大小','com.android.settings:id/display_zoom_title'),node('应用','com.android.settings:id/apply_change'));
 const browser=()=>nodes(node('Example Domain','com.heytap.browser:id/fez'));
 const plan=['open_search','type_font','select_font','open_example','resume_settings','restore_font'];
 let screen=home(),inputs=0,browserReads=0,openingBrowser=false;
 const transport=new MobileTransport({callTool:async req=>{
  if(req.name==='mobile_list_elements_on_screen'){
   if(openingBrowser){browserReads++;if(browserReads<=2)screen=[];else{if(browserReads<=4)await new Promise(resolve=>setTimeout(resolve,1100));screen=browser();}}
   return {content:[{type:'text',text:`Found these elements on screen: ${JSON.stringify(screen)}`}]};
  }
  const action=plan[inputs++];
  if(action==='resume_settings'){assert.ok(browserReads>=4,'cannot return until two slow browser snapshots verify the page');openingBrowser=false;}
  if(action==='open_example')openingBrowser=true;
  const next:Record<string,MobileElement[]>={open_search:search(),type_font:search('字体'),select_font:font(),open_example:[],resume_settings:search('字体'),restore_font:font()};screen=next[action!]!;
  return {content:[{type:'text',text:'ok'}]};
 }},{device:'synthetic',maxCalls:120});
 const report=await runMobileTrial({...base(),taskId:'M5',trialId:'slow_browser',transport,teacher:async()=>({actionIds:plan})});
 assert.equal(report.result.status,'SUCCEEDED',report.result.reason);assert.equal(inputs,6);assert.ok(report.result.elapsedMs>=2200);
 assert.equal(report.preflight_ms,report.elapsed_ms-report.result.elapsedMs);assert.match(report.measurement_note,/result.elapsedMs/);assert.match(report.measurement_note,/SDK connection/);
});
test('durable unknown survives journal reopen and prevents all subsequent UI calls',async()=>{
 const {runMobileTrial}=await api();const {FileExecutionJournal}=await import('../../bench/hybrid/execution-journal.js');const directory=await mkdtemp(join(tmpdir(),'mobile-unknown-'));
 const first=await FileExecutionJournal.open(directory);const transport=new MobileTransport({callTool:async(req)=>{if(req.name!=='mobile_list_elements_on_screen')throw Error('PRIVATE_ACTION_FAULT');return {content:[{type:'text',text:`Found these elements on screen: ${JSON.stringify(home())}`}]};}},{device:'SECRET_DEVICE'});
 const report=await runMobileTrial({...base(),transport,journal:first});assert.equal(report.result.status,'UNKNOWN');assert.equal(report.result.actions,1);assert.ok(!JSON.stringify(report).includes('PRIVATE_ACTION_FAULT'));await first.close();
 const reopened=await FileExecutionJournal.open(directory);const r=rig();try{const blocked=await runMobileTrial({...base(),trialId:'another_trial',transport:r.transport,journal:reopened});assert.equal(blocked.result.status,'UNKNOWN');assert.equal(blocked.result.reason,'SURFACE_QUARANTINED');assert.equal(r.calls.length,0);}finally{await reopened.close();}
});
