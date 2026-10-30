import test from 'node:test';
import assert from 'node:assert/strict';

const modulePath='../../bench/mobile/transport.js';
async function api(){const module=await import(modulePath).catch(()=>null);assert.ok(module,'mobile transport must be implemented');return module as typeof import('../../bench/mobile/transport.js');}
const response=(text='ok')=>({content:[{type:'text',text}]});
const element=(ref='@e1',label='Search',y=200)=>({ref,type:'android.widget.Button',label,coordinates:{x:1,y,width:100,height:50}});
const elementsResponse=(nodes:unknown[])=>response(`Found these elements on screen: ${JSON.stringify(nodes)}`);

test('parses pinned JSON elements, strips unused private fields and filters the status bar',async()=>{
 const {parseMobileElements}=await api();
 const nodes=parseMobileElements(elementsResponse([element('@e0','private notification',95),{...element(),name:'private account',focused:true},element('@e2','Boundary',96)]));
 assert.deepEqual(nodes,[element(),element('@e2','Boundary',96)]);
 assert.equal(parseMobileElements(elementsResponse([element('@e0','visible',50)]),{statusBarHeight:0}).length,1);
});
test('rejects malformed observations, duplicated refs and tool errors without echoing raw data',async()=>{
 const {parseMobileElements}=await api();
 for(const raw of [response('private secret'),response('Found these elements on screen: invalid private secret'),elementsResponse([{...element(),coordinates:{x:1,y:200}}]),elementsResponse([element(),element()]),{...elementsResponse([]),isError:true},elementsResponse([{...element(),ref:'private secret'}])]){
  assert.throws(()=>parseMobileElements(raw),error=>error instanceof Error&&error.message==='INVALID_MOBILE_ELEMENTS');
 }
});
test('public projection uses only exact host allowlisted labels and identifiers',async()=>{
 const {parseMobileElements,projectPublicObservation}=await api();
 const nodes=parseMobileElements(elementsResponse([element(),{...element('@e2','Private person'),identifier:'public_search_id'},element('@e3','Search now'),element('@e4','PRIVATE EMAIL')]));
 const result=projectPublicObservation(nodes,[{actionId:'open_search',label:'Search'},{actionId:'focus_query',identifier:'public_search_id'},{actionId:'missing',label:'Not present'}]);
 assert.deepEqual(result.public,{candidates:['open_search','focus_query']});
 assert.deepEqual(result.hostLocalBindings,{open_search:'@e1',focus_query:'@e2'});
 assert.doesNotMatch(JSON.stringify(result),/Private|PRIVATE|EMAIL|public_search_id|Search/);
 assert.doesNotMatch(JSON.stringify(result),/hostLocalBindings|@e/);
});
test('Android text plus identifier disambiguates reused public accessibility identifiers',async()=>{
 const {projectPublicObservation}=await api();
 const nodes=[{...element('@e1'),label:undefined,text:'蓝牙',identifier:'android:id/title'},{...element('@e2'),label:undefined,text:'网络',identifier:'android:id/title'}];
 const projection=projectPublicObservation(nodes,[{actionId:'open_bluetooth',text:'蓝牙',identifier:'android:id/title'}]);
 assert.deepEqual(projection.public,{candidates:['open_bluetooth']});assert.deepEqual(projection.hostLocalBindings,{open_bluetooth:'@e1'});
 assert.throws(()=>projectPublicObservation(nodes,[{actionId:'open_bluetooth',identifier:'android:id/title'}]),/AMBIGUOUS_PUBLIC_BINDING/);
 assert.doesNotMatch(JSON.stringify(projection),/蓝牙|网络|android|@e/);
});
test('public projection refuses ambiguous matches, duplicate IDs and shared bindings',async()=>{
 const {projectPublicObservation}=await api();
 assert.throws(()=>projectPublicObservation([element(),element('@e2')],[{actionId:'search',label:'Search'}]),/AMBIGUOUS_PUBLIC_BINDING/);
 assert.throws(()=>projectPublicObservation([element()],[{actionId:'search',label:'Search'},{actionId:'search',label:'Other'}]),/INVALID_PUBLIC_MAPPING/);
 assert.throws(()=>projectPublicObservation([element()],[{actionId:'search',label:'Search'},{actionId:'other',label:'Search'}]),/AMBIGUOUS_PUBLIC_BINDING/);
 assert.deepEqual(projectPublicObservation([{...element(),text:'Search',label:undefined}], [{actionId:'search',label:'Search'}]).public,{candidates:[]});
});
test('strict allowlist rejects unknown tools, extraneous args, unsafe buttons, urls and paths before dispatch',async()=>{
 const {MobileTransport}=await api();let calls=0;
 const transport=new MobileTransport({callTool:async()=>{calls++;return response();}},{device:'test-device',screenshotDirectory:'/tmp/mobile-output'});
 const invalid:Array<[string,unknown]>=[['mobile_clipboard',{}],['mobile_press_button',{button:'VOLUME_UP'}],['mobile_press_button',{button:'BACK',device:'other'}],['mobile_click_on_screen_at_coordinates',{x:1}],['mobile_click_on_screen_at_coordinates',{ref:'@e1',x:1}],['mobile_type_keys',{text:'hi',submit:'false'}],['mobile_open_url',{url:'javascript:alert(1)'}],['mobile_save_screenshot',{saveTo:'/tmp/mobile-output/../private.png'}],['mobile_swipe_on_screen',{direction:'up',distance:-1}],['mobile_list_elements_on_screen',{format:'text'}]];
 for(const [name,args] of invalid){assert.equal((await transport.call(name as never,args as never)).code,'INVALID_MOBILE_CALL');}
 assert.equal(calls,0);
});
test('serializes calls, injects configured device and keeps raw response out of serialization',async()=>{
 const {MobileTransport}=await api();let release:((value:unknown)=>void)|undefined;const dispatched:unknown[]=[];
 const transport=new MobileTransport({callTool:async request=>{dispatched.push(request);if(dispatched.length===1)return new Promise(resolve=>{release=resolve;});return response('private account');}},{device:'configured-device'});
 const first=transport.call('mobile_press_button',{button:'BACK'});const second=transport.call('mobile_list_elements_on_screen',{});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(dispatched.length,1);release!(response());await first;const result=await second;
 assert.deepEqual(dispatched,[{name:'mobile_press_button',arguments:{button:'BACK',device:'configured-device'}},{name:'mobile_list_elements_on_screen',arguments:{format:'json',device:'configured-device'}}]);
 assert.equal(result.status,'succeeded');assert.deepEqual(result.hostLocalResult,response('private account'));assert.doesNotMatch(JSON.stringify(result),/private|account/);
});
test('timeout is uncertain, never retries and blocks queued calls until settled plus host reconciliation',async()=>{
 const {MobileTransport}=await api();let release:((value:unknown)=>void)|undefined;let calls=0;
 const transport=new MobileTransport({callTool:async()=>{calls++;if(calls===1)return new Promise(resolve=>{release=resolve;});return response();}},{device:'test-device',timeoutMs:15});
 const first=transport.call('mobile_press_button',{button:'BACK'});const second=transport.call('mobile_press_button',{button:'HOME'});
 const unknown=await first;assert.equal(unknown.status,'uncertain');assert.equal(unknown.code,'MOBILE_OPERATION_TIMEOUT');assert.equal((await second).status,'blocked');assert.equal(calls,1);
 assert.equal(transport.reconcileFromHost({operationId:unknown.operationId,stateVerified:true}),false);
 release!(response());await new Promise(resolve=>setImmediate(resolve));assert.equal((await transport.call('mobile_press_button',{button:'HOME'})).status,'blocked');
 assert.equal(transport.reconcileFromHost({operationId:999,stateVerified:true}),false);
 assert.equal(transport.reconcileFromHost({operationId:unknown.operationId,stateVerified:true}),true);
 assert.equal((await transport.call('mobile_press_button',{button:'HOME'})).status,'succeeded');assert.equal(calls,2);
});
test('transport rejection and malformed post-dispatch response fail closed with sanitized errors',async()=>{
 const {MobileTransport}=await api();
 for(const callTool of [async()=>{throw Error('private account');},async()=>({private:'secret'}),async()=>({content:[{type:'text',text:17}]}),async()=>({...response('secret'),isError:true})]){
  const transport=new MobileTransport({callTool},{device:'test-device'});const result=await transport.call('mobile_press_button',{button:'BACK'});
  assert.equal(result.status,'uncertain');assert.doesNotMatch(JSON.stringify(result),/private|secret|account/);assert.equal((await transport.call('mobile_press_button',{button:'BACK'})).status,'blocked');
 }
});
test('observation timeout also blocks navigation because outstanding RPC completion is unknown',async()=>{
 const {MobileTransport}=await api();let calls=0;
 const transport=new MobileTransport({callTool:async()=>{calls++;return new Promise(()=>{});}},{device:'test-device',timeoutMs:10});
 assert.equal((await transport.call('mobile_get_foreground_app',{})).status,'uncertain');
 assert.equal((await transport.call('mobile_press_button',{button:'BACK'})).status,'blocked');assert.equal(calls,1);
});
test('valid pinned tool arguments dispatch and device inventory has no injected device',async()=>{
 const {MobileTransport}=await api();const requests:Array<{name:string;arguments:Record<string,unknown>}>=[];
 const transport=new MobileTransport({callTool:async request=>{requests.push(request);return response();}},{device:'test-device',screenshotDirectory:'/tmp/mobile-output'});
 await transport.call('mobile_list_available_devices',{});
 await transport.call('mobile_list_apps',{});
 await transport.call('mobile_get_screen_size',{});
 await transport.call('mobile_launch_app',{packageName:'com.example.app'});
 await transport.call('mobile_click_on_screen_at_coordinates',{ref:'@e12'});
 await transport.call('mobile_open_url',{url:'https://example.com/'});
 await transport.call('mobile_type_keys',{text:'public fixture',submit:false});
 await transport.call('mobile_swipe_on_screen',{direction:'up',x:10,y:200,distance:100});
 await transport.call('mobile_save_screenshot',{saveTo:'/tmp/mobile-output/evidence.png',maxSize:1024});
 assert.equal(requests.length,9);assert.deepEqual(requests[0]?.arguments,{});assert.ok(requests.slice(1).every(request=>request.arguments.device==='test-device'));
});
test('invalid transport limits fail before any call',async()=>{
 const {MobileTransport}=await api();const client={callTool:async()=>response()};
 for(const options of [{device:''},{device:'test',timeoutMs:45001},{device:'test',maxPending:33},{device:'test',maxCalls:501}])assert.throws(()=>new MobileTransport(client,options),/INVALID_MOBILE_OPTIONS/);
});
test('queue and total dispatch budgets are bounded',async()=>{
 const {MobileTransport}=await api();let release:((value:unknown)=>void)|undefined;
 const transport=new MobileTransport({callTool:async()=>new Promise(resolve=>{release=resolve;})},{device:'test-device',maxPending:1,maxCalls:1});
 const first=transport.call('mobile_press_button',{button:'BACK'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await transport.call('mobile_press_button',{button:'BACK'})).code,'MOBILE_QUEUE_LIMIT');release!(response());await first;
 assert.equal((await transport.call('mobile_press_button',{button:'BACK'})).code,'MOBILE_CALL_LIMIT');
});


test('click transport accepts exactly a ref or bounded integer x/y and rejects mixed or extra fields',async()=>{
 const {MobileTransport}=await api();const calls:Array<{name:string;arguments:Record<string,unknown>}>=[];const transport=new MobileTransport({callTool:async request=>{calls.push(request);return response();}},{device:'test-device'});
 assert.equal((await transport.call('mobile_click_on_screen_at_coordinates',{ref:'@e42'})).status,'succeeded');
 assert.equal((await transport.call('mobile_click_on_screen_at_coordinates',{x:342,y:346} as never)).status,'succeeded');
 assert.equal((await transport.call('mobile_click_on_screen_at_coordinates',{x:0,y:100000} as never)).status,'succeeded');
 for(const args of [{},{x:1},{y:2},{x:1,y:2,ref:'@e1'},{x:1,y:2,label:'public'},{x:1,y:2,device:'other'},{x:-1,y:2},{x:1,y:-2},{x:100001,y:2},{x:1,y:100001},{x:NaN,y:2},{x:1,y:Infinity},{x:1.5,y:2},{x:'1',y:2},{ref:'@e1',y:2}])assert.equal((await transport.call('mobile_click_on_screen_at_coordinates',args as never)).code,'INVALID_MOBILE_CALL');
 assert.deepEqual(calls.map(value=>value.arguments),[{ref:'@e42',device:'test-device'},{x:342,y:346,device:'test-device'},{x:0,y:100000,device:'test-device'}]);
});
