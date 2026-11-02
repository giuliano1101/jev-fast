import {randomUUID} from 'node:crypto';
import {canonicalDigest} from '../remote/protocol.js';
import {Fault} from '../core/errors.js';
import {PrivateStore} from './store.js';
import {JevNetworkClient,HttpToolPort,type ToolPort,type JsonObject} from './network-client.js';
import {ActionRouter,type ActionIntent} from './router.js';
import {WindowsBrowser} from './browser.js';
import {WindowsDesktop} from './desktop.js';
import {HostWorkflow,type HostStep} from './host-workflow.js';
import {LocalPanel} from './panel.js';
import {inspectArtifact,authorizedPath} from './artifacts.js';
import {browserProfile,type WindowsConfig} from './config.js';
import {NativeCommon,NativeAdapter} from './native.js';

export interface SharedWindowsDrivers {browser:WindowsBrowser;desktop:WindowsDesktop;native:NativeCommon;resources:PrivateStore}
export class WindowsEngine {
 readonly store:PrivateStore;readonly resources:PrivateStore;readonly network:JevNetworkClient;readonly router:ActionRouter;
 readonly browser:WindowsBrowser;readonly desktop:WindowsDesktop;readonly host:HostWorkflow;readonly panels=new Map<string,LocalPanel>();
 readonly nativeCommon:NativeCommon;readonly native:NativeAdapter;
 private browserIds=new Set<string>();private desktopIds=new Set<string>();
 private activeTasks=0;private stopping=false;private drainWaiters:Array<()=>void>=[];
 constructor(readonly config:WindowsConfig,port?:ToolPort,readonly shared?:SharedWindowsDrivers){
  this.store=new PrivateStore(config.runtime);this.resources=shared?.resources??this.store;
  this.network=new JevNetworkClient(this.store,port??new HttpToolPort(config.endpoint));this.router=new ActionRouter(this.store,this.network,this.resources);
  this.browser=shared?.browser??new WindowsBrowser({runtime:config.runtime,profile:browserProfile(config),allowedFileRoots:config.allowedFileRoots,...config.browser});
  this.desktop=shared?.desktop??new WindowsDesktop(config.script);this.host=new HostWorkflow(this.store,this.network,this.resources);
  this.nativeCommon=shared?.native??new NativeCommon();this.native=new NativeAdapter(this.nativeCommon,this.resources,config.runtime,config.allowedFileRoots);
  for(const panel of config.panels){if(this.panels.has(panel.id))throw new Fault('DUPLICATE_PANEL_PROFILE');this.panels.set(panel.id,new LocalPanel(panel));}
 }
 async initialize(){await this.store.initialize();await this.store.own();}
 enterTask(){if(this.stopping)throw new Fault('WINDOWS_OWNER_STOPPING');this.activeTasks++;let ended=false;return ()=>{if(ended)return;ended=true;this.activeTasks--;if(!this.activeTasks)for(const done of this.drainWaiters.splice(0))done();};}
 stopAccepting(){this.stopping=true;}
 async drain(){if(this.activeTasks)await new Promise<void>(done=>this.drainWaiters.push(done));}
 async status(){return {jev:await this.network.status(),environment:process.platform,capabilities:{browser:'local-persistent-profile'+(this.config.browser.cdpUrl?'-attached-cdp':''),desktop:process.platform==='win32'?'windows-uia':'unavailable',android:'discover-with-host_tools',panels:[...this.panels.keys()]},runtime:this.config.runtime,shared_coordinator:!!this.shared};}
 private ownBrowser(id:string){if(!this.browserIds.has(id))throw new Fault('BROWSER_SESSION_NOT_OWNED');}
 private ownDesktop(id:string){if(!this.desktopIds.has(id))throw new Fault('DESKTOP_TARGET_NOT_OWNED');}
 private browserExecutor(id:string){this.ownBrowser(id);return this.browser.executor(id,async()=>{await this.network.ready();});}
 async browserOpen(url:string,operationId:string,signal?:AbortSignal){
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(operationId)||!/^https?:/.test(url))throw new Fault('INVALID_ARGUMENTS');
  const key='browser-open-'+operationId,release=await this.store.lease(key);
  try{
   let record=await this.store.read<{url:string;phase:string;session_id?:string;snapshot_id?:string}>(key);
   if(record&&record.url!==url)throw new Fault('OPERATION_ID_CONFLICT');
   if(record&&!record.session_id)throw new Fault('LOCAL_BROWSER_OPEN_UNKNOWN');
   if(!record){
    await this.network.ready();if(signal?.aborted)throw new Fault('CANCELLED_BEFORE_INPUT');await this.store.write(key,{url,phase:'opening'});
    const session=await this.browser.open(this.config.runtime);this.browserIds.add(session.session_id);
    record={url,phase:'created',session_id:session.session_id,snapshot_id:session.snapshot_id};await this.store.write(key,record);
   }
   const id=record.session_id!;this.ownBrowser(id);
   const action=await this.router.act(this.browserExecutor(id),{operation_id:operationId,target:id,snapshot_id:record.snapshot_id!,task:'Open the authorized URL in the local Windows browser: '+url,actions:[{id:'navigate',description:'Navigate this local browser to '+url,action:{operation:'navigate',url}}],expected:{urlIncludes:new URL(url).hostname}},signal);
   return {session_id:id,action,observation:await this.browser.observe(id)};
  }finally{await release();}
 }
 async browserAct(intent:ActionIntent,signal?:AbortSignal){
  this.ownBrowser(intent.target);for(const candidate of intent.actions)if(candidate.action.operation==='upload')for(const path of candidate.action.paths as string[])await authorizedPath(path,this.config.allowedFileRoots);
  return await this.router.act(this.browserExecutor(intent.target),intent,signal);
 }
 async browserObserve(id:string){this.ownBrowser(id);return await this.browser.observe(id);}
 async browserScreenshot(id:string){this.ownBrowser(id);return await this.browser.screenshot(id);}
 async browserDiagnostics(id:string){this.ownBrowser(id);return await this.browser.diagnostics(id);}
 async browserClose(id:string){this.ownBrowser(id);if(await this.resources.read('quarantine-'+canonicalDigest('browser-'+id)))throw new Fault('UNRESOLVED_BROWSER_CONTEXT_RETAINED');const result=await this.browser.close(id);this.browserIds.delete(id);return result;}
 async restartPrivateBrowser(){if(this.shared)throw new Fault('SHARED_BROWSER_CANNOT_BE_RESTARTED');for(const id of [...this.browserIds])await this.browserClose(id);await this.browser.shutdown();}
 async desktopAttach(pid:number,handle:number){const result=await this.desktop.attach(pid,handle);this.desktopIds.add(result.target_id);return result;}
 async desktopObserve(id:string){this.ownDesktop(id);return await this.desktop.observe(id);}
 async desktopScreenshot(id:string){this.ownDesktop(id);return await this.desktop.screenshot(id,this.config.runtime);}
 async desktopAct(intent:ActionIntent,signal?:AbortSignal){this.ownDesktop(intent.target);return await this.router.act(this.desktop.executor(intent.target),intent,signal);}
 async nativeAct(intent:ActionIntent,signal?:AbortSignal){return await this.router.act(this.native.executor(intent.target),intent,signal);}
 private panel(id:string){const panel=this.panels.get(id);if(!panel)throw new Fault('PANEL_NOT_CONFIGURED');return panel;}
 async panelObserve(id:string){return await this.panel(id).observe();}
 async panelAct(intent:ActionIntent,signal?:AbortSignal){return await this.router.act(this.panel(intent.target).executor(),intent,signal);}
 async hostTools(host:string){return await this.host.tools(host,randomUUID());}
 async hostStep(input:HostStep,signal?:AbortSignal){return await this.host.step(input,signal);}
 async artifact(path:string){return await inspectArtifact(path,this.config.allowedFileRoots);}
 async hasUnresolved(){
  for(const key of await this.store.keys('browser-open-')){const record=await this.store.read<{phase:string}>(key);if(record?.phase==='opening')return true;}
  for(const key of await this.store.keys('action-')){const record=await this.store.read<{phase:string}>(key);if(record?.phase==='executing'||record?.phase==='unknown')return true;}
  for(const key of await this.store.keys('host-step-')){const record=await this.store.read<{phase:string}>(key);if(record?.phase==='submitted'||record?.phase==='unknown')return true;}
  for(const key of await this.store.keys('request-')){const record=await this.store.read<{phase:string}>(key);if(record?.phase==='submitted'||record?.phase==='unknown')return true;}
  return false;
 }
 async release(){
  if(await this.hasUnresolved())throw new Fault('UNRESOLVED_EXECUTION_CONTEXT_RETAINED');
  for(const id of [...this.browserIds])await this.browserClose(id);
  if(!this.shared)await this.browser.shutdown();return await this.network.release();
 }
 async close(){
  if(!await this.hasUnresolved()){for(const id of [...this.browserIds])await this.browserClose(id).catch(()=>{});if(!this.shared)await this.browser.shutdown();}
  if(!this.shared){await this.desktop.close();await this.nativeCommon.close();}await this.network.close();await this.store.close();
 }
 async verifyKnown(kind:'browser'|'desktop'|'panel'|'native',target:string,operationId:string){
  if(kind==='browser')this.ownBrowser(target);if(kind==='desktop')this.ownDesktop(target);
  const executor=kind==='browser'?this.browserExecutor(target):kind==='desktop'?this.desktop.executor(target):kind==='native'?this.native.executor(target):this.panel(target).executor();return await this.router.verifyKnown(executor,operationId);
 }
 async recoverRequest(requestId:string){return await this.network.recoverRequest(requestId);}
 async operationStatus(operationId:string):Promise<JsonObject>{return await this.router.inspect(operationId);}
}
