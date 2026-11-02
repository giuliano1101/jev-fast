import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {NativeDesktopDriver,nativeLaunchSpec} from '../desktop/driver.js';
import {desktopToolDefinitions,parseDesktopTool} from '../desktop/contracts.js';
import {Fault,ExecutionNotStarted} from '../core/errors.js';
import type {Executor,Observation} from './router.js';
import type {JsonObject} from './network-client.js';
import {authorizedPath} from './artifacts.js';
import {PrivateStore} from './store.js';

const writes=new Set(['desktop_launch_app','desktop_open_document','desktop_activate_app','desktop_click','desktop_type_text','desktop_press_key','desktop_set_value','desktop_scroll','desktop_drag','desktop_perform_action']);
const inventoryOnly=new Set(['desktop_launch_app','desktop_open_document']);
export class NativeCommon {
 private driver:NativeDesktopDriver|undefined;
 readonly latest=new Map<string,string>();
 constructor(){}
 async call(name:string,args:JsonObject,signal?:AbortSignal){
  if(!['darwin','win32'].includes(process.platform))throw new Fault('NATIVE_PLATFORM_UNAVAILABLE');if(signal?.aborted)throw new ExecutionNotStarted();
  this.driver??=new NativeDesktopDriver(nativeLaunchSpec());const driver=this.driver;
  const abort=()=>{if(this.driver===driver)this.driver=undefined;this.latest.clear();void driver.close();};signal?.addEventListener('abort',abort,{once:true});
  try{return await driver.call(name.replace(/^desktop_/,''),parseDesktopTool(name,args));}finally{signal?.removeEventListener('abort',abort);}
 }
 async close(){await this.driver?.close();}
}
interface Target {app:string|number;cached:Observation;native_observation_id?:string}
/** Scope adapter reuses the upstream native executor. It never substitutes its own native input engine. */
export class NativeAdapter {
 private targets=new Map<string,Target>();
 constructor(readonly common:NativeCommon,readonly resources:PrivateStore,readonly runtime:string,readonly fileRoots:string[]){}
 async status(){return {native:await this.common.call('desktop_status',{}),tools:desktopToolDefinitions};}
 async apps(){return await this.common.call('desktop_list_apps',{});}
 private target(id:string){const t=this.targets.get(id);if(!t)throw new Fault('NATIVE_TARGET_NOT_OWNED');return t;}
 async prepare(app:string|number){
  const id=randomUUID(),target:Target={app,cached:{snapshot_id:'pending',state:{}}};this.targets.set(id,target);
  try{const observation=await this.fresh(id);return {target_id:id,app:target.app,...observation};}
  catch(error){
   if(typeof app!=='string'||!(error instanceof Error)||!['APP_NOT_RUNNING','APP_NOT_FOUND'].includes(error.message)){this.targets.delete(id);throw new Fault('NATIVE_OBSERVATION_UNAVAILABLE');}
   const inventory=await this.apps();target.cached={snapshot_id:randomUUID(),state:{app_requested:app,running:false,inventory}};return {target_id:id,app,...target.cached};
  }
 }
 private async accept(target:Target,input:JsonObject){
  const state=JSON.parse(JSON.stringify(input)) as JsonObject;
  const image=state.image as {data?:string;mimeType?:string}|undefined;
  if(image){
   if(image.mimeType!=='image/png'||typeof image.data!=='string')throw new Fault('INVALID_NATIVE_IMAGE');
   const folder=join(this.runtime,'screenshots');await mkdir(folder,{recursive:true,mode:0o700});const path=join(folder,randomUUID()+'.png');await writeFile(path,Buffer.from(image.data,'base64'),{mode:0o600});
   const {data:_pixels,...metadata}=image;state.image={...metadata,path};
  }
  const app=state.app as JsonObject|undefined;if(typeof app?.pid==='number')target.app=app.pid;
  if(typeof state.observation_id!=='string')throw new Fault('INVALID_NATIVE_OBSERVATION');
  target.native_observation_id=state.observation_id;target.cached={snapshot_id:state.observation_id,state};this.common.latest.set(String(target.app),state.observation_id);return target.cached;
 }
 async fresh(id:string,includeScreenshot=false){
  const release=await this.resources.lease('windows-desktop-input');try{return await this.freshUnlocked(id,includeScreenshot);}finally{await release();}
 }
 private async freshUnlocked(id:string,includeScreenshot=false){const target=this.target(id);return await this.accept(target,await this.common.call('desktop_get_state',{app:target.app,...(includeScreenshot?{include_screenshot:true}:{})}));}
 private parse(id:string,input:JsonObject){
  const target=this.target(id),tool=String(input.tool);if(!writes.has(tool)||Object.keys(input).some(k=>!['tool','arguments'].includes(k)))throw new Fault('NATIVE_ACTION_UNSUPPORTED');
  let args:JsonObject;try{args=parseDesktopTool(tool,input.arguments);}catch{throw new Fault('NATIVE_ARGUMENTS_INVALID');}
  if(String(args.app)!==String(target.app))throw new Fault('NATIVE_APP_BINDING_MISMATCH');
  if(typeof args.window_id==='string'&&!(target.cached.state.windows as JsonObject[]|undefined)?.some(w=>w.window_id===args.window_id))throw new Fault('UNOBSERVED_NATIVE_WINDOW');
  if(!inventoryOnly.has(tool)&&tool!=='desktop_activate_app'){
   if(args.observation_id!==target.native_observation_id||this.common.latest.get(String(target.app))!==target.native_observation_id)throw new Fault('STALE_SNAPSHOT');
   if(typeof args.element_id==='string'&&!(target.cached.state.elements as JsonObject[]|undefined)?.some(e=>e.element_id===args.element_id))throw new Fault('UNOBSERVED_NATIVE_ELEMENT');
  }
  return {tool,args,target};
 }
 executor(id:string):Executor{return {
  name:'native-desktop',resource:'windows-desktop-input',
  // A fresh native get_state invalidates old element ids. Use the exact caller observation;
  // the upstream input engine rechecks process, window, focus and control identities before input.
  observe:async()=>this.target(id).cached,
  validate:async(target,snapshot,input)=>{const parsed=this.parse(target,input);if(parsed.target.cached.snapshot_id!==snapshot)throw new Fault('STALE_SNAPSHOT');if(parsed.tool==='desktop_open_document')await authorizedPath(String(parsed.args.path),this.fileRoots);},
  execute:async(target,input,signal)=>{if(signal?.aborted)throw new ExecutionNotStarted();const parsed=this.parse(target,input);const result=await this.common.call(parsed.tool,parsed.args,signal);const app=result.app as JsonObject|undefined;if(typeof app?.pid==='number')parsed.target.app=app.pid;return result;},
  verify:async(target,expected)=>{
   const state=(await this.freshUnlocked(target)).state,checks:boolean[]=[];
   const elements=state.elements as JsonObject[]??[];
   if(typeof expected.textIncludes==='string')checks.push(elements.some(e=>(String(e.label??'')+' '+String(e.value??'')).includes(expected.textIncludes as string)));
   if(expected.element&&typeof expected.element==='object'){const wanted=expected.element as JsonObject;checks.push(Object.keys(wanted).length>0&&elements.some(e=>Object.entries(wanted).every(([k,v])=>e[k]===v)));}
   if(typeof expected.windowTitleIncludes==='string')checks.push(String((state.window as JsonObject|undefined)?.title??'').includes(expected.windowTitleIncludes));
   if(expected.appRunning===true)checks.push(typeof (state.app as JsonObject|undefined)?.pid==='number');
   return {met:checks.length>0&&checks.every(Boolean),state};
  }
 };}
}
