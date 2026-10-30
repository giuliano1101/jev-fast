import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {HybridAdapter,HybridBinding,HybridContext,HybridObservation} from '../hybrid/controller.js';
import {getMobileTask,MOBILE_CURRENT_PREDICATES,type MobileTask} from './catalog.js';
import {parseMobileElements,projectPublicObservation,type MobileElement,type MobileTransport,type MobileToolName,type PublicMobileMapping} from './transport.js';

export type MobilePage='home'|'bluetooth'|'sharing'|'search_empty'|'search_font'|'search_notification'|'font_preview'|'special_permissions'|'notification_list'|'browser_example'|'unknown';
type Selector=Pick<PublicMobileMapping,'text'|'label'|'identifier'>;
const id=(name:string)=>`com.android.settings:id/${name}`;
const selectors={
 open_bluetooth:{text:'蓝牙',identifier:'android:id/title'},
 open_sharing:{text:'连接与共享',identifier:'android:id/title'},
 open_search:{text:'搜索设置项',identifier:id('animated_hint')},
 select_font:{text:'字体与显示',identifier:'android:id/title'},
 restore_font:{text:'字体与显示',identifier:'android:id/title'},
 select_notification:{text:'设备和应用通知',identifier:'android:id/title'},
 open_notification_list:{text:'设备和应用通知',identifier:'android:id/title'},
 clear_font_search:{identifier:id('search_close_btn'),label:'清除查询'},
} satisfies Record<string,Selector>;
const matching=(elements:readonly MobileElement[],selector:Selector)=>elements.filter(element=>(selector.text===undefined||element.text===selector.text)&&(selector.label===undefined||element.label===selector.label)&&(selector.identifier===undefined||element.identifier===selector.identifier));
const exactly=(elements:readonly MobileElement[],selector:Selector)=>matching(elements,selector).length===1;
/** Pure classifier: it emits only fixed public page IDs, never any UI text or inventory. */
export function classifyMobilePage(elements:readonly MobileElement[]):MobilePage {
 if(new Set(elements.map(element=>element.ref)).size!==elements.length)return 'unknown';
 const has=(selector:Selector)=>exactly(elements,selector);const pages:MobilePage[]=[];
 if(has(selectors.open_search)&&has(selectors.open_bluetooth)&&has(selectors.open_sharing))pages.push('home');
 if(has({text:'蓝牙',identifier:'android:id/title'})&&has({identifier:'android:id/switch_widget'})&&has({label:'转到上一层级'}))pages.push('bluetooth');
 if(has({text:'连接与共享'})&&has({text:'飞行模式'})&&has({text:'USB 网络共享'}))pages.push('sharing');
 const field=matching(elements,{identifier:id('search_src_text')});
 if(field.length===1&&field[0]!.enabled!==false&&has({identifier:id('animated_cancel_button')})){
  const query=field[0]!.text??'';
  if(query==='')pages.push('search_empty');
  if(query==='字体'&&has(selectors.select_font)&&elements.some(element=>element.identifier===id('breadcrumb')))pages.push('search_font');
  if(query==='通知'&&has(selectors.select_notification)&&elements.some(element=>element.identifier===id('breadcrumb')))pages.push('search_notification');
 }
 if(has({text:'字体与显示'})&&has({identifier:id('title_font_size')})&&has({identifier:id('display_zoom_title')})&&has({identifier:id('apply_change')}))pages.push('font_preview');
 if(has({text:'特殊应用权限'})&&has(selectors.open_notification_list))pages.push('special_permissions');
 if(has({text:'设备和应用通知'})&&has({identifier:id('special_access_summary')}))pages.push('notification_list');
 if(has({text:'Example Domain',identifier:'com.heytap.browser:id/fez'}))pages.push('browser_example');
 return pages.length===1?pages[0]!:'unknown';
}
const sourcePages:Record<string,MobilePage>={open_bluetooth:'home',open_sharing:'home',open_search:'home',type_font:'search_empty',type_notification:'search_empty',select_font:'search_font',select_notification:'search_notification',open_notification_list:'special_permissions',open_example:'font_preview',resume_settings:'browser_example',restore_font:'search_font',back_to_font_search:'font_preview',clear_font_search:'search_font'};
interface HostPoint {x:number;y:number}
interface Snapshot {page:MobilePage;bindings:Record<string,HostPoint>;visible:string[];signature:string}
interface Bound {value:HybridBinding;point?:HostPoint}
function controlCenter(rect:MobileElement['coordinates']):HostPoint|undefined {
 const {x,y,width,height}=rect;
 if(![x,y,width,height].every(Number.isFinite)||x<0||y<96||width<1||height<1||x+width>100000||y+height>100000)return undefined;
 const point={x:Math.floor(x+width/2),y:Math.floor(y+height/2)};
 return point.x>=x&&point.x<x+width&&point.y>=y&&point.y<y+height?point:undefined;
}
export interface MobileToolTiming {tool:string;durationMs:number;status:string}
/** One adapter instance represents one trial and owns no device discovery or connection. */
export class MobileHybridAdapter implements HybridAdapter {
 private readonly task:MobileTask;
 private latest:HybridObservation|undefined;
 private snapshot:Snapshot|undefined;
 private bound:Bound|undefined;
 private readonly attempted=new Set<string>();
 private visitedFont=false;
 private visitedExample=false;
 private settingsReturnVerified=false;
 private sequence=0;
 private verifiedSteps=0;
 private sequenceStarted=false;
 private sequenceBroken=false;
 private pendingAction:string|undefined;
 private observing=false;
 private executing=false;
 private quarantined=false;
 readonly toolTimings:MobileToolTiming[]=[];
 constructor(private readonly transport:Pick<MobileTransport,'call'>,taskId:string){this.task=getMobileTask(taskId);}
 private orderedActionAllowed(actionId:string){
  if(this.task.id!=='M5'&&this.task.id!=='M6')return true;
  return this.sequenceStarted&&!this.sequenceBroken&&this.pendingAction===undefined&&(!this.task.actionIds.includes(actionId)||this.task.actionIds[this.verifiedSteps]===actionId);
 }
 private verifyOrderedResult(page:MobilePage){
  if(!this.sequenceStarted&&page==='home'&&this.verifiedSteps===0&&!this.pendingAction)this.sequenceStarted=true;
  if(!this.sequenceStarted||this.sequenceBroken||!this.pendingAction||this.pendingAction!==this.task.actionIds[this.verifiedSteps])return;
  const action=this.task.catalog.actions.find(value=>value.actionId===this.pendingAction);
  const resultPages=action?.postconditions.filter(predicate=>predicate.startsWith('page_'));
  const returning=this.pendingAction==='resume_settings';
  if(returning){if(page!=='search_font'&&page!=='font_preview')return;}
  else if(!resultPages?.length||!resultPages.every(predicate=>predicate===`page_${page}`))return;
  if(this.pendingAction==='select_font')this.visitedFont=true;
  if(this.pendingAction==='open_example'&&this.visitedFont)this.visitedExample=true;
  if(returning)this.settingsReturnVerified=true;
  // Returning directly to preview completes the optional restore branch immediately.
  this.verifiedSteps=returning&&page==='font_preview'?this.task.actionIds.length:this.verifiedSteps+1;this.pendingAction=undefined;
 }
 private alive(context:HybridContext){return !context.signal.aborted&&Date.now()<context.deadline;}
 private async read(context:HybridContext):Promise<Snapshot|undefined>{
  if(!this.alive(context))return undefined;
  const start=performance.now();const result=await this.transport.call('mobile_list_elements_on_screen',{format:'json'});
  this.toolTimings.push({tool:'mobile_list_elements_on_screen',durationMs:performance.now()-start,status:result.status});
  if(result.status!=='succeeded'||!this.alive(context))return undefined;
  try{
   const elements=parseMobileElements(result.hostLocalResult);const page=classifyMobilePage(elements);
   if(page==='unknown')return {page,bindings:{},visible:[],signature:'unknown'};
   const available=this.task.catalog.actions.filter(action=>sourcePages[action.actionId]===page).filter(action=>
    action.actionId==='restore_font'?this.visitedExample:action.actionId==='select_font'&&this.task.id==='M5'?!this.visitedExample:true);
   // Initial selection and explicit restoration share a control but never a binding.
   const mappings=available.filter(action=>Object.hasOwn(selectors,action.actionId)).map(action=>({actionId:action.actionId,...selectors[action.actionId as keyof typeof selectors]}));
   const projection=projectPublicObservation(elements,mappings);
   const bindings:Record<string,HostPoint>={},geometry:Array<[string,MobileElement['coordinates']]>=[];
   for(const [actionId,ref] of Object.entries(projection.hostLocalBindings)){
    const element=elements.find(value=>value.ref===ref)!;const point=controlCenter(element.coordinates);
    if(point){bindings[actionId]=point;geometry.push([actionId,element.coordinates]);}
   }
   const visible=available.filter(action=>!Object.hasOwn(selectors,action.actionId)||Object.hasOwn(bindings,action.actionId)).map(action=>action.actionId);
   // Ref ordinals can be renumbered by mobilecli's next dump. Compare semantic
   // control rectangles privately, then tap their observed center without a ref.
   return {page,bindings,visible,signature:JSON.stringify([page,visible,geometry])};
  }catch{return undefined;}
 }
 async observe(context:HybridContext):Promise<HybridObservation>{
  this.bound=undefined;this.latest=undefined;this.snapshot=undefined;
  const make=(readiness:HybridObservation['readiness'],page:MobilePage='unknown',visibleActionIds:string[]=[]):HybridObservation=>({observationId:`mobile_${++this.sequence}`,stateKey:page,readiness,predicates:{...Object.fromEntries(MOBILE_CURRENT_PREDICATES.map(predicate=>[predicate,readiness==='settled'?(predicate==='settings_returned'?this.settingsReturnVerified&&(page==='search_font'||page==='font_preview'):predicate===`page_${page}`):'unknown'])),visited_font:this.visitedFont,visited_example:this.visitedExample,task_sequence_complete:this.sequenceStarted&&!this.sequenceBroken&&this.verifiedSteps===this.task.actionIds.length},visibleActionIds});
  if(this.observing||this.executing||this.quarantined||!this.alive(context))return make('unobservable');
  this.observing=true;
  try{
   const first=await this.read(context),second=first?await this.read(context):undefined;
   let observation:HybridObservation;
   if(!first||!second||first.page==='unknown'||second.page==='unknown')observation=make('unobservable');
   else if(first.signature!==second.signature)observation=make('pending');
   else {
    this.verifyOrderedResult(second.page);
    this.snapshot=second;observation=make('settled',second.page,second.visible.filter(actionId=>!this.attempted.has(actionId)&&this.orderedActionAllowed(actionId)));
   }
   this.latest=structuredClone(observation);return observation;
  }finally{this.observing=false;}
 }
 async bind(actionId:string,observation:HybridObservation,context:HybridContext):Promise<HybridBinding|null>{
  this.bound=undefined;
  if(!this.alive(context)||this.executing||this.observing||this.quarantined||!this.latest||!this.snapshot||!isDeepStrictEqual(observation,this.latest)||observation.readiness!=='settled'||!observation.visibleActionIds.includes(actionId)||this.attempted.has(actionId))return null;
  if(!this.orderedActionAllowed(actionId))return null;
  const action=this.task.catalog.actions.find(value=>value.actionId===actionId);
  if(!action||sourcePages[actionId]!==this.snapshot.page||action.preconditions.some(predicate=>observation.predicates[predicate]!==true))return null;
  const value={actionId,observationId:observation.observationId,token:randomUUID()};this.bound={value:structuredClone(value),point:this.snapshot.bindings[actionId]};return value;
 }
 async execute(binding:HybridBinding,context:HybridContext):Promise<{status:'executed'|'unknown'|'rejected'}>{
  const bound=this.bound;this.bound=undefined;
  if(!bound||!isDeepStrictEqual(bound.value,binding)||!this.latest||this.latest.observationId!==binding.observationId||!this.alive(context)||this.executing||this.observing||this.quarantined||this.attempted.has(binding.actionId))return {status:'rejected'};
  this.attempted.add(binding.actionId);this.latest=undefined;this.snapshot=undefined;this.executing=true;
  const start=performance.now();let tool:MobileToolName='mobile_list_elements_on_screen';
  try{
   let result;
   if(bound.point){tool='mobile_click_on_screen_at_coordinates';result=await this.transport.call(tool,{...bound.point});}
   else if(binding.actionId==='type_font'||binding.actionId==='type_notification'){tool='mobile_type_keys';result=await this.transport.call(tool,{text:binding.actionId==='type_font'?'字体':'通知',submit:false});}
   else if(binding.actionId==='open_example'){tool='mobile_open_url';result=await this.transport.call(tool,{url:'https://www.example.com'});}
   else if(binding.actionId==='resume_settings'){tool='mobile_launch_app';result=await this.transport.call(tool,{packageName:'com.android.settings'});}
   else if(binding.actionId==='back_to_font_search'){tool='mobile_press_button';result=await this.transport.call(tool,{button:'BACK'});}
   else return {status:'rejected'};
   this.toolTimings.push({tool,durationMs:performance.now()-start,status:result.status});
   if(result.status==='uncertain'||!this.alive(context)){this.quarantined=true;return {status:'unknown'};}
   if(result.status==='succeeded'){
    if(!this.sequenceStarted||this.pendingAction!==undefined||binding.actionId!==this.task.actionIds[this.verifiedSteps])this.sequenceBroken=true;
    else this.pendingAction=binding.actionId;
   }
   return {status:result.status==='succeeded'?'executed':'rejected'};
  }catch{this.quarantined=true;return {status:'unknown'};}
  finally{this.executing=false;}
 }
}
