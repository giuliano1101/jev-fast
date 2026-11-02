/** Explicit opt-in hosted acceptance. Never imported or run by ordinary tests/CI. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {WindowsEngine} from '../../src/windows/engine.js';
import {loadWindowsConfig} from '../../src/windows/config.js';
import type {JsonObject} from '../../src/windows/network-client.js';
import {HttpToolPort,type ToolPort} from '../../src/windows/network-client.js';
import type {ActionIntent} from '../../src/windows/router.js';
import {Fault} from '../../src/core/errors.js';
import {windowsWorkbench} from '../../tests/fixtures/windows-workbench.js';
import {LocalPanel} from '../../src/windows/panel.js';
import {readonlyPreview} from './preview.js';

interface CaseResult {id:string;status:'passed'|'failed'|'not_run';elapsed_ms:number;provider?:unknown;model?:unknown;request_id?:unknown;operation_id?:unknown;usage?:unknown;code?:string;scope:string}
export async function runWindowsLive(configPath:string,reportPath:string,includeAndroid=false,includeDesktop=false,h5Root?:string){
 const config=await loadWindowsConfig(configPath),realPort=new HttpToolPort(config.endpoint);let dropNextDecisionReply=false,droppedReplies=0,recoveryQueries=0;
 const faultPort:ToolPort={call:async(name,args,signal)=>{const result=await realPort.call(name,args,signal);if(name==='jev.request_status')recoveryQueries++;if(name==='jev.choose_action'&&dropNextDecisionReply){dropNextDecisionReply=false;droppedReplies++;throw new Fault('TEST_DROPPED_DECISION_REPLY');}return result;},close:async()=>{await realPort.close();}};
 const engine=new WindowsEngine(config,faultPort),started=new Date().toISOString(),cases:CaseResult[]=[];
 await engine.initialize();let uncertain=false,site:Awaited<ReturnType<typeof windowsWorkbench>>|undefined,desktopChild:ChildProcess|undefined,preview:Awaited<ReturnType<typeof readonlyPreview>>|undefined;
 const save=async()=>{const unique=new Map(cases.filter(c=>c.request_id&&c.provider==='jev').map(c=>[c.request_id,c]));const tokens=[...unique.values()].map(c=>c.usage as {input_tokens:number;output_tokens:number}|null|undefined);await mkdir(resolve(reportPath,'..'),{recursive:true});await writeFile(reportPath,JSON.stringify({schema_version:1,scenario_version:'windows-workbench-v1',environment:process.platform,started,finished:new Date().toISOString(),executor:'real-jev-windows',passed:cases.filter(c=>c.status==='passed').length,failed:cases.filter(c=>c.status==='failed').length,not_run:cases.filter(c=>c.status==='not_run').length,uncertain,transport_fault_injections:{dropped_completed_decision_replies:droppedReplies,original_status_queries:recoveryQueries},usage:{unique_decision_requests:unique.size,known_input_tokens:tokens.reduce((sum,u)=>sum+(u?.input_tokens??0),0),known_output_tokens:tokens.reduce((sum,u)=>sum+(u?.output_tokens??0),0),requests_without_usage:tokens.filter(u=>!u).length,account_bill:null,main_codex_usage:null},cases,limits:['Synthetic local workbench with real Jev is not a live bank/tax/stream/social test.','Account bill and main Codex token usage not retrieved.','No speedup claim without a matched baseline.']},null,2)+'\n');};
 const run=async(id:string,scope:string,operation:()=>Promise<JsonObject|void>)=>{
  const start=Date.now();
  try{const result=await operation()??{};cases.push({id,scope,status:'passed',elapsed_ms:Date.now()-start,provider:result.provider,model:result.model,request_id:result.request_id,operation_id:result.operation_id,usage:result.usage});console.log(JSON.stringify({test:id,status:'passed',elapsed_ms:Date.now()-start}));await save();return result;}
  catch(error){const code=error instanceof Fault?error.code:'ACCEPTANCE_ASSERTION_FAILED';uncertain=/UNKNOWN|CONTINUATION/.test(code);cases.push({id,scope,status:'failed',elapsed_ms:Date.now()-start,code});await save();console.log(JSON.stringify({test:id,status:'failed',code,uncertain}));throw error;}
 };
 try{
  await run('real-service-ready','readiness',async()=>{await engine.network.ready();});
  site=await windowsWorkbench();const openingStarted=Date.now();let session=await engine.browserOpen(site.url,randomUUID());let target=session.session_id;
  cases.push({id:'local-browser-open',scope:'local-test-page',status:'passed',elapsed_ms:Date.now()-openingStarted,provider:session.action.provider,model:session.action.model,request_id:session.action.request_id,usage:session.action.usage});await save();
  const control=async(label:string)=>{const o=await engine.browser.observe(target),c=(o.state.controls as JsonObject[]).find(c=>String(c.label).includes(label));assert.ok(c,label);return String(c.control_id);};
  let lastIntent:ActionIntent|undefined;
  const action=async(id:string,description:string,act:JsonObject,expected:JsonObject,alternatives:Array<{id:string;description:string;action:JsonObject}>=[])=>await run(id,'local-test-page',async()=>{
   const observed=await engine.browser.observe(target),intent:ActionIntent={operation_id:randomUUID(),target,snapshot_id:observed.snapshot_id,task:description,actions:[...alternatives,{id:'correct',description,action:act}],expected};lastIntent=intent;const result=await engine.browserAct(intent);assert.equal(result.provider,'jev');assert.equal(result.verified,true);return result;
  });
  const name=await control('Test name');await action('grounded-choice-fill','Fill Test name with Alice, not Bob.',{operation:'fill',control_id:name,value:'Alice'},{control:{control_id:name,value:'Alice'}},[{id:'wrong',description:'Fill Test name with Bob',action:{operation:'fill',control_id:name,value:'Bob'}}]);
  const category=await control('Category');await action('select-option','Select category Beta.',{operation:'select',control_id:category,value:'b'},{control:{control_id:category,value:'b'}});
  await action('single-commit','Click Commit once and verify Committed 1 Alice b.',{operation:'click',control_id:await control('Commit once')},{textIncludes:'Committed 1 Alice b'});
  const committedIntent=lastIntent!;
  await run('same-id-no-replay','recovery',async()=>{const result=await engine.browserAct(committedIntent);assert.equal(result.verified,true);assert.equal(site!.committed,1);return result;});
  dropNextDecisionReply=true;await action('real-lost-decision-reply-recovery','Fill Test name with Recovered after querying the original Jev request.',{operation:'fill',control_id:await control('Test name'),value:'Recovered'},{control:{control_id:await control('Test name'),value:'Recovered'}});assert.equal(droppedReplies,1);assert.ok(recoveryQueries>=1);
  const upload=join(config.runtime,'acceptance-upload.txt');await writeFile(upload,'Synthetic Windows Jev acceptance');await action('local-file-upload','Upload the authorized acceptance file.',{operation:'upload',control_id:await control('Upload file'),paths:[upload]},{textIncludes:'Uploaded acceptance-upload.txt'});
  await action('download-file','Download the acceptance PDF once.',{operation:'click',control_id:await control('Download PDF')},{downloadCount:1});
  await run('pdf-full-parse','local-artifact',async()=>{const o=await engine.browser.observe(target),file=(o.state.downloads as JsonObject[])[0]!;const result=await engine.artifact(String(file.path));assert.equal(result.full_document_validation,true);return {bytes:result.bytes,validated:true};});
  await action('download-zip','Download the acceptance ZIP once.',{operation:'click',control_id:await control('Download ZIP')},{downloadCount:2});
  await run('zip-full-parse','local-artifact',async()=>{const o=await engine.browser.observe(target),file=(o.state.downloads as JsonObject[]).find(file=>file.name==='acceptance.zip');assert.ok(file);const result=await engine.artifact(String(file.path));assert.equal(result.full_document_validation,true);return {bytes:result.bytes,validated:true};});
  const frame=await control('Frame action');await action('iframe-control','Click Frame action inside the observed child frame.',{operation:'click',control_id:frame},{control:{control_id:frame,label:'Frame done'}});
  await action('canvas-touch','Tap the observed test canvas once.',{operation:'tap',control_id:await control('Test canvas'),x:20,y:20},{textIncludes:'Touches: 1'});
  await action('canvas-replay','Run the two authorized taps on the same observed test canvas.',{operation:'replay',control_id:await control('Test canvas'),steps:[{kind:'tap',x:30,y:30,delay_ms:10},{kind:'tap',x:40,y:40,delay_ms:10}]},{textIncludes:'Touches: 3'});
  await action('mobile-viewport','Resize only this test page to 390 by 844.',{operation:'resize',width:390,height:844},{viewport:{width:390,height:844}});
  await run('rendered-screenshot','local-render',async()=>{const image=await engine.browser.screenshot(target),bytes=await readFile(image.path);assert.equal(bytes.readUInt32BE(16),390);const diagnostics=await engine.browser.diagnostics(target);assert.equal(diagnostics.state.canvases.length,1);return {verified:true};});
  await action('popup','Open the observed popup link.',{operation:'click',control_id:await control('Open popup')},{textIncludes:'Independent popup ready'});
  await action('test-login','Visit the local test login route to set a synthetic session cookie.',{operation:'navigate',url:site.url+'/login'},{textIncludes:'Test login retained'});
  await run('persistent-test-login','local-session',async()=>{await engine.restartPrivateBrowser();session=await engine.browserOpen(site!.url+'/session',randomUUID());target=session.session_id;assert.equal((await engine.browser.verify(target,{textIncludes:'Authenticated test session'})).met,true);return session.action;});
  await run('panel-signed-action-and-receipt','local-test-panel',async()=>{const panel=new LocalPanel({id:'workbench-panel',url:site!.url,statusPath:'/api/status',actions:{ready:{method:'POST',path:'/api/action',body:{}}}}),observed=await panel.observe();const result=await engine.router.act(panel.executor(),{operation_id:randomUUID(),target:'workbench-panel',snapshot_id:observed.snapshot_id,task:'Set the isolated test control panel to ready and verify its receipt.',actions:[{id:'ready',description:'Call the preconfigured test panel action',action:{action_id:'ready'}}],expected:{statePointer:'/state',equals:'ready',receiptPointer:'/receipt',receiptEquals:'ack-'+site!.nonce}});assert.equal(result.verified,true);return result;});
  if(h5Root){
   await run('actual-h5-local-preview','actual-local-h5-build',async()=>{preview=await readonlyPreview(h5Root);const opened=await engine.browserOpen(preview.url,randomUUID());target=opened.session_id;return opened.action;});
   const observed=await engine.browser.observe(target),clicks=(observed.state.controls as JsonObject[]).filter(c=>c.tag==='button'||c.tag==='a').map(c=>({id:String(c.control_id),description:'点击实际控件：'+String(c.label),action:{operation:'click',control_id:c.control_id}}));
   await run('actual-h5-invitation-navigation','actual-local-h5-build',async()=>{assert.ok(clicks.length);const result=await engine.browserAct({operation_id:randomUUID(),target,snapshot_id:observed.snapshot_id,task:'打开婚礼邀请详情。选择页面上直接看邀请或婚礼信息的实际入口，不进入游戏、不提交祝福、不打开外部地图。',actions:clicks,expected:{urlIncludes:'#invitation'}});assert.equal(result.verified,true);return result;});
   await action('actual-h5-mobile-viewport','Resize this local H5 preview to 390 by 844.',{operation:'resize',width:390,height:844},{viewport:{width:390,height:844}});await engine.browser.screenshot(target);
  }
  if(includeDesktop){
   await run('native-window-open','native-test-window',async()=>{
    desktopChild=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-STA','-File',resolve('tests/fixtures/windows-desktop.ps1')],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    const native=await new Promise<{process_id:number;window_handle:number}>((done,reject)=>{let text='';const timer=setTimeout(()=>reject(new Fault('DESKTOP_FIXTURE_TIMEOUT')),15000);desktopChild!.stdout!.on('data',(data:Buffer)=>{text+=data.toString();if(text.includes('\n')){clearTimeout(timer);try{done(JSON.parse(text.trim()));}catch{reject(new Fault('DESKTOP_FIXTURE_INVALID'));}}});desktopChild!.once('error',()=>{clearTimeout(timer);reject(new Fault('DESKTOP_FIXTURE_UNAVAILABLE'));});});
    const attached=await engine.desktopAttach(native.process_id,native.window_handle);
    for(const operation of ['fill','commit']){
     const observed=await engine.desktop.observe(attached.target_id),controls=observed.state.controls as JsonObject[],control=controls.find(c=>c.automation_id===(operation==='fill'?'jevFixtureInput':'jevFixtureCommit'));assert.ok(control);
     await run('desktop-'+operation,'native-test-window',async()=>{const result=await engine.desktopAct({operation_id:randomUUID(),target:attached.target_id,snapshot_id:observed.snapshot_id,task:operation==='fill'?'Set the synthetic test field to Windows Jev.':'Click Commit test.',actions:[{id:'selected',description:operation==='fill'?'Fill test field with Windows Jev':'Invoke Commit test',action:operation==='fill'?{operation:'set_value',control_id:control.control_id,value:'Windows Jev'}:{operation:'invoke',control_id:control.control_id}}],expected:operation==='fill'?{control:{automation_id:'jevFixtureInput',value:'Windows Jev'}}:{nameIncludes:'Committed Windows Jev'}});assert.equal(result.verified,true);return result;});
    }
    const screenshot=await engine.desktop.screenshot(attached.target_id,config.runtime);assert.ok(screenshot.bytes>0);
    const appTarget=await engine.native.prepare(native.process_id);
    for(const phase of ['clear','type','invoke']){
     const observed=await engine.native.fresh(appTarget.target_id),elements=observed.state.elements as JsonObject[];
     const element=phase==='invoke'?elements.find(e=>e.label==='Commit test'&&(e.actions as string[]).includes('invoke')):elements.find(e=>e.role==='ControlType.Edit'&&e.settable);assert.ok(element);
     const tool=phase==='clear'?'desktop_set_value':phase==='type'?'desktop_type_text':'desktop_perform_action';
     const arguments_:JsonObject={app:native.process_id,observation_id:observed.snapshot_id,element_id:element.element_id,...(phase==='clear'?{value:''}:phase==='type'?{text:'原生 Jev'}:{action:'invoke'})};
     await run('upstream-native-'+phase,'native-test-window',async()=>{const result=await engine.nativeAct({operation_id:randomUUID(),target:appTarget.target_id,snapshot_id:observed.snapshot_id,task:phase==='clear'?'Clear only the synthetic input.':phase==='type'?'Type 原生 Jev in the observed synthetic input using the native keyboard.':'Invoke the observed Commit test button.',actions:[{id:'selected',description:'Perform the authorized native '+phase+' action on the synthetic window',action:{tool,arguments:arguments_}}],expected:phase==='invoke'?{textIncludes:'Committed 原生 Jev'}:{element:{role:'ControlType.Edit',value:phase==='clear'?'':'原生 Jev'}}});assert.equal(result.verified,true);return result;});
    }
   });
  }
  if(includeAndroid){
   await run('android-discovery-and-home','real-configured-android',async()=>{
    const directory=await engine.hostTools('android'),tools=directory.tools as Array<{name:string}>;assert.ok(tools.some(t=>t.name==='mobile_get_foreground_app'));assert.ok(tools.some(t=>t.name==='mobile_press_button'));
    const workflow_id=randomUUID();let observed:unknown;
    for(const step_id of ['read-before','home','read-after']){
     const tool=step_id==='home'?'mobile_press_button':'mobile_get_foreground_app';
     const stepStarted=Date.now();const result=await engine.hostStep({workflow_id,step_id,host:'android',task:step_id==='home'?'Press HOME once on the configured authorized Android device.':'Read the actual foreground application.',state:{previous:observed??'Directory has been discovered; read the actual foreground.'},actions:[{id:'selected',tool,arguments:step_id==='home'?{button:'HOME'}:{},description:step_id==='home'?'Press HOME':'Read actual foreground app'}]});
     observed=result.payload;if(step_id==='read-after')assert.match(JSON.stringify(observed),/launcher|com\.miui\.home|com\.huawei\.android\.launcher/i);
     const decision=result.decision as JsonObject;cases.push({id:'android-'+step_id,scope:'real-configured-android',status:'passed',elapsed_ms:Date.now()-stepStarted,provider:decision.provider,model:decision.model,request_id:result.request_id,usage:decision.usage});
    }
    return {verified:true};
   });
  }
  // Real cloud streaming and business portals require their own authorized target and posterior evidence.
  cases.push({id:'live-vidu-audio-video-rtc',scope:'production-stream',status:'not_run',elapsed_ms:0,code:'NO_LIVE_SESSION_REQUESTED'});
 }catch(error){process.exitCode=1;const code=error instanceof Fault?error.code:'ACCEPTANCE_ASSERTION_FAILED';uncertain=uncertain||/UNKNOWN|CONTINUATION/.test(code);if(cases.at(-1)?.status!=='failed')cases.push({id:'suite-interrupted',scope:'suite',status:'failed',elapsed_ms:0,code});console.log(JSON.stringify({error:code,uncertain}));}
 finally{
  if(!uncertain){desktopChild?.kill();try{await engine.release();cases.push({id:'owned-resource-cleanup',scope:'cleanup',status:'passed',elapsed_ms:0});}catch{process.exitCode=1;cases.push({id:'owned-resource-cleanup',scope:'cleanup',status:'failed',elapsed_ms:0,code:'CLEANUP_UNCONFIRMED'});}}
  await save();await site?.close();await preview?.close();await engine.close();
 }
 return {passed:cases.filter(c=>c.status==='passed').length,failed:cases.filter(c=>c.status==='failed').length,not_run:cases.filter(c=>c.status==='not_run').length,uncertain};
}
async function main(){const args=process.argv.slice(2);if(args[0]!=='--config'||!args[1]||args[2]!=='--report'||!args[3])throw new Fault('INVALID_ARGUMENTS');let h5Root:string|undefined;for(let i=4;i<args.length;i++){if(args[i]==='--h5-root'&&args[i+1])h5Root=args[++i];else if(!['--android','--desktop'].includes(args[i]!))throw new Fault('INVALID_ARGUMENTS');}console.log(JSON.stringify(await runWindowsLive(args[1],resolve(args[3]),args.includes('--android'),args.includes('--desktop'),h5Root)));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{process.stderr.write('LIVE_ACCEPTANCE_FAILED\n');process.exitCode=1;});
