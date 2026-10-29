import {chromium,type Browser,type BrowserContext,type Page,type ElementHandle} from 'playwright';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import type {BrowserPort,Goal,Snapshot,Candidate,Predicate} from '../core/contracts.js';
import {readFrame,sensitiveSelector} from './frame.js';
import {Fault,ExecutionNotStarted} from '../core/errors.js';
interface Bound {candidate:Candidate;node:ElementHandle<HTMLElement|SVGElement>|null;value?:string;signature:string;}
interface Session {context:BrowserContext;page:Page;goalKey?:string;goal?:Goal;snapshot?:Snapshot;bound:Map<string,Bound>;}
export interface BrowserOptions {executablePath?:string;onPage?:(id:string,page:Page)=>void;}
export class BrowserAdapter implements BrowserPort {
 readonly blockedRequests:string[]=[];
 private browser?:Browser;private sessions=new Map<string,Session>();
 constructor(readonly origin:string,private options:BrowserOptions={}){
  const u=new URL(origin);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw new Fault('OUT_OF_SCOPE');
 }
 async open(id:string,_fixture:'standard'){
  if(!this.browser){
   const cached=homedir()+'/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
   const executablePath=this.options.executablePath??process.env.JEV_CHROMIUM_PATH??(existsSync(chromium.executablePath())?undefined:existsSync(cached)?cached:undefined);
   this.browser=await chromium.launch({headless:true,executablePath});
  }
  const context=await this.browser.newContext({acceptDownloads:false,serviceWorkers:'block'});
  const primary:{page?:Page}={};
  await context.route('**/*',async route=>{
   const request=route.request();let allowed=false;
   try{allowed=new URL(request.url()).origin===this.origin&&request.frame().page()===primary.page;}catch{/* unavailable frame is not trusted */}
   if(allowed){try{const response=await route.fetch({maxRedirects:0,timeout:2000});if(response.status()>=300&&response.status()<400){this.blockedRequests.push('REDIRECT_BLOCKED');await route.abort('blockedbyclient');}else await route.fulfill({response});}catch{this.blockedRequests.push('NETWORK_BLOCKED');await route.abort('blockedbyclient').catch(()=>{});}}else{this.blockedRequests.push('NETWORK_BLOCKED');await route.abort('blockedbyclient');}
  });
  await context.routeWebSocket('**/*',socket=>{this.blockedRequests.push('WEBSOCKET_BLOCKED');socket.close();});
  context.on('page',page=>{if(primary.page&&page!==primary.page)void page.close().catch(()=>{});});
  const page=await context.newPage();primary.page=page;page.setDefaultTimeout(1500);
  page.on('download',download=>{void download.cancel();});page.on('dialog',dialog=>{void dialog.dismiss();});
  this.sessions.set(id,{context,page,bound:new Map()});this.options.onPage?.(id,page);
  await page.goto(this.origin+'/form');return {allowed_origin:this.origin};
 }
 private session(id:string){const s=this.sessions.get(id);if(!s)throw new Fault('SESSION_UNAVAILABLE');return s;}
 private synthetic(goal:Goal){
  const values={name:`Synthetic-${goal.seed}`,email:`synthetic-${goal.seed}@example.invalid`,category:'beta',query:`item-${goal.seed}`};
  for(const [k,v] of Object.entries(goal.values??{}))if(v!==values[k as keyof typeof values])throw new Fault('OUT_OF_SCOPE');return values;
 }
 private async guard(s:Session){
  if(new URL(s.page.url()).origin!==this.origin)throw new Fault('OUT_OF_SCOPE');
  if(await s.page.locator(sensitiveSelector).count())throw new Fault('SENSITIVE_PAGE');
 }
 async observe(id:string,goal?:Goal,signal?:AbortSignal):Promise<Snapshot>{
  signal?.throwIfAborted();const s=this.session(id);await this.guard(s);
  if(goal){this.synthetic(goal);const key=JSON.stringify(goal);
   if(s.goalKey&&s.goalKey!==key)throw new Fault('GOAL_CHANGED');
   if(!s.goalKey){s.goalKey=key;s.goal=goal;await s.page.goto(`${this.origin}/form?task=${goal.task}&language=${goal.language}&seed=${goal.seed}`);}
  }
  const frame=await readFrame(s.page,this.origin);const {state}=frame;const v=frame;const snapshotId=randomUUID();
  const now=Date.now();
  const snapshot:Snapshot={session_id:id,snapshot_id:snapshotId,document_epoch:v.epoch,mutation_version:v.version,url:frame.url,origin:this.origin,created_at:now,expires_at:now+2000,fingerprint:createHash('sha256').update(JSON.stringify(state)).digest('hex'),safe_summary:JSON.stringify({task:state.task,step:state.step,submitted:state.submitted,cancelled:state.cancelled,loaded:state.loaded,scrolled:state.scrolled,error:state.error}),synthetic:true,nodes:[],candidates:[]};
  for(const bound of s.bound.values())await bound.node?.dispose();s.bound.clear();
  if(goal&&!state.complete&&!state.cancelled){const values=this.synthetic(goal);
   const add=async(ref:string,op:Candidate['operation'],post:Predicate,value?:string)=>{
    const locator=s.page.locator(`[data-ref="${ref}"]:visible`);const count=await locator.count();if(count>1)throw new Fault('AMBIGUOUS_TARGET');if(count!==1||!await locator.isEnabled())return;
    const node=await locator.elementHandle();if(!node)return;
    const candidate:Candidate={candidate_id:randomUUID(),snapshot_id:snapshotId,operation:op,target_ref:ref,params_ref:randomUUID(),risk_class:'fixture',preconditions:[],expected_postcondition:post,policy_version:'p0-v1',description:`${op} ${ref} (${goal.language==='zh'?'模拟操作':'synthetic action'})`};
    s.bound.set(candidate.candidate_id,{candidate,node,value,signature:await node.evaluate(el=>JSON.stringify({html:el.outerHTML,value:(el as HTMLInputElement).value}))});snapshot.candidates.push(candidate);
   };
   const virtual=(ref:string,op:'wait'|'back',post:Predicate)=>{const candidate:Candidate={candidate_id:randomUUID(),snapshot_id:snapshotId,operation:op,target_ref:ref,params_ref:randomUUID(),risk_class:'fixture',preconditions:[],expected_postcondition:post,policy_version:'p0-v1',description:`${op} ${ref}`};s.bound.set(candidate.candidate_id,{candidate,node:null,signature:''});snapshot.candidates.push(candidate);};
   const field=(field:'name'|'email'|'category'|'query'):Predicate=>({kind:'field',field,value:values[field]});
   switch(goal.task){
    case 'cancel':await add('cancel','click',{kind:'flag',name:'cancelled',value:true});break;
    case 'filter':await add('query','fill',field('query'),values.query);break;
    case 'detail':case 'navigation':await add('detail','click',{kind:'page',path:'/detail'});break;
    case 'back':if(state.step===0)await add('detail','click',{kind:'page',path:'/detail'});else virtual('back','back',{kind:'page',path:'/list'});break;
    case 'select':await add('category','select',field('category'),values.category);break;
    case 'scroll':await add('bottom','scroll',{kind:'flag',name:'scrolled',value:true});break;
    case 'async':case 'wait':if(!state.step)await add('load','click',{kind:'step',value:1});else virtual('loaded','wait',{kind:'flag',name:'loaded',value:true});break;
    case 'correction':
     if(!state.error)await add('submit','click',{kind:'flag',name:'error',value:true});
     else if(state.email!==values.email)await add('email','fill',field('email'),values.email);
     else await add('submit','click',{kind:'count',value:1});break;
    default:
     if(state.name!==values.name)await add('name','fill',field('name'),values.name);
     else if(state.step===0)await add('next','click',{kind:'step',value:1});
     else if(state.category!==values.category)await add('category','select',field('category'),values.category);
     else await add('submit','click',{kind:'count',value:1});
   }
   if(goal.task!=='cancel')await add('cancel','click',{kind:'flag',name:'cancelled',value:true});
  }
  snapshot.nodes=snapshot.candidates.map(c=>({role:c.operation,name:c.target_ref}));s.snapshot=snapshot;return snapshot;
 }
 async validate(id:string,snapshot:Snapshot,candidate:Candidate,goal:Goal,signal:AbortSignal){
  signal.throwIfAborted();const s=this.session(id);this.synthetic(goal);
  const bound=s.bound.get(candidate.candidate_id);if(!bound||s.snapshot!==snapshot||JSON.stringify(bound.candidate)!==JSON.stringify(candidate)||Date.now()>snapshot.expires_at)return false;
  let frame:Awaited<ReturnType<typeof readFrame>>;
  try{frame=await readFrame(s.page,this.origin);}catch(error){
   if(error instanceof Fault&&(error.code==='SENSITIVE_PAGE'||error.code==='OUT_OF_SCOPE'))throw error;
   return false; // No physical operation has started; stale state remains safely retryable.
  }
  if(createHash('sha256').update(JSON.stringify(frame.state)).digest('hex')!==snapshot.fingerprint)return false;
  if(frame.epoch!==snapshot.document_epoch||frame.version!==snapshot.mutation_version||frame.url!==snapshot.url)return false;
  if(bound.node){if(!await bound.node.isVisible()||!await bound.node.isEnabled())return false;
   if(!await bound.node.evaluate((el,{ref,signature})=>el.isConnected&&Array.from(document.querySelectorAll(`[data-ref="${ref}"]`)).filter(n=>n.getClientRects().length>0).length===1&&JSON.stringify({html:el.outerHTML,value:(el as HTMLInputElement).value})===signature,{ref:candidate.target_ref,signature:bound.signature}))return false;
  }
  return true;
 }
 async execute(id:string,candidate:Candidate,goal:Goal,signal:AbortSignal){
  const s=this.session(id);if(!s.snapshot||!await this.validate(id,s.snapshot,candidate,goal,signal))throw new ExecutionNotStarted();
  const bound=s.bound.get(candidate.candidate_id)!;signal.throwIfAborted();
  switch(candidate.operation){
   case 'fill':await bound.node!.fill(bound.value!);break;
   case 'select':await bound.node!.selectOption(bound.value!);break;
   case 'click':await bound.node!.click({timeout:1500});break;
   case 'scroll':await bound.node!.scrollIntoViewIfNeeded();break;
   case 'back':await s.page.goBack({timeout:1500});break;
   case 'wait':break;
  }
  const deadline=Date.now()+Math.min(candidate.operation==='wait'?2000:700,2000);
  while(!await this.check(id,candidate.expected_postcondition)){signal.throwIfAborted();if(Date.now()>=deadline)break;await new Promise(resolve=>setTimeout(resolve,10));}
 }
 async check(id:string,predicate:Predicate,signal?:AbortSignal){signal?.throwIfAborted();const s=this.session(id);const frame=await readFrame(s.page,this.origin);const {state}=frame;
  switch(predicate.kind){case 'task_complete':if(!state.complete||state.submitted>1)return false;if(state.task==='cancel')return state.cancelled&&state.submitted===0;if(state.task==='filter')return (await s.page.locator('[data-item]:visible').allTextContents()).join('')===`item-${s.goal!.seed}`;return true;
   case 'step':return state.step===predicate.value;
   case 'field':return state[predicate.field]===predicate.value;
   case 'count':return state.submitted===predicate.value;
   case 'flag':return state[predicate.name]===predicate.value;
   case 'page':return new URL(frame.url).pathname===predicate.path&&frame.title==='Jev '+predicate.path;
  }
 }
 async close(id:string){const s=this.sessions.get(id);if(s){await s.context.close();this.sessions.delete(id);}}
 async shutdown(){await this.browser?.close();this.browser=undefined;this.sessions.clear();}
 get browserVersion(){return this.browser?.version()??'not-started';}
}
