import {chromium,type Browser,type BrowserContext,type Page,type ElementHandle,type Request} from 'playwright';
import {randomUUID} from 'node:crypto';
import {chromiumExecutable} from './executable.js';
import {Fault} from '../core/errors.js';
import {canonicalDigest} from '../remote/protocol.js';
import {choiceSignal,choiceWithin} from '../choice/timing.js';
import {choiceArgsSchema,type ChoiceResponse} from '../choice/contracts.js';
import {realBrowserSchemas,type RealBrowserOptions,type RealBrowserObservation,type RealBrowserActionResult,type RealBrowserAction,type RealBrowserActArgs,type RealBrowserControl} from './real-contracts.js';
import {RealBrowserJournal} from './real-journal.js';
type BrowserPhase='OPEN'|'VALIDATE'|'DECISION'|'EXECUTE'|'OBSERVE'|'JOURNAL';
function documentChanged(error:unknown):boolean{return error instanceof Error&&/Execution context was destroyed|Cannot find context with specified id|Cannot find execution context|most likely because of a navigation/.test(error.message);}
/** Classify browser diagnostics without returning raw messages, URLs, page text or stacks. */
function browserErrorCode(error:unknown,phase:BrowserPhase):string {
 if(error instanceof Fault)return error.code;
 if(error instanceof Error){
  if(error.name==='TimeoutError')return `BROWSER_${phase}_TIMEOUT`;
  if(error.name==='AbortError')return `BROWSER_${phase}_CANCELLED`;
  const network=error.message.match(/net::(ERR_[A-Z_]+)/);if(network)return `BROWSER_${phase}_NETWORK_${network[1]}`;
  if(/Target page, context or browser has been closed|Target closed|Browser has been closed|Session closed|context closed|page closed/.test(error.message))return `BROWSER_${phase}_CONTEXT_CLOSED`;
  if(documentChanged(error))return `BROWSER_${phase}_NAVIGATION_CHANGED`;
 }
 return `BROWSER_${phase}_FAILED`;
}
interface BoundControl {sensitive:boolean;node:ElementHandle<HTMLElement|SVGElement>;signature:string;control:RealBrowserControl}
interface Session {readEpoch?:number;navigationListeners?:Set<()=>void>;pendingNavigation?:Request;documentLoading?:boolean;owner:string;context:BrowserContext;page:Page;bound:Map<string,BoundControl>;snapshot?:RealBrowserObservation;busy?:{controller:AbortController;done:Promise<unknown>};closing:boolean;quarantined:boolean;closePromise?:Promise<void>}
/** Real websites in isolated Chromium. No daily profile, arbitrary code, selectors, or implicit completion claims. */
export class RealBrowserService {
 private browser?:Browser;private launch?:Promise<Browser>;private stopped=false;private shutdownPromise?:Promise<void>;
 private readonly allocations=new Map<string,{owner:string;context:BrowserContext}>();
 private readonly sessions=new Map<string,Session>();private readonly pending=new Map<Promise<unknown>,string>();private readonly revoked=new Set<string>();
 private readonly journal:Promise<RealBrowserJournal>;
 constructor(private readonly options:RealBrowserOptions){this.journal=RealBrowserJournal.open(options.storageDir);void this.journal.catch(()=>{});}
 private allowed(client:string){if(this.revoked.has(client))throw new Fault('UNAUTHORIZED');if(this.stopped)throw new Fault('KILLED');}
 private session(client:string,id:string){this.allowed(client);const session=this.sessions.get(id);if(!session)throw new Fault('SESSION_UNAVAILABLE');if(session.owner!==client)throw new Fault('UNAUTHORIZED');if(session.closing)throw new Fault('SESSION_UNAVAILABLE');return session;}
 private track<T>(client:string,operation:Promise<T>):Promise<T>{this.pending.set(operation,client);void operation.finally(()=>this.pending.delete(operation)).catch(()=>{});return operation;}
 private async ensureBrowser(){if(this.browser)return this.browser;if(!this.launch){const launch=chromium.launch({headless:true,executablePath:chromiumExecutable(this.options.executablePath)}).then(browser=>{this.browser=browser;return browser;});this.launch=launch;void launch.finally(()=>{if(this.launch===launch)this.launch=undefined;}).catch(()=>{});}return this.launch;}
 async open(client:string,input:unknown):Promise<{session_id:string;browser:'isolated-chromium';observation:RealBrowserObservation}>{
  this.allowed(client);const args=realBrowserSchemas.browser_open.parse(input);
  return this.track(client,(async()=>{
   await this.journal;const browser=await this.ensureBrowser();this.allowed(client);const context=await browser.newContext({acceptDownloads:true});
   let session:Session|undefined;const session_id=randomUUID();this.allocations.set(session_id,{owner:client,context});
   try{
    this.allowed(client);context.setDefaultTimeout(0);context.setDefaultNavigationTimeout(0);const page=await context.newPage();this.allowed(client);
    session={owner:client,context,page,bound:new Map(),closing:false,quarantined:false};this.sessions.set(session_id,session);this.allocations.delete(session_id);
    this.watchPage(session,page);context.on('page',popup=>{this.watchPage(session!,popup);session!.snapshot=undefined;});
    await page.goto(args.url,{waitUntil:'domcontentloaded',timeout:0});this.allowed(client);
    return {session_id,browser:'isolated-chromium' as const,observation:await this.capture(session_id,session)};
   }catch(error){try{await context.close();this.sessions.delete(session_id);this.allocations.delete(session_id);}catch{/* Retain a partially allocated context for shutdown/revocation cleanup. */if(!session){const page=context.pages()[0];if(page)this.sessions.set(session_id,{owner:client,context,page,bound:new Map(),closing:true,quarantined:true});}}throw new Fault(browserErrorCode(error,'OPEN'));}
  })());
 }
 private watchPage(session:Session,page:Page){
  session.page=page;session.pendingNavigation=undefined;session.documentLoading=true;
  const changed=()=>{session.readEpoch=(session.readEpoch??0)+1;for(const listener of session.navigationListeners??[])listener();};changed();
  page.on('request',request=>{try{if(session.page===page&&request.isNavigationRequest()&&request.frame()===page.mainFrame()){session.pendingNavigation=request;changed();}}catch{/* Worker requests have no document frame. */}});
  page.on('requestfailed',request=>{if(session.page===page&&session.pendingNavigation===request){session.pendingNavigation=undefined;session.documentLoading=false;changed();}});
  page.on('framenavigated',frame=>{if(session.page===page&&frame===page.mainFrame()){
   // Hash/history changes invalidate a read but do not create another document
   // or DOMContentLoaded event. Only a main-document request starts loading.
   if(session.pendingNavigation)session.documentLoading=true;session.pendingNavigation=undefined;changed();
  }});
  page.on('domcontentloaded',()=>{if(session.page===page){session.documentLoading=false;changed();}});
  void page.waitForLoadState('domcontentloaded',{timeout:0}).then(()=>{if(session.page===page&&!session.pendingNavigation){session.documentLoading=false;changed();}},()=>{});
 }
 private async pendingObservation(id:string,session:Session):Promise<RealBrowserObservation>{
  const previous=session.snapshot,viewport=session.page.viewportSize();await this.clearBindings(session);
  const observation:RealBrowserObservation={session_id:id,snapshot_id:randomUUID(),url:session.page.url(),title:'',text:'',controls:[],navigation_pending:true,viewport:{width:viewport?.width??previous?.viewport.width??0,height:viewport?.height??previous?.viewport.height??0,scrollX:0,scrollY:0}};
  session.snapshot=observation;return structuredClone(observation);
 }
 private exclusive<T>(client:string,id:string,operation:(session:Session,signal:AbortSignal)=>Promise<T>,readOnly=false):Promise<T>{
  const session=this.session(client,id);if(session.busy)throw new Fault('BUSY');if(session.quarantined&&!readOnly)throw new Fault('QUARANTINED');
  const controller=new AbortController();const pending=Promise.resolve().then(()=>operation(session,controller.signal));session.busy={controller,done:pending};
  void pending.finally(()=>{if(session.busy?.done===pending)session.busy=undefined;}).catch(()=>{});return this.track(client,pending);
 }
 async observe(client:string,input:unknown):Promise<RealBrowserObservation>{const {session_id}=realBrowserSchemas.browser_observe.parse(input);return this.exclusive(client,session_id,async(session,signal)=>{try{const observation=await choiceWithin(this.capture(session_id,session),signal);this.allowed(client);return observation;}catch(error){throw new Fault(browserErrorCode(error,'OBSERVE'));}},true);}
 private async clearBindings(session:Session){const bound=[...session.bound.values()];session.bound.clear();session.snapshot=undefined;await Promise.all(bound.map(value=>value.node.dispose().catch(()=>{})));}
 private async capture(id:string,session:Session):Promise<RealBrowserObservation>{
  await this.clearBindings(session);
  for(;;){
   if(session.pendingNavigation||session.documentLoading)return this.pendingObservation(id,session);
   const epoch=session.readEpoch=(session.readEpoch??0)+1;let notify!:()=>void;
   const navigation=new Promise<undefined>(resolve=>{notify=()=>resolve(undefined);});(session.navigationListeners??=new Set()).add(notify);
   try{
    const observation=await Promise.race([this.captureCurrentDocument(id,session,epoch),navigation]);
    if(observation)return observation;
   }catch(error){if(!documentChanged(error)&&!(error instanceof Fault&&error.code==='BROWSER_READ_INTERRUPTED'))throw error;}
   finally{session.navigationListeners.delete(notify);}
   // Only the read is repeated after a document change. Inputs are never replayed.
  }
 }
 private async captureCurrentDocument(id:string,session:Session,epoch:number):Promise<RealBrowserObservation>{
  const page=session.page,bound=new Map<string,BoundControl>();
  const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollX,scrollY}));
  const text=await page.evaluate(()=>{const walker=document.createTreeWalker(document.body??document.documentElement,NodeFilter.SHOW_TEXT);const lines:string[]=[];let node:Node|null;while((node=walker.nextNode())){const parent=node.parentElement;if(!parent||['SCRIPT','STYLE','NOSCRIPT'].includes(parent.tagName))continue;const style=getComputedStyle(parent);if(style.visibility==='hidden'||style.display==='none')continue;const range=document.createRange();range.selectNodeContents(node);const rect=range.getBoundingClientRect();if(rect.width&&rect.height&&rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth){const value=node.textContent?.trim();if(value)lines.push(value);}}return lines.join('\n');});
  const controls:RealBrowserControl[]=[];
  const nodes=await page.$$('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="textbox"],[role="combobox"],[contenteditable="true"],[tabindex]');
  try{for(const node of nodes){
   const info=await node.evaluate(el=>{const rect=el.getBoundingClientRect(),style=getComputedStyle(el);const visible=el.isConnected&&rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.visibility!=='collapse'&&style.display!=='none';const enabled=!el.matches(':disabled')&&el.getAttribute('aria-disabled')!=='true'&&!el.closest('[inert]');const input=el as HTMLInputElement;const label=el.getAttribute('aria-label')||input.labels?.[0]?.innerText||(el as HTMLElement).innerText||el.getAttribute('title')||el.getAttribute('placeholder')||el.getAttribute('name')||el.id||el.tagName.toLowerCase();const tag=el.tagName.toLowerCase(),role=el.getAttribute('role')??'',type=input.type??'';return {visible,enabled,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},label:label.trim(),tag,role,type,editable:(el as HTMLElement).isContentEditable,href:el instanceof HTMLAnchorElement?el.href:undefined,options:el instanceof HTMLSelectElement?[...el.options].map(option=>({value:option.value,label:option.label})):undefined,signature:JSON.stringify({tag,role,type,label,href:el.getAttribute('href'),outer:el.outerHTML})};});
   const box=info.rect;if(!info.visible||!info.enabled||box.y+box.height<=0||box.y>=viewport.height||box.x+box.width<=0||box.x>=viewport.width){await node.dispose();continue;}
   const operations:RealBrowserControl['operations']=['click','press'];if(info.tag==='input'||info.tag==='textarea'||info.editable)operations.push('fill');if(info.tag==='select')operations.push('select');
   const control:RealBrowserControl={control_id:randomUUID(),tag:info.tag,role:info.role,label:info.label,operations,...(info.href?{href:info.href}:{}),...(info.options?{options:info.options}:{})};
   bound.set(control.control_id,{sensitive:info.type==='password',node,signature:info.signature,control});controls.push(control);
  }}catch(error){await Promise.all(nodes.map(node=>node.dispose().catch(()=>{})));throw error;}
  const observation:RealBrowserObservation={session_id:id,snapshot_id:randomUUID(),url:page.url(),title:await page.title(),text,viewport,controls};
  if(session.readEpoch!==epoch||session.page!==page||session.pendingNavigation||session.documentLoading){await Promise.all([...bound.values()].map(value=>value.node.dispose().catch(()=>{})));throw new Fault('BROWSER_READ_INTERRUPTED');}
  session.bound=bound;session.snapshot=observation;return structuredClone(observation);
 }
 private async validate(session:Session,args:RealBrowserActArgs){
  if(session.pendingNavigation||session.documentLoading)throw new Fault('STALE_SNAPSHOT');
  let changed!:()=>void;const navigation=new Promise<never>((_resolve,reject)=>{changed=()=>reject(new Fault('STALE_SNAPSHOT'));});(session.navigationListeners??=new Set()).add(changed);
  try{await Promise.race([this.validateCurrentDocument(session,args),navigation]);}
  finally{session.navigationListeners.delete(changed);}
 }
 private async validateCurrentDocument(session:Session,args:RealBrowserActArgs){
  if(!session.snapshot||session.snapshot.snapshot_id!==args.snapshot_id||session.page.url()!==session.snapshot.url)throw new Fault('STALE_SNAPSHOT');
  for(const action of args.actions)if('control_id'in action){const bound=session.bound.get(action.control_id);if(!bound||!bound.control.operations.includes(action.operation as 'click'|'fill'|'select'|'press'))throw new Fault('INVALID_CANDIDATE');
   const valid=await bound.node.evaluate((el,signature)=>{const input=el as HTMLInputElement;const label=el.getAttribute('aria-label')||input.labels?.[0]?.innerText||(el as HTMLElement).innerText||el.getAttribute('title')||el.getAttribute('placeholder')||el.getAttribute('name')||el.id||el.tagName.toLowerCase();return el.isConnected&&JSON.stringify({tag:el.tagName.toLowerCase(),role:el.getAttribute('role')??'',type:input.type??'',label,href:el.getAttribute('href'),outer:el.outerHTML})===signature;},bound.signature).catch(()=>false);
   if(!valid||!await bound.node.isVisible()||!await bound.node.isEnabled())throw new Fault('STALE_SNAPSHOT');
  }
 }
 private describe(session:Session,action:RealBrowserAction):string{if('control_id'in action){const bound=session.bound.get(action.control_id)!,control=bound.control;return JSON.stringify({operation:action.operation,control:{tag:control.tag,role:control.role,label:control.label,href:control.href},...('value'in action?(bound.sensitive?{value_provided:true,value_location:'host-only'}:{value:action.value}):{}),...('key'in action?{key:action.key}:{})});}return JSON.stringify(action);}
 async act(client:string,input:unknown):Promise<RealBrowserActionResult>{
  const args=realBrowserSchemas.browser_act.parse(input);this.allowed(client);const journal=await this.journal,key=canonicalDigest({client,session_id:args.session_id,idempotency_key:args.idempotency_key}),digest=canonicalDigest(args),prior=journal.find(key);
  if(prior){if(prior.owner!==client||prior.session_id!==args.session_id)throw new Fault('UNAUTHORIZED');if(prior.digest!==digest)throw new Fault('IDEMPOTENCY_CONFLICT');return structuredClone(prior.result??{execution:'unknown',reason:prior.status==='pending'?'EXECUTION_PENDING':'UNKNOWN'});}
  return this.exclusive(client,args.session_id,async(session,parent)=>{
   const deadline=choiceSignal(parent,args.timeout_ms);let decision:ChoiceResponse|undefined,started=false,begun=false,execution:Promise<void>|undefined;let phase:BrowserPhase='VALIDATE';
   try{
    phase='VALIDATE';await choiceWithin(this.validate(session,args),deadline.signal);this.allowed(client);if(deadline.signal.aborted)throw new Fault('CANCELLED');
    phase='JOURNAL';await journal.begin(key,{owner:client,session_id:args.session_id,digest});begun=true;if(deadline.signal.aborted)throw new Fault('CANCELLED');
    const choice=choiceArgsSchema.parse({idempotency_key:canonicalDigest({key,digest}),task:args.task,state:session.snapshot!,actions:args.actions.map(action=>({id:action.id,description:this.describe(session,action)})),...(args.timeout_ms===undefined?{}:{timeout_ms:args.timeout_ms})});
    phase='DECISION';decision=await choiceWithin(this.options.chooseAction(client,choice,deadline.signal),deadline.signal);
    if(decision.provider!=='jev'||!args.actions.some(action=>action.id===decision!.selected_id))throw new Fault('INVALID_DECISION');
    phase='VALIDATE';await choiceWithin(this.validate(session,args),deadline.signal);this.allowed(client);if(deadline.signal.aborted)throw new Fault('CANCELLED');
    const selected=args.actions.find(action=>action.id===decision!.selected_id)!;
    // The durable pending record precedes every physical browser command.
    phase='EXECUTE';started=true;execution=this.execute(session,selected,deadline.signal);await choiceWithin(execution,deadline.signal);
    phase='OBSERVE';const after=await choiceWithin(this.capture(args.session_id,session),deadline.signal);
    const postcondition_met=args.postcondition?((args.postcondition.urlContains===undefined||after.url.includes(args.postcondition.urlContains))&&(args.postcondition.textIncludes===undefined||after.text.includes(args.postcondition.textIncludes))):undefined;
    const result:RealBrowserActionResult={selected_id:decision.selected_id,decision,execution:'executed',after,...(postcondition_met===undefined?{}:{postcondition_met})};phase='JOURNAL';await journal.finish(key,result);return result;
   }catch(error){
    if(!begun)throw error;
    if(started)session.quarantined=true;
    if(started&&deadline.signal.aborted){
     // Abort races do not cancel Playwright's queued input. Destroy the affected
     // context and drain the command before returning UNKNOWN; it cannot click later.
     session.closing=true;let closed=false;try{await session.context.close();closed=true;}catch{/* Retain failed cleanup for owner revocation/shutdown retry. */}
     await execution?.catch(()=>{});if(closed)this.sessions.delete(args.session_id);
    }
    const result:RealBrowserActionResult={execution:'unknown',...(decision?{selected_id:decision.selected_id,decision}:{}),reason:parent.aborted?'BROWSER_ACTION_CANCELLED':deadline.signal.aborted?'BROWSER_CALLER_TIMEOUT':browserErrorCode(error,phase)};
    await journal.finish(key,result);return result;
   }finally{deadline.close();}
  });
 }
 private async execute(session:Session,action:RealBrowserAction,signal:AbortSignal){
  signal.throwIfAborted();
  const node='control_id'in action?session.bound.get(action.control_id)!.node:undefined;
  switch(action.operation){
   case 'click':{
    signal.throwIfAborted();await node!.click({timeout:0,noWaitAfter:true});
    // Popups are tracked by the context page event. A target attribute is no
    // guarantee that the site actually opens one (SPAs often preventDefault).
    await new Promise<void>(resolve=>setImmediate(resolve));signal.throwIfAborted();
    break;
   }
   case 'fill':await node!.fill(action.value,{timeout:0});break;
   case 'select':await node!.selectOption(action.value,{timeout:0});break;
   case 'press':await node!.press(action.key,{timeout:0,noWaitAfter:true});break;
   case 'navigate':await session.page.goto(action.url,{waitUntil:'domcontentloaded',timeout:0});break;
   case 'back':await session.page.goBack({waitUntil:'domcontentloaded',timeout:0});break;
   case 'scroll':await session.page.mouse.wheel(action.dx??0,action.dy??session.snapshot!.viewport.height);await session.page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));break;
  }
 }
 private async closeSession(id:string,session:Session){
  if(session.closePromise)return session.closePromise;session.closing=true;session.busy?.controller.abort();
  const pending=(async()=>{await session.context.close();await session.busy?.done.catch(()=>{});await this.clearBindings(session);this.sessions.delete(id);})();session.closePromise=pending;
  try{await pending;}finally{session.closePromise=undefined;}
 }
 async close(client:string,input:unknown){const {session_id}=realBrowserSchemas.browser_close.parse(input);this.allowed(client);const session=this.sessions.get(session_id);if(!session)throw new Fault('SESSION_UNAVAILABLE');if(session.owner!==client)throw new Fault('UNAUTHORIZED');await this.closeSession(session_id,session);return {closed:true};}
 async revokeOwner(client:string){this.revoked.add(client);const errors:unknown[]=[];for(const [id,allocation]of this.allocations)if(allocation.owner===client)try{await allocation.context.close();this.allocations.delete(id);}catch(error){errors.push(error);}for(const [id,session]of this.sessions)if(session.owner===client)try{await this.closeSession(id,session);}catch(error){errors.push(error);}await Promise.allSettled([...this.pending].filter(([,owner])=>owner===client).map(([operation])=>operation));if(errors.length)throw new AggregateError(errors,'Real browser owner cleanup failed');}
 shutdown():Promise<void>{if(this.shutdownPromise)return this.shutdownPromise;this.stopped=true;const pending=(async()=>{const errors:unknown[]=[];for(const [id,allocation]of this.allocations)try{await allocation.context.close();this.allocations.delete(id);}catch(error){errors.push(error);}for(const [id,session]of this.sessions)try{await this.closeSession(id,session);}catch(error){errors.push(error);}await Promise.allSettled([...this.pending.keys()]);try{await this.launch;await this.browser?.close();this.browser=undefined;}catch(error){errors.push(error);}try{await(await this.journal).close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Real browser shutdown failed');})();this.shutdownPromise=pending.catch(error=>{this.shutdownPromise=undefined;throw error;});return this.shutdownPromise;}
}
