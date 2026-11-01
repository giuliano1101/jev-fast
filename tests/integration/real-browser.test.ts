import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RealBrowserService} from '../../src/browser/real.js';
import type {ChoiceArgs,ChoiceResponse} from '../../src/choice/contracts.js';
const fakeDecision=(args:ChoiceArgs)=>({provider:'jev',model:'jev-1.14.0',selected_id:args.actions[0]!.id,confidence:1,usage:null,proof:{payload:{},signature:'offline-test'}} as unknown as ChoiceResponse);
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'jev-real-browser-'));let submissions=0,calls=0;let lastChoice:ChoiceArgs|undefined;
 const server=createServer((req,res)=>{if(req.url==='/password'){res.setHeader('content-type','text/html');res.end('<label>Account password <input type="password" name="password"></label>');return;}if(req.url==='/suppressed-popup'){res.setHeader('content-type','text/html');res.end('<a href="/unused" target="_blank" onclick="event.preventDefault();this.textContent=String.fromCharCode(72,97,110,100,108,101,100)">Open intercepted link</a>');return;}if(req.url==='/overlay'){res.setHeader('content-type','text/html');res.end('<form action="/submit"><button>Send overlay</button></form><div id="cover" style="position:fixed;inset:0;background:white;z-index:99">Loading overlay</div><script>setTimeout(()=>document.getElementById("cover").remove(),1000)</script>');return;}if(req.url==='/redirect'){res.writeHead(302,{location:'/landing'});res.end();return;}if(req.url?.startsWith('/submit'))submissions++;res.setHeader('content-type','text/html');res.end(req.url?.startsWith('/submit')?'<h1>Order received</h1><a href="/unusual/path">Return</a>':'<h1>Independent public-style form</h1><form action="/submit"><label>Your custom note <input name="note"></label><button>Send note</button></form><a href="/redirect">Redirect elsewhere</a><a href="/popup" target="_blank">Open popup</a><label>Choose category <select><option value="a">Alpha</option><option value="z">Zeta</option></select></label><div style="height:1400px"></div>');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}/unusual/path`;
 const service=new RealBrowserService({storageDir:dir,chooseAction:async(_client:string,args:ChoiceArgs)=>{calls++;lastChoice=args;return fakeDecision(args);}});
 return {dir,url,service,get submissions(){return submissions;},get calls(){return calls;},get lastChoice(){return lastChoice;},async cleanup(){await service.shutdown();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(dir,{recursive:true,force:true});}};
}
test('real website observation grounds arbitrary values and executes only selected actions with durable replay protection',{timeout:30000},async()=>{
 const f=await setup();try{
  const opened=await f.service.open('owner',{url:f.url}),observation=await f.service.observe('owner',{session_id:opened.session_id});
  assert.match(observation.text,/Independent public-style form/);const input=observation.controls.find(control=>control.label.includes('custom note'))!;assert.ok(input);
  const fill={session_id:opened.session_id,snapshot_id:observation.snapshot_id,idempotency_key:'fill',task:'Write an arbitrary customer note',actions:[{id:'type',operation:'fill',control_id:input.control_id,value:'not a canonical fixture value'}]};
  const filled=await f.service.act('owner',fill);assert.equal(filled.execution,'executed');assert.equal(filled.selected_id,'type');assert.ok(filled.after);
  const button=filled.after!.controls.find(control=>control.label==='Send note')!;
  const submit={session_id:opened.session_id,snapshot_id:filled.after!.snapshot_id,idempotency_key:'submit',task:'Submit note',actions:[{id:'send',operation:'click',control_id:button.control_id}],postcondition:{textIncludes:'Order received'}};
  const result=await f.service.act('owner',submit);assert.equal(result.execution,'executed');let after=result.after!;for(let attempt=0;!after.text.includes('Order received')&&attempt<50;attempt++){await new Promise(resolve=>setTimeout(resolve,10));after=await f.service.observe('owner',{session_id:opened.session_id});}assert.match(after.text,/Order received/);if(result.postcondition_met)assert.match(result.after!.text,/Order received/);assert.match(after.url,/note=not\+a\+canonical/);assert.equal(f.submissions,1);
  assert.deepEqual(await f.service.act('owner',submit),result);assert.equal(f.submissions,1);assert.equal(f.calls,2);
  await assert.rejects(f.service.act('owner',{...submit,task:'Changed task'}),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(f.service.observe('other',{session_id:opened.session_id}),/UNAUTHORIZED/);
 }finally{await f.cleanup();}
});
test('real browser sessions are independent and a revoked owner cannot continue',{timeout:30000},async()=>{
 const f=await setup();try{const [a,b]=await Promise.all([f.service.open('a',{url:f.url}),f.service.open('b',{url:f.url})]);await f.service.revokeOwner('a');await assert.rejects(f.service.observe('a',{session_id:a.session_id}),/UNAUTHORIZED/);assert.match((await f.service.observe('b',{session_id:b.session_id})).text,/Independent/);}finally{await f.cleanup();}
});
test('a stale snapshot after page changes cannot dispatch a physical action',{timeout:30000},async()=>{
 const f=await setup();try{const {session_id}=await f.service.open('owner',{url:f.url}),first=await f.service.observe('owner',{session_id});await f.service.observe('owner',{session_id});await assert.rejects(f.service.act('owner',{session_id,snapshot_id:first.snapshot_id,idempotency_key:'stale',task:'Submit',actions:[{id:'send',operation:'click',control_id:first.controls.find(control=>control.label==='Send note')!.control_id}]}),/STALE_SNAPSHOT/);assert.equal(f.calls,0);assert.equal(f.submissions,0);}finally{await f.cleanup();}
});

test('a committed click whose after-state response is lost stays UNKNOWN and never resubmits',{timeout:30000},async t=>{
 const f=await setup();try{
  const {session_id}=await f.service.open('owner',{url:f.url}),before=await f.service.observe('owner',{session_id});
  const submit={session_id,snapshot_id:before.snapshot_id,idempotency_key:'lost-response',task:'Submit once',actions:[{id:'send',operation:'click',control_id:before.controls.find(control=>control.label==='Send note')!.control_id}]};
  const boundary=f.service as unknown as {capture(...args:unknown[]):Promise<unknown>};const original=boundary.capture;
  t.mock.method(boundary,'capture',async()=>{for(let attempt=0;f.submissions===0&&attempt<50;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.submissions,1);throw new Error('AFTER_RESPONSE_LOST');});
  const result=await f.service.act('owner',submit);assert.equal(result.execution,'unknown');assert.equal(f.submissions,1);
  assert.deepEqual(await f.service.act('owner',submit),result);assert.equal(f.submissions,1);assert.equal(f.calls,1);
  boundary.capture=original;
  let observed=await f.service.observe('owner',{session_id});for(let attempt=0;!observed.text.includes('Order received')&&attempt<50;attempt++){await new Promise(resolve=>setTimeout(resolve,10));observed=await f.service.observe('owner',{session_id});}assert.match(observed.text,/Order received/);
  await f.service.shutdown();const recovered=new RealBrowserService({storageDir:f.dir,chooseAction:async()=>{throw new Error('must not choose after restart');}});
  try{assert.deepEqual(await recovered.act('owner',submit),result);await assert.rejects(recovered.observe('owner',{session_id}),/SESSION_UNAVAILABLE/);}finally{await recovered.shutdown();}
 }finally{await f.cleanup();}
});

test('owner revocation cancels an outstanding choice before input and fences its late answer',{timeout:30000},async()=>{
 const f=await setup();await f.service.shutdown();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const service=new RealBrowserService({storageDir:f.dir,chooseAction:async(_client,args)=>{entered();await gate;return fakeDecision(args);}});
 try{
  const {session_id}=await service.open('owner',{url:f.url}),before=await service.observe('owner',{session_id});
  const running=service.act('owner',{session_id,snapshot_id:before.snapshot_id,idempotency_key:'revoked',task:'Submit once',actions:[{id:'send',operation:'click',control_id:before.controls.find(control=>control.label==='Send note')!.control_id}]});await started;
  await service.revokeOwner('owner');const cancelled=await running;assert.equal(cancelled.execution,'unknown');assert.equal(cancelled.reason,'BROWSER_ACTION_CANCELLED');release();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.submissions,0);
 }finally{release?.();await service.shutdown();await f.cleanup();}
});

test('real browser supports selection, key input, redirects, back, popups and viewport scrolling',{timeout:30000},async()=>{
 const f=await setup();try{
  const opened=await f.service.open('owner',{url:f.url});let after=opened.observation;let round=0;
  const act=async(action:Record<string,unknown>)=>{const result=await f.service.act('owner',{session_id:opened.session_id,snapshot_id:after.snapshot_id,idempotency_key:'round'+round++,task:'Exercise a real website control',actions:[{id:'chosen',...action}]});assert.equal(result.execution,'executed',result.reason);after=result.after!;};
  await act({operation:'select',control_id:after.controls.find(control=>control.tag==='select')!.control_id,value:'z'});
  await act({operation:'press',control_id:after.controls.find(control=>control.tag==='input')!.control_id,key:'Tab'});
  await act({operation:'navigate',url:new URL('/redirect',f.url).href});assert.match(after.url,/\/landing$/);
  await act({operation:'back'});assert.equal(after.url,f.url);
  await act({operation:'click',control_id:after.controls.find(control=>control.label==='Open popup')!.control_id});for(let attempt=0;!after.url.endsWith('/popup')&&attempt<30;attempt++){await new Promise(resolve=>setTimeout(resolve,10));after=await f.service.observe('owner',{session_id:opened.session_id});}assert.match(after.url,/\/popup$/);
  await act({operation:'scroll',dy:900});assert.ok(after.viewport.scrollY>0);
 }finally{await f.cleanup();}
});

test('a real decision may take longer than fixture freshness windows without a hidden goal timeout',{timeout:30000},async()=>{
 const f=await setup();await f.service.shutdown();const service=new RealBrowserService({storageDir:f.dir,chooseAction:async(_client,args)=>{await new Promise(resolve=>setTimeout(resolve,2100));return fakeDecision(args);}});
 try{const opened=await service.open('owner',{url:f.url}),control=opened.observation.controls.find(value=>value.tag==='input')!;const result=await service.act('owner',{session_id:opened.session_id,snapshot_id:opened.observation.snapshot_id,idempotency_key:'slow-real-decision',task:'Fill the custom note',actions:[{id:'fill',operation:'fill',control_id:control.control_id,value:'Allowed after a slow model decision'}]});assert.equal(result.execution,'executed',result.reason);}finally{await service.shutdown();await f.cleanup();}
});

test('a timed-out click cannot dispatch later when an overlay disappears',{timeout:30000},async()=>{
 const f=await setup();try{
  const opened=await f.service.open('owner',{url:new URL('/overlay',f.url).href}),button=opened.observation.controls.find(control=>control.label==='Send overlay')!;
  const result=await f.service.act('owner',{session_id:opened.session_id,snapshot_id:opened.observation.snapshot_id,idempotency_key:'late-click',task:'Submit once',actions:[{id:'send',operation:'click',control_id:button.control_id}],timeout_ms:100});assert.equal(result.execution,'unknown');assert.equal(result.reason,'BROWSER_CALLER_TIMEOUT');
  await new Promise(resolve=>setTimeout(resolve,2800));assert.equal(f.submissions,0,'cancelled browser input must never dispatch after the response');
 }finally{await f.cleanup();}
});

test('a target-blank link intercepted by the website does not wait forever for a nonexistent popup',{timeout:30000},async()=>{
 const f=await setup();let running:Promise<unknown>|undefined;try{
  const opened=await f.service.open('owner',{url:new URL('/suppressed-popup',f.url).href}),link=opened.observation.controls.find(control=>control.label==='Open intercepted link')!;
  running=f.service.act('owner',{session_id:opened.session_id,snapshot_id:opened.observation.snapshot_id,idempotency_key:'intercepted-popup',task:'Open intercepted link',actions:[{id:'click',operation:'click',control_id:link.control_id}]});
  const result=await Promise.race([running,new Promise<undefined>(resolve=>setTimeout(resolve,700))]);assert.ok(result,'successful intercepted link must settle without waiting for a nonexistent popup');
 }finally{await f.cleanup();await running;}
});

test('failed context cleanup cannot acknowledge cancellation before the input command drains',{timeout:30000},async t=>{
 const f=await setup();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let running:Promise<unknown>|undefined;let restore:()=>void=()=>{};
 try{
  const opened=await f.service.open('owner',{url:f.url}),button=opened.observation.controls.find(control=>control.label==='Send note')!;
  const boundary=f.service as unknown as {execute(...args:unknown[]):Promise<void>;sessions:Map<string,{context:{close():Promise<void>}}>};
  t.mock.method(boundary,'execute',async()=>gate);const context=boundary.sessions.get(opened.session_id)!.context,original=context.close.bind(context);const stub=t.mock.method(context,'close',async()=>{throw new Error('context cleanup failed');});restore=()=>{stub.mock.restore();context.close=original;};
  let settled=false;running=f.service.act('owner',{session_id:opened.session_id,snapshot_id:opened.observation.snapshot_id,idempotency_key:'cleanup-drain',task:'Submit',actions:[{id:'send',operation:'click',control_id:button.control_id}],timeout_ms:50}).finally(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(settled,false,'cancellation must await the in-flight command even if context.close rejects');release();await running;
 }finally{release();await running;restore();await f.cleanup();}
});

test('caller timeout covers initial browser validation before choosing or dispatching',{timeout:30000},async t=>{
 const f=await setup();try{
  const opened=await f.service.open('owner',{url:f.url}),button=opened.observation.controls.find(control=>control.label==='Send note')!;
  const boundary=f.service as unknown as {validate(...args:unknown[]):Promise<void>};t.mock.method(boundary,'validate',async()=>new Promise(()=>{}));
  await assert.rejects(f.service.act('owner',{session_id:opened.session_id,snapshot_id:opened.observation.snapshot_id,idempotency_key:'validation-timeout',task:'Submit',actions:[{id:'send',operation:'click',control_id:button.control_id}],timeout_ms:30}),/CANCELLED/);assert.equal(f.calls,0);assert.equal(f.submissions,0);
 }finally{await f.cleanup();}
});

test('password input remains on the host and never enters model choice descriptions',{timeout:30000},async()=>{
 const f=await setup();try{
  const opened=await f.service.open('owner',{url:new URL('/password',f.url).href}),control=opened.observation.controls.find(value=>value.tag==='input')!,password='Private-credential-for-offline-test';
  const result=await f.service.act('owner',{session_id:opened.session_id,snapshot_id:opened.observation.snapshot_id,idempotency_key:'private-password',task:'Fill the supplied account password',actions:[{id:'fill',operation:'fill',control_id:control.control_id,value:password}]});assert.equal(result.execution,'executed');assert.ok(!JSON.stringify(f.lastChoice).includes(password));assert.ok(!JSON.stringify(result).includes(password));
 }finally{await f.cleanup();}
});

test('browser failures expose safe phase and error codes without raw website details',{timeout:30000},async t=>{
 const f=await setup();try{
  const cases=[{name:'TimeoutError',message:'private website detail',code:'BROWSER_EXECUTE_TIMEOUT'},{name:'Error',message:'page.press: net::ERR_CONNECTION_RESET at https://private.invalid/?password=private-value',code:'BROWSER_EXECUTE_NETWORK_ERR_CONNECTION_RESET'},{name:'Error',message:'Target page, context or browser has been closed',code:'BROWSER_EXECUTE_CONTEXT_CLOSED'},{name:'Error',message:'private website detail',code:'BROWSER_EXECUTE_FAILED'}];
  for(const failure of cases){
   const opened=await f.service.open('owner',{url:f.url}),button=opened.observation.controls.find(value=>value.tag==='button')!;
   const boundary=f.service as unknown as {execute(...args:unknown[]):Promise<void>};const stub=t.mock.method(boundary,'execute',async()=>{const error=new Error(failure.message);error.name=failure.name;throw error;});
   try{const result=await f.service.act('owner',{session_id:opened.session_id,snapshot_id:opened.observation.snapshot_id,idempotency_key:'diagnostic',task:'Submit once',actions:[{id:'submit',operation:'click',control_id:button.control_id}]});assert.equal(result.execution,'unknown');assert.equal(result.reason,failure.code);assert.ok(!JSON.stringify(result).includes('private-value'));}finally{stub.mock.restore();}
  }
 }finally{await f.cleanup();}
});
