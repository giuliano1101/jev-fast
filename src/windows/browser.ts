import {chromium,type Browser,type BrowserContext,type Page,type ElementHandle} from 'playwright';
import {mkdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {setTimeout as sleep} from 'node:timers/promises';
import {Fault,ExecutionNotStarted} from '../core/errors.js';
import {canonicalDigest} from '../remote/protocol.js';
import {chromiumExecutable} from '../browser/executable.js';
import {authorizedPath,inspectArtifact} from './artifacts.js';
import type {Executor,Observation} from './router.js';
import type {JsonObject} from './network-client.js';

const control=z.object({control_id:z.string().min(1)});
export const localBrowserAction=z.discriminatedUnion('operation',[
 control.extend({operation:z.literal('click')}),control.extend({operation:z.literal('fill'),value:z.string()}),
 control.extend({operation:z.literal('select'),value:z.string()}),control.extend({operation:z.literal('press'),key:z.string()}),
 control.extend({operation:z.literal('upload'),paths:z.array(z.string()).min(1)}),
 control.extend({operation:z.literal('tap'),x:z.number().nonnegative(),y:z.number().nonnegative()}),
 control.extend({operation:z.literal('replay'),steps:z.array(z.discriminatedUnion('kind',[z.object({kind:z.literal('tap'),x:z.number().nonnegative(),y:z.number().nonnegative(),delay_ms:z.number().int().nonnegative().optional()}),z.object({kind:z.literal('key'),key:z.enum(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Enter']),delay_ms:z.number().int().nonnegative().optional()})])).min(1)}),
 z.object({operation:z.literal('navigate'),url:z.url().refine(s=>/^https?:/.test(s))}),
 z.object({operation:z.literal('scroll'),dx:z.number().optional(),dy:z.number().optional()}),
 z.object({operation:z.literal('back')}),z.object({operation:z.literal('resize'),width:z.number().int().min(240).max(7680),height:z.number().int().min(240).max(4320)}),
 z.object({operation:z.literal('key'),key:z.enum(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Enter','Escape'])})
]);
export interface BrowserOptions {runtime:string;profile:string;headless?:boolean;executable?:string;cdpUrl?:string;allowedFileRoots:string[];viewport?:{width:number;height:number};beforeReplayInput?:()=>Promise<void>}
interface BrowserSnapshot {observation:Observation;page:Page;generation:number;locators:Map<string,ElementHandle>}
interface BrowserSession {runtime:string;context:BrowserContext;page:Page;pages:Set<Page>;generation:number;snapshots:Map<string,BrowserSnapshot>;downloads:Array<{path:string;name:string;error?:string}>;pending:Set<Promise<void>>;ownedContext:boolean;authorized:Map<string,string>;errors:Array<{kind:string;message:string}>}
function semanticState(state:JsonObject):JsonObject{return {...state,controls:(state.controls as JsonObject[]).map(({rect:_layout,...control})=>control)};}
export class WindowsBrowser {
 private readonly sessions=new Map<string,BrowserSession>();
 private persistent:BrowserContext|undefined;
 private attached:Browser|undefined;
 private starting:Promise<BrowserContext>|undefined;
 constructor(readonly options:BrowserOptions){}
 private async context(){
  if(this.starting)return await this.starting;
  this.starting=this.startContext();try{return await this.starting;}finally{this.starting=undefined;}
 }
 private async startContext(){
  if(this.options.cdpUrl){
   const url=new URL(this.options.cdpUrl);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Fault('CDP_MUST_BE_LOCAL');
   this.attached??=await chromium.connectOverCDP(url.toString());const context=this.attached.contexts()[0];if(!context)throw new Fault('BROWSER_CONTEXT_UNAVAILABLE');return context;
  }
  if(!this.persistent){
   await mkdir(this.options.profile,{recursive:true,mode:0o700});
   this.persistent=await chromium.launchPersistentContext(this.options.profile,{headless:this.options.headless??false,executablePath:this.options.executable??chromiumExecutable(),acceptDownloads:true,viewport:this.options.viewport??{width:1280,height:900},hasTouch:true});
  }
  return this.persistent;
 }
 async open(runtime=this.options.runtime){
  const context=await this.context(),page=await context.newPage(),id=randomUUID();
  const session:BrowserSession={runtime,context,page,pages:new Set([page]),generation:0,snapshots:new Map(),downloads:[],pending:new Set(),ownedContext:!this.options.cdpUrl,authorized:new Map(),errors:[]};this.sessions.set(id,session);
  this.watch(session,page);return {session_id:id,...await this.observe(id)};
 }
 private watch(s:BrowserSession,page:Page){
  page.on('framenavigated',()=>{s.generation++;});
  page.on('pageerror',error=>s.errors.push({kind:'pageerror',message:error.message.slice(0,1000)}));
  page.on('requestfailed',request=>s.errors.push({kind:'requestfailed',message:request.url().split('?')[0]+' '+request.failure()?.errorText}));
  page.on('popup',popup=>{s.pages.add(popup);s.page=popup;this.watch(s,popup);});
  page.on('download',download=>{
   const name=basename(download.suggestedFilename()).replace(/[^\p{L}\p{N}._-]/gu,'_')||'download';
   const path=join(s.runtime,'downloads',randomUUID()+'-'+name);
   const pending=(async()=>{await mkdir(join(s.runtime,'downloads'),{recursive:true,mode:0o700});try{await download.saveAs(path);s.downloads.push({name,path});}catch{s.downloads.push({name,path,error:'DOWNLOAD_FAILED'});}})();
   s.pending.add(pending);void pending.finally(()=>s.pending.delete(pending));
  });
 }
 private session(id:string){const s=this.sessions.get(id);if(!s||s.page.isClosed())throw new Fault('BROWSER_SESSION_UNAVAILABLE');return s;}
 private async capture(id:string){
  const s=this.session(id),page=s.page;await page.waitForLoadState('domcontentloaded',{timeout:5000}).catch(()=>{});const generation=s.generation,locators=new Map<string,ElementHandle>();
  const controls:JsonObject[]=[];
  const frames=page.frames();
  for(let frameIndex=0;frameIndex<frames.length;frameIndex++){
   const frame=frames[frameIndex]!;const elements=frame.locator('a,button,input:not([type="hidden"]),select,textarea,[role="button"],[role="checkbox"],[contenteditable="true"],canvas');
   const count=await elements.count();
   for(let index=0;index<count;index++){
    const locator=await elements.nth(index).elementHandle();if(!locator)continue;if(!await locator.isVisible().catch(()=>false)){await locator.dispose();continue;}
    const data=await locator.evaluate(element=>{
     const e=element as HTMLInputElement,rect=element.getBoundingClientRect(),tag=element.tagName.toLowerCase();
     const label=element.getAttribute('aria-label')??(e.labels?Array.from(e.labels).map(l=>l.innerText).join(' '):'')??'';
     return {tag,label:label||element.getAttribute('placeholder')||element.textContent?.trim().slice(0,180)||element.getAttribute('title')||'',type:element.getAttribute('type'),disabled:('disabled'in e&&e.disabled)||element.getAttribute('aria-disabled')==='true',value:e.type==='password'?'<private>':('value'in e?String(e.value).slice(0,512):undefined),checked:'checked'in e?e.checked:undefined,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},options:tag==='select'?Array.from((element as HTMLSelectElement).options).map(o=>({value:o.value,label:o.text})):undefined};
    });
    const control_id='c-'+frameIndex+'-'+index;controls.push({control_id,frame:frameIndex,...data});locators.set(control_id,locator);
   }
  }
  const text=(await page.locator('body').innerText().catch(()=>'')).slice(0,10000);
  const state=JSON.parse(JSON.stringify({environment:'windows-local-browser',url:page.url(),title:await page.title(),text,viewport:page.viewportSize(),controls,frames:frames.map(f=>({url:f.url(),name:f.name()})),tabs:[...s.pages].filter(p=>!p.isClosed()).map(p=>({url:p.url(),active:p===page})),downloads:s.downloads})) as JsonObject;
  if(s.page!==page||s.generation!==generation){for(const handle of locators.values())await handle.dispose().catch(()=>{});throw new Fault('STALE_SNAPSHOT');}
  return {state,locators,page,generation};
 }
 async observe(id:string):Promise<Observation>{
  const captured=await this.capture(id),s=this.session(id),observation={snapshot_id:randomUUID(),state:captured.state};s.snapshots.set(observation.snapshot_id,{observation,...captured});
  while(s.snapshots.size>8){const key=s.snapshots.keys().next().value!,old=s.snapshots.get(key)!;s.snapshots.delete(key);for(const handle of old.locators.values())await handle.dispose().catch(()=>{});for(const [digest,value] of s.authorized)if(value===key)s.authorized.delete(digest);}
  return observation;
 }
 private snapshot(id:string,key:string){const value=this.session(id).snapshots.get(key);if(!value)throw new Fault('STALE_SNAPSHOT');return value;}
 executor(id:string,beforeReplayInput?:()=>Promise<void>):Executor{return {name:'windows-browser',resource:'browser-'+id,observe:(target,snapshot)=>snapshot?Promise.resolve(this.snapshot(target,snapshot).observation):this.observe(target),validate:(target,snapshot,action)=>this.validate(target,snapshot,action),execute:(target,action,signal)=>this.execute(target,action,signal,beforeReplayInput),verify:(target,expected)=>this.verify(target,expected)};}
 async validate(id:string,snapshot:string,input:JsonObject){
  const action=localBrowserAction.parse(input),bound=this.snapshot(id,snapshot),s=this.session(id),current=await this.capture(id);
  try{
   if(current.page!==bound.page||current.generation!==bound.generation)throw new Fault('STALE_SNAPSHOT');
   const before=bound.observation.state,after=current.state;
   const relevant=(state:JsonObject)=>{
    if(action.operation==='resize')return {url:state.url,viewport:state.viewport,frames:state.frames,tabs:state.tabs};
    if(['navigate','back','scroll'].includes(action.operation)){const {text:_body,...metadata}=semanticState(state);return metadata;}
    return semanticState(state);
   };
   if(canonicalDigest(relevant(before))!==canonicalDigest(relevant(after)))throw new Fault('STALE_SNAPSHOT');
   if('control_id'in action){
    const control=(after.controls as JsonObject[]).find(c=>c.control_id===action.control_id),locator=bound.locators.get(action.control_id);
    if(!control||control.disabled||!locator||!await locator.evaluate(element=>element.isConnected).catch(()=>false)||!await locator.isVisible().catch(()=>false))throw new Fault('CONTROL_UNAVAILABLE');
    if(action.operation==='tap'||action.operation==='replay'){const rect=control.rect as {width:number;height:number};const points=action.operation==='tap'?[action]:action.steps.filter(step=>step.kind==='tap');if(control.tag!=='canvas'||points.some(point=>point.x>=rect.width||point.y>=rect.height))throw new Fault('UNOBSERVED_CANVAS_POINT');}
   }
  }finally{for(const handle of current.locators.values())await handle.dispose().catch(()=>{});}
  if(action.operation==='upload')for(const path of action.paths)await authorizedPath(path,this.options.allowedFileRoots);
  s.authorized.set(canonicalDigest(action),snapshot);
 }
 async execute(id:string,input:JsonObject,signal?:AbortSignal,beforeReplayInput?:()=>Promise<void>){
  const action=localBrowserAction.parse(input),s=this.session(id),digest=canonicalDigest(action),snapshot=s.authorized.get(digest);s.authorized.delete(digest);
  if(!snapshot)throw new ExecutionNotStarted();
  try{await this.validate(id,snapshot,input);}catch{throw new ExecutionNotStarted();}s.authorized.delete(digest);
  if(signal?.aborted)throw new ExecutionNotStarted();
  const page=s.page,locator='control_id'in action?this.snapshot(id,snapshot).locators.get(action.control_id):undefined;
  switch(action.operation){
   case 'navigate':await page.goto(action.url,{waitUntil:'domcontentloaded'});break;
   case 'click':await locator!.click();break;
   case 'fill':await locator!.fill(action.value);break;
   case 'select':await locator!.selectOption(action.value);break;
   case 'press':await locator!.press(action.key);break;
   case 'upload':await locator!.setInputFiles(action.paths);break;
   case 'tap':await locator!.tap({position:{x:action.x,y:action.y}});break;
   case 'replay':for(const step of action.steps){if(step.delay_ms)await sleep(step.delay_ms);signal?.throwIfAborted();await (beforeReplayInput??this.options.beforeReplayInput)?.();signal?.throwIfAborted();if(step.kind==='tap')await locator!.tap({position:{x:step.x,y:step.y}});else await page.keyboard.press(step.key);}break;
   case 'scroll':await page.mouse.wheel(action.dx??0,action.dy??0);break;
   case 'back':await page.goBack({waitUntil:'domcontentloaded'});break;
   case 'resize':await page.setViewportSize({width:action.width,height:action.height});break;
   case 'key':await page.keyboard.press(action.key);break;
  }
  await s.page.waitForLoadState('domcontentloaded',{timeout:5000}).catch(()=>{});
  await Promise.all(s.pending);try{return {after:await this.observe(id),downloads:s.downloads};}catch{return {input_acknowledged:true,observation_unavailable:true,downloads:s.downloads};}
 }
 async verify(id:string,expected:JsonObject){
  const deadline=Date.now()+5000;let result=await this.verifyOnce(id,expected);
  while(!result.met&&Date.now()<deadline){await sleep(100);result=await this.verifyOnce(id,expected);}
  return result;
 }
 private async verifyOnce(id:string,expected:JsonObject){
  const observed=await this.observe(id),state=observed.state,checks:boolean[]=[];
  if(typeof expected.urlIncludes==='string')checks.push(String(state.url).includes(expected.urlIncludes));
  if(typeof expected.textIncludes==='string')checks.push(String(state.text).includes(expected.textIncludes));
  if(expected.viewport&&typeof expected.viewport==='object')checks.push(canonicalDigest(expected.viewport)===canonicalDigest(state.viewport));
  if(typeof expected.downloadCount==='number')checks.push(this.session(id).downloads.filter(d=>!d.error).length===expected.downloadCount);
  if(expected.control&&typeof expected.control==='object'){
   const wanted=expected.control as JsonObject;checks.push(Object.keys(wanted).length>0&&(state.controls as JsonObject[]).some(c=>Object.entries(wanted).every(([key,val])=>Object.hasOwn(c,key)&&canonicalDigest(c[key])===canonicalDigest(val))));
  }
  return {met:checks.length>0&&checks.every(Boolean),state:observed};
 }
 async screenshot(id:string){const s=this.session(id),path=join(s.runtime,'screenshots',randomUUID()+'.png');await mkdir(join(s.runtime,'screenshots'),{recursive:true,mode:0o700});await s.page.screenshot({path,fullPage:true});return await inspectArtifact(path,[s.runtime]);}
 async diagnostics(id:string){
  const session=this.session(id),state=await session.page.evaluate(()=>({url:location.href,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},canvases:Array.from(document.querySelectorAll('canvas')).map(c=>({width:c.width,height:c.height,cssWidth:c.getBoundingClientRect().width,cssHeight:c.getBoundingClientRect().height})),media:Array.from(document.querySelectorAll('audio,video')).map(node=>{const m=node as HTMLMediaElement;return {tag:m.tagName,paused:m.paused,muted:m.muted,currentTime:m.currentTime,readyState:m.readyState};}),navigation:performance.getEntriesByType('navigation').map(entry=>({duration:entry.duration,startTime:entry.startTime})),resources:performance.getEntriesByType('resource').map(e=>({url:e.name.split('?')[0],duration:e.duration}))}));
  return {state,errors:session.errors,note:'Read-only diagnostics; no claim of real iPhone/WeChat, audible playback or semantic game correctness.'};
 }
 async close(id:string){const s=this.sessions.get(id);if(!s)throw new Fault('BROWSER_SESSION_UNAVAILABLE');for(const page of s.pages)if(!page.isClosed())await page.close();this.sessions.delete(id);return {closed:true};}
 async shutdown(){for(const id of [...this.sessions.keys()])await this.close(id).catch(()=>{});await this.persistent?.close();this.persistent=undefined;await this.attached?.close();this.attached=undefined;/* connectOverCDP.close disconnects its transport; existing browser tabs remain. */}
}
