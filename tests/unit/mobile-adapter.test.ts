import test from 'node:test';
import assert from 'node:assert/strict';
import {MobileTransport,type MobileElement} from '../../bench/mobile/transport.js';
import type {HybridContext,HybridObservation} from '../../bench/hybrid/controller.js';
const adapterPath='../../bench/mobile/adapter.js',catalogPath='../../bench/mobile/catalog.js';
async function api(){const adapter=await import(adapterPath).catch(()=>null),catalog=await import(catalogPath).catch(()=>null);assert.ok(adapter&&catalog,'mobile task catalog and adapter must be implemented');return {...adapter,...catalog};}
const context=():HybridContext=>({signal:new AbortController().signal,deadline:Date.now()+10000});
const node=(text:string,identifier?:string,label?:string):MobileElement=>({ref:'@e1',type:'android.widget.TextView',text,...(identifier?{identifier}:{}),...(label?{label}:{}),coordinates:{x:20,y:200,width:200,height:60}});
const nodes=(...values:MobileElement[])=>values.map((value,i)=>({...value,ref:`@e${i+1}`}));
const title=(text:string)=>node(text,'android:id/title');
const home=()=>nodes(node('搜索设置项','com.android.settings:id/animated_hint'),title('蓝牙'),title('连接与共享'));
const font=()=>nodes(node('字体与显示'),node('字体大小','com.android.settings:id/title_font_size'),node('显示大小','com.android.settings:id/display_zoom_title'),node('应用','com.android.settings:id/apply_change'));
const search=(text='')=>nodes(node(text,'com.android.settings:id/search_src_text'),node('取消','com.android.settings:id/animated_cancel_button'),...(text?[node('','com.android.settings:id/search_close_btn','清除查询'),title(text==='字体'?'字体与显示':'设备和应用通知'),node('public path','com.android.settings:id/breadcrumb')]:[]));
const browser=()=>nodes(node('Example Domain','com.heytap.browser:id/fez'));
const notification=()=>nodes(node('设备和应用通知'),node('PRIVATE EXPLANATION','com.android.settings:id/special_access_summary'),node('PRIVATE APP'));
function rig(screens:MobileElement[][]){let index=0;const calls:Array<{name:string;arguments:Record<string,unknown>}>=[];const transport=new MobileTransport({callTool:async request=>{calls.push(request);return {content:[{type:'text',text:request.name==='mobile_list_elements_on_screen'?`Found these elements on screen: ${JSON.stringify(screens[Math.min(index++,screens.length-1)]!)}`:'ok'}]};}},{device:'injected-test-device'});return {transport,calls};}

test('six research tasks contain exact ordered goals and nonrepeatable navigation actions',async()=>{
 const {MOBILE_TASKS,MOBILE_CATALOG,MOBILE_ACTION_LABELS}=await api();
 assert.equal(MOBILE_TASKS.length,6);assert.deepEqual(MOBILE_TASKS.map((task:{id:string;difficulty:string})=>[task.id,task.difficulty]),[['M1','simple'],['M2','simple'],['M3','medium'],['M4','medium'],['M5','complex'],['M6','complex']]);
 assert.deepEqual(MOBILE_TASKS[4].goalPredicates,['visited_example','task_sequence_complete','page_font_preview']);assert.deepEqual(MOBILE_TASKS[5].goalPredicates,['visited_font','task_sequence_complete','page_notification_list']);
 assert.equal(new Set(MOBILE_CATALOG.actions.map((action:{actionId:string})=>action.actionId)).size,MOBILE_CATALOG.actions.length);
 for(const action of MOBILE_CATALOG.actions){assert.equal(action.safeRepeat,false);assert.ok(MOBILE_ACTION_LABELS[action.actionId]);assert.ok(action.mayInvalidate.includes('page_font_preview'));}
 assert.equal(MOBILE_CATALOG.actions.find((action:{actionId:string})=>action.actionId==='open_bluetooth').deterministic,false);
});

test('classifies exact public structures and never exports private UI data',async()=>{
 const {classifyMobilePage,MobileHybridAdapter}=await api();
 assert.equal(classifyMobilePage(home()),'home');assert.equal(classifyMobilePage(font()),'font_preview');assert.equal(classifyMobilePage(notification()),'notification_list');
 const {transport}=rig([notification(),notification()]);const adapter=new MobileHybridAdapter(transport,'M4');const observation=await adapter.observe(context());
 assert.equal(observation.readiness,'settled');assert.equal(observation.predicates.page_notification_list,true);assert.equal(observation.predicates.page_font_preview,false);assert.doesNotMatch(JSON.stringify(observation),/PRIVATE|android|@e|EXPLANATION/);
});

test('two differing snapshots and unknown pages expose unknown current predicates and no inputs',async()=>{
 const {MobileHybridAdapter}=await api();
 for(const [screens,readiness] of [[[home(),font()],'pending'],[[nodes(node('private page')),nodes(node('private page'))],'unobservable']] as const){
  const {transport}=rig([...screens]);const adapter=new MobileHybridAdapter(transport,'M3');const observation:HybridObservation=await adapter.observe(context());assert.equal(observation.readiness,readiness);assert.deepEqual(observation.visibleActionIds,[]);assert.ok(Object.entries(observation.predicates).filter(([id])=>id.startsWith('page_')).every(([,value])=>value==='unknown'));assert.equal(await adapter.bind('open_search',observation,context()),null);
 }
});

test('wrong page and duplicate public selectors cannot bind',async()=>{
 const {MobileHybridAdapter}=await api();
 for(const screen of [font(),nodes(...home(),node('搜索设置项','com.android.settings:id/animated_hint'))]){const {transport,calls}=rig([screen,screen]);const adapter=new MobileHybridAdapter(transport,'M3');const observation=await adapter.observe(context());assert.equal(await adapter.bind('open_search',observation,context()),null);assert.equal(calls.filter(call=>call.name!=='mobile_list_elements_on_screen').length,0);}
});

test('bindings are latest-observation-only, tamper-resistant and single use',async()=>{
 const {MobileHybridAdapter}=await api();const {transport,calls}=rig([home(),home(),home(),home(),home(),home()]);const adapter=new MobileHybridAdapter(transport,'M1');const old=await adapter.observe(context());const binding=await adapter.bind('open_bluetooth',old,context());assert.ok(binding);const latest=await adapter.observe(context());assert.equal((await adapter.execute(binding,context())).status,'rejected');assert.equal(await adapter.bind('open_bluetooth',old,context()),null);
 const current=await adapter.bind('open_bluetooth',latest,context());assert.ok(current);assert.equal((await adapter.execute({...current,actionId:'open_sharing'},context())).status,'rejected');
 const again=await adapter.bind('open_bluetooth',latest,context());assert.ok(again);assert.equal((await adapter.execute(again,context())).status,'executed');assert.equal((await adapter.execute(again,context())).status,'rejected');
 const after=await adapter.observe(context());assert.equal(await adapter.bind('open_bluetooth',after,context()),null);assert.equal(calls.filter(call=>call.name==='mobile_click_on_screen_at_coordinates').length,1);assert.deepEqual(calls.find(call=>call.name==='mobile_click_on_screen_at_coordinates')?.arguments,{x:120,y:230,device:'injected-test-device'});
});

test('types only the host-fixed query into an observed empty search field',async()=>{
 const {MobileHybridAdapter}=await api();const {transport,calls}=rig([search(),search(),search('字体'),search('字体')]);const adapter=new MobileHybridAdapter(transport,'M3');const empty=await adapter.observe(context());const binding=await adapter.bind('type_font',empty,context());assert.ok(binding);assert.equal((await adapter.execute(binding,context())).status,'executed');const filled=await adapter.observe(context());assert.equal(await adapter.bind('type_font',filled,context()),null);assert.deepEqual(calls.find(call=>call.name==='mobile_type_keys')?.arguments,{text:'字体',submit:false,device:'injected-test-device'});
});

test('out-of-order complex-task page visits cannot earn action-verified milestones or completion',async()=>{
 const {MobileHybridAdapter}=await api();
 for(const task of ['M5','M6']){const {transport}=rig([browser(),browser(),font(),font(),notification(),notification()]);const adapter=new MobileHybridAdapter(transport,task);const first=await adapter.observe(context());assert.equal(first.predicates.visited_example,false);const second=await adapter.observe(context());assert.equal(second.predicates.visited_font,false);assert.equal(second.predicates.page_font_preview,true);const last=await adapter.observe(context());assert.equal(last.predicates.task_sequence_complete,false);assert.equal(last.predicates.page_font_preview,false);assert.equal(last.predicates.page_notification_list,true);}
});


test('aborted contexts issue no calls or reusable input binding',async()=>{
 const {MobileHybridAdapter}=await api();const {transport,calls}=rig([home(),home()]);const adapter=new MobileHybridAdapter(transport,'M1');const controller=new AbortController();controller.abort();const observation=await adapter.observe({signal:controller.signal,deadline:Date.now()+1000});assert.equal(observation.readiness,'unobservable');assert.equal(calls.length,0);
});

test('Bluetooth details distinguish duplicated row and heading titles using the actual Android switch ID',async()=>{
 const {classifyMobilePage}=await api();const detail=nodes(title('蓝牙'),node('关闭','android:id/switch_widget'),node('',undefined,'转到上一层级'),node('蓝牙'));assert.equal(classifyMobilePage(detail),'bluetooth');
});

test('disabled empty search input never authorizes typing',async()=>{
 const {MobileHybridAdapter}=await api();const screen=search().map(value=>value.identifier==='com.android.settings:id/search_src_text'?{...value,enabled:false}:value);const {transport}=rig([screen,screen]);const adapter=new MobileHybridAdapter(transport,'M3');const observation=await adapter.observe(context());assert.equal(await adapter.bind('type_font',observation,context()),null);
});

test('ref renumbering with unchanged semantic geometry binds the host-computed target center',async()=>{
 const {MobileHybridAdapter}=await api();const second=home().map((value,i)=>({...value,ref:`@e${i+30}`}));const {transport,calls}=rig([home(),second]);const adapter=new MobileHybridAdapter(transport,'M1');const observation=await adapter.observe(context());const binding=await adapter.bind('open_bluetooth',observation,context());assert.ok(binding);await adapter.execute(binding,context());assert.deepEqual(calls.at(-1)?.arguments,{x:120,y:230,device:'injected-test-device'});assert.doesNotMatch(JSON.stringify(observation),/coordinates|"x"|"y"|@e/);assert.doesNotMatch(JSON.stringify(binding),/coordinates|"x"|"y"|@e/);
});

test('uncertain physical input quarantines the trial without replay or further observations',async()=>{
 const {MobileHybridAdapter}=await api();let calls=0;const transport=new MobileTransport({callTool:async request=>{calls++;if(request.name!=='mobile_list_elements_on_screen')throw Error('private fault');return {content:[{type:'text',text:`Found these elements on screen: ${JSON.stringify(home())}`}]};}},{device:'test-device'});const adapter=new MobileHybridAdapter(transport,'M1');const observation=await adapter.observe(context());const binding=await adapter.bind('open_bluetooth',observation,context());assert.ok(binding);assert.equal((await adapter.execute(binding,context())).status,'unknown');assert.equal((await adapter.observe(context())).readiness,'unobservable');assert.equal(calls,3);
});

test('all six complete paths integrate with the real hybrid controller using only synthetic transport',async()=>{
 const {MobileHybridAdapter,MOBILE_TASKS}=await api();const {runHybridSession}=await import('../../bench/hybrid/controller.js');
 const bluetooth=nodes(title('蓝牙'),node('关闭','android:id/switch_widget'),node('',undefined,'转到上一层级'),node('蓝牙'));
 const sharing=nodes(node('连接与共享'),title('飞行模式'),title('USB 网络共享'));
 const special=nodes(node('特殊应用权限'),title('设备和应用通知'));
 for(const task of MOBILE_TASKS){
  let screen=home(),inputCount=0;const calls:Array<{name:string;arguments:Record<string,unknown>}>=[];
  const transport=new MobileTransport({callTool:async request=>{
   calls.push(request);
   if(request.name==='mobile_list_elements_on_screen')return {content:[{type:'text',text:`Found these elements on screen: ${JSON.stringify(screen)}`}]};
   const actionId=task.actionIds[inputCount++];
   const next:Record<string,MobileElement[]>={open_bluetooth:bluetooth,open_sharing:sharing,open_search:search(),type_font:search('字体'),select_font:font(),type_notification:search('通知'),select_notification:special,open_notification_list:notification(),open_example:browser(),resume_settings:search('字体'),restore_font:font(),back_to_font_search:search('字体'),clear_font_search:search()};
   screen=next[actionId]!;assert.ok(screen,`known action ${actionId}`);return {content:[{type:'text',text:'ok'}]};
  }},{device:'synthetic-device',maxCalls:120});
  const result=await runHybridSession({sessionId:`mobile_test_${task.id}`,leaseKey:`mobile_test_${task.id}`,scope:{applicationId:'android-settings',pageType:'home',accountScope:'a'.repeat(64),language:'zh-CN',environmentFingerprint:'b'.repeat(64),observerVersion:'mobile-v1'},goalPredicates:task.goalPredicates,catalog:task.catalog,adapter:new MobileHybridAdapter(transport,task.id),teacher:async()=>({actionIds:task.actionIds})});
  assert.equal(result.status,'SUCCEEDED',`${task.id}: ${result.reason}`);assert.equal(result.actions,task.actionIds.length);assert.equal(inputCount,task.actionIds.length);
  const inputs=calls.filter(call=>call.name!=='mobile_list_elements_on_screen');
  assert.ok(inputs.every(call=>['mobile_click_on_screen_at_coordinates','mobile_type_keys','mobile_press_button','mobile_open_url','mobile_launch_app'].includes(call.name)));
  if(task.id==='M5'){assert.deepEqual(inputs.find(call=>call.name==='mobile_open_url')?.arguments,{url:'https://www.example.com',device:'synthetic-device'});assert.deepEqual(inputs.find(call=>call.name==='mobile_launch_app')?.arguments,{packageName:'com.android.settings',device:'synthetic-device'});assert.equal(inputs.at(-1)?.name,'mobile_click_on_screen_at_coordinates');}
  if(task.id==='M6'){assert.deepEqual(inputs.filter(call=>call.name==='mobile_type_keys').map(call=>call.arguments.text),['字体','通知']);assert.deepEqual(inputs.find(call=>call.name==='mobile_press_button')?.arguments,{button:'BACK',device:'synthetic-device'});}
 }
});


test('M6 refuses skipping font search and requires executed BACK, clear and notification query in order',async()=>{
 const {MobileHybridAdapter}=await api();let screen=home();const transport=new MobileTransport({callTool:async request=>({content:[{type:'text',text:request.name==='mobile_list_elements_on_screen'?`Found these elements on screen: ${JSON.stringify(screen)}`:'ok'}]})},{device:'synthetic'});const adapter=new MobileHybridAdapter(transport,'M6');
 let observation=await adapter.observe(context());const step=async(actionId:string,next:MobileElement[])=>{const binding=await adapter.bind(actionId,observation,context());assert.ok(binding,actionId);assert.equal((await adapter.execute(binding,context())).status,'executed');screen=next;observation=await adapter.observe(context());};
 await step('open_search',search());assert.equal(await adapter.bind('type_notification',observation,context()),null);await step('type_font',search('字体'));await step('select_font',font());assert.equal(observation.predicates.visited_font,true);
 // Manually seeing a later page cannot stand in for an adapter-executed BACK or clear.
 screen=search('字体');observation=await adapter.observe(context());assert.equal(await adapter.bind('clear_font_search',observation,context()),null);
 screen=search();observation=await adapter.observe(context());assert.equal(await adapter.bind('type_notification',observation,context()),null);
 screen=notification();observation=await adapter.observe(context());assert.equal(observation.predicates.visited_font,true);assert.equal(observation.predicates.task_sequence_complete,false);
});

test('M5 requires executed resume after verified font and Example Domain, not a manual page jump',async()=>{
 const {MobileHybridAdapter}=await api();let screen=home();const transport=new MobileTransport({callTool:async request=>({content:[{type:'text',text:request.name==='mobile_list_elements_on_screen'?`Found these elements on screen: ${JSON.stringify(screen)}`:'ok'}]})},{device:'synthetic'});const adapter=new MobileHybridAdapter(transport,'M5');let observation=await adapter.observe(context());
 for(const [actionId,next] of [['open_search',search()],['type_font',search('字体')],['select_font',font()],['open_example',browser()]] as const){const binding=await adapter.bind(actionId,observation,context());assert.ok(binding);await adapter.execute(binding,context());screen=next;observation=await adapter.observe(context());}
 assert.equal(observation.predicates.visited_example,true);assert.equal(observation.predicates.page_font_preview,false);assert.equal(observation.predicates.task_sequence_complete,false);screen=font();observation=await adapter.observe(context());assert.equal(observation.predicates.page_font_preview,true);assert.equal(observation.predicates.task_sequence_complete,false);
});


test('M5 handles both confirmed Settings return branches without retrying the original font action',async()=>{
 const {MobileHybridAdapter}=await api();
 for(const restored of [true,false]){
  let screen=home();const inputs:Array<{name:string;arguments:Record<string,unknown>}>=[];const transport=new MobileTransport({callTool:async request=>{if(request.name!=='mobile_list_elements_on_screen')inputs.push(request);return {content:[{type:'text',text:request.name==='mobile_list_elements_on_screen'?`Found these elements on screen: ${JSON.stringify(screen)}`:'ok'}]};}},{device:'synthetic'});const adapter=new MobileHybridAdapter(transport,'M5');let observation=await adapter.observe(context());
  const step=async(actionId:string,next:MobileElement[])=>{const binding=await adapter.bind(actionId,observation,context());assert.ok(binding,actionId);assert.equal((await adapter.execute(binding,context())).status,'executed');screen=next;observation=await adapter.observe(context());};
  for(const [actionId,next] of [['open_search',search()],['type_font',search('字体')],['select_font',font()],['open_example',browser()]] as const)await step(actionId,next);
  assert.equal(observation.predicates.settings_returned,false);await step('resume_settings',restored?font():search('字体'));assert.equal(observation.predicates.settings_returned,true);
  if(restored){assert.equal(observation.predicates.task_sequence_complete,true);assert.equal(observation.predicates.page_font_preview,true);assert.equal(inputs.length,5);}
  else{assert.equal(observation.predicates.page_search_font,true);assert.equal(observation.predicates.page_font_preview,false);assert.equal(observation.predicates.task_sequence_complete,false);assert.equal(await adapter.bind('select_font',observation,context()),null);assert.ok(observation.visibleActionIds.includes('restore_font'));await step('restore_font',font());assert.equal(observation.predicates.task_sequence_complete,true);assert.equal(observation.predicates.page_font_preview,true);assert.equal(inputs.length,6);}
  screen=browser();observation=await adapter.observe(context());assert.equal(observation.predicates.settings_returned,false);assert.equal(observation.predicates.page_font_preview,false);
 }
});


test('changed target geometry across snapshots is pending and cannot bind or click',async()=>{
 const {MobileHybridAdapter}=await api();
 for(const patch of [{x:50},{y:240},{width:240},{height:100}]){const changed=home().map(value=>value.text==='蓝牙'?{...value,coordinates:{...value.coordinates,...patch}}:value);const {transport,calls}=rig([home(),changed]);const adapter=new MobileHybridAdapter(transport,'M1');const observation=await adapter.observe(context());assert.equal(observation.readiness,'pending');assert.equal(observation.predicates.page_home,'unknown');assert.deepEqual(observation.visibleActionIds,[]);assert.equal(await adapter.bind('open_bluetooth',observation,context()),null);assert.equal(calls.filter(call=>call.name==='mobile_click_on_screen_at_coordinates').length,0);}
});

test('invalid or invisible click rectangles never become actionable bindings',async()=>{
 const {MobileHybridAdapter}=await api();
 for(const patch of [{x:-1},{y:95},{width:0},{height:0},{width:.5},{height:.5},{x:100000},{y:100000},{width:100001},{height:100001},{x:Infinity},{y:NaN}]){const screen=home().map(value=>value.text==='蓝牙'?{...value,coordinates:{...value.coordinates,...patch}}:value);const {transport,calls}=rig([screen,screen]);const adapter=new MobileHybridAdapter(transport,'M1');const observation=await adapter.observe(context());assert.ok(!observation.visibleActionIds.includes('open_bluetooth'));assert.equal(await adapter.bind('open_bluetooth',observation,context()),null);assert.equal(calls.filter(call=>call.name==='mobile_click_on_screen_at_coordinates').length,0);}
});

test('geometry becomes actionable after two agreeing observations with no retry of an input',async()=>{
 const {MobileHybridAdapter}=await api();const shifted=home().map(value=>value.text==='蓝牙'?{...value,coordinates:{x:222,y:314,width:240,height:65}}:value);const {transport,calls}=rig([home(),shifted,shifted,shifted]);const adapter=new MobileHybridAdapter(transport,'M1');assert.equal((await adapter.observe(context())).readiness,'pending');const observation=await adapter.observe(context());assert.equal(observation.readiness,'settled');const binding=await adapter.bind('open_bluetooth',observation,context());assert.ok(binding);assert.deepEqual((await adapter.execute(binding,context())),{status:'executed'});assert.deepEqual(calls.at(-1)?.arguments,{x:342,y:346,device:'injected-test-device'});assert.equal(calls.filter(call=>call.name==='mobile_click_on_screen_at_coordinates').length,1);
});
