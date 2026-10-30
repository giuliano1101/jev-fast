import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,type Browser,type BrowserContext,type Page} from 'playwright';
import {BrowserAdapter} from '../../src/browser/adapter.js';
import {Engine} from '../../src/core/engine.js';
import {MockProvider} from '../../src/providers/mock.js';
import type {BrowserPort,Snapshot} from '../../src/core/contracts.js';

type SetupStage='route'|'routeWebSocket'|'newPage'|'goto'|'onPage';
function browserBoundary(failure?:SetupStage){
 let failStage=failure;let closeFailures=0;let contextCloses=0;let browserCloses=0;
 const fail=(stage:SetupStage)=>{if(failStage===stage){failStage=undefined;throw new Error('setup '+stage);}};
 const page={setDefaultTimeout(){},on(){},async goto(){fail('goto');}} as unknown as Page;
 const context={async route(){fail('route');},async routeWebSocket(){fail('routeWebSocket');},on(){},async newPage(){fail('newPage');return page;},async close(){contextCloses++;if(closeFailures-->0)throw new Error('context close failed');}} as unknown as BrowserContext;
 const browser={async newContext(){return context;},async close(){browserCloses++;},version(){return 'synthetic';}} as unknown as Browser;
 return {browser,onPage(){fail('onPage');},failClose(count:number){closeFailures=count;},get contextCloses(){return contextCloses;},get browserCloses(){return browserCloses;}};
}

for(const stage of ['route','routeWebSocket','newPage','goto','onPage'] as const){
 test(`adapter releases a context when ${stage} setup fails`,async t=>{
  const boundary=browserBoundary(stage);t.mock.method(chromium,'launch',async()=>boundary.browser);
  const adapter=new BrowserAdapter('http://127.0.0.1:7777',{onPage:boundary.onPage});
  try{
   await assert.rejects(adapter.open('session','standard'),new RegExp('setup '+stage));
   assert.equal(boundary.contextCloses,1);
   await assert.rejects(adapter.observe('session'),/SESSION_UNAVAILABLE/);
   await adapter.close('session');assert.equal(boundary.contextCloses,1);
   await adapter.open('session','standard');await adapter.close('session');assert.equal(boundary.contextCloses,2);
  }finally{await adapter.shutdown();}
 });
}

test('adapter retains failed open cleanup for retry without exposing a session',async t=>{
 const boundary=browserBoundary('goto');boundary.failClose(1);t.mock.method(chromium,'launch',async()=>boundary.browser);
 const adapter=new BrowserAdapter('http://127.0.0.1:7777');
 try{
  await assert.rejects(adapter.open('session','standard'),error=>error instanceof AggregateError&&error.errors.length===2&&/setup goto/.test(String(error.errors[0]))&&/context close failed/.test(String(error.errors[1])));
  await assert.rejects(adapter.observe('session'),/SESSION_UNAVAILABLE/);
  await adapter.close('session');assert.equal(boundary.contextCloses,2);
  await adapter.open('session','standard');await adapter.close('session');assert.equal(boundary.contextCloses,3);
 }finally{await adapter.shutdown();}
});

test('adapter shutdown attempts every context and the browser after a context close failure',async t=>{
 const boundary=browserBoundary();t.mock.method(chromium,'launch',async()=>boundary.browser);
 const adapter=new BrowserAdapter('http://127.0.0.1:7777');
 await adapter.open('first','standard');await adapter.open('second','standard');boundary.failClose(1);
 await assert.rejects(adapter.shutdown(),/context close failed/);
 assert.equal(boundary.contextCloses,2);assert.equal(boundary.browserCloses,1);
 await assert.rejects(adapter.observe('second'),/SESSION_UNAVAILABLE/);
 await adapter.shutdown();assert.equal(boundary.browserCloses,1);
});

class CleanupBrowser implements BrowserPort{
 closes=0;closeFailure=true;gate?:Promise<void>;
 async open(){return {allowed_origin:'http://127.0.0.1:7777'};}
 async observe():Promise<Snapshot>{throw new Error('unexpected observe');}
 async validate():Promise<boolean>{throw new Error('unexpected validate');}
 async execute(){throw new Error('unexpected execute');}
 async check():Promise<boolean>{throw new Error('unexpected check');}
 async close(){this.closes++;await this.gate;if(this.closeFailure)throw new Error('browser close failed');}
}
async function engineFixture(){
 const dir=await mkdtemp(join(tmpdir(),'jev-lifecycle-'));const browser=new CleanupBrowser();
 const engine=await Engine.create({storageDir:dir,browser,provider:new MockProvider(),clients:['a']});
 const {session_id}=await engine.openSession('a',{fixture_id:'standard'});
 return {dir,browser,engine,session_id,async cleanup(){browser.closeFailure=false;await engine.shutdown();await rm(dir,{recursive:true,force:true});}};
}

test('failed close shares in-flight cleanup, blocks actions, then retries and releases capacity',async()=>{
 const f=await engineFixture();let release!:()=>void;f.browser.gate=new Promise<void>(resolve=>{release=resolve;});
 try{
  const first=f.engine.closeSession('a',{session_id:f.session_id});const second=f.engine.closeSession('a',{session_id:f.session_id});
  const outcomes=Promise.allSettled([first,second]);
  while(!f.browser.closes)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.browser.closes,1);release();assert.deepEqual((await outcomes).map(result=>result.status),['rejected','rejected']);
  assert.equal((await f.engine.status('a',{session_id:f.session_id}) as {closed:boolean}).closed,true);
  await assert.rejects(f.engine.observe('a',{session_id:f.session_id}),/SESSION_UNAVAILABLE/);
  await assert.rejects(f.engine.runGoal('a',{session_id:f.session_id,goal_id:'blocked',idempotency_key:'blocked',goal:{task:'form',language:'en',seed:1},success:{kind:'task_complete'}}),/SESSION_UNAVAILABLE/);
  await assert.rejects(f.engine.openSession('a',{fixture_id:'standard'}),/BUSY/);
  const epoch=f.engine.ledger.state.sessions[f.session_id]!.epoch;f.browser.closeFailure=false;
  assert.equal((await f.engine.closeSession('a',{session_id:f.session_id})).closed,true);
  assert.equal(f.browser.closes,2);assert.equal(f.engine.ledger.state.sessions[f.session_id]!.epoch,epoch);
  await f.engine.closeSession('a',{session_id:f.session_id});assert.equal(f.browser.closes,2);
  assert.notEqual((await f.engine.openSession('a',{fixture_id:'standard'})).session_id,f.session_id);
 }finally{release();await f.cleanup();}
});

test('engine shutdown releases ledger ownership when browser cleanup fails and can retry cleanup',async()=>{
 const f=await engineFixture();
 try{
  await assert.rejects(f.engine.shutdown(),/browser close failed/);
  await assert.rejects(access(join(f.dir,'owner.lock')));
  f.browser.closeFailure=false;await f.engine.shutdown();assert.equal(f.browser.closes,2);
 }finally{await f.cleanup();}
});

test('engine shutdown reports both independent cleanup failures',async t=>{
 const f=await engineFixture();const close=f.engine.ledger.close.bind(f.engine.ledger);
 const stub=t.mock.method(f.engine.ledger,'close',async()=>{throw new Error('ledger close failed');});
 try{
  await assert.rejects(f.engine.shutdown(),error=>error instanceof AggregateError&&error.errors.length===2&&error.errors.some(item=>/browser close failed/.test(String(item)))&&error.errors.some(item=>/ledger close failed/.test(String(item))));
 }finally{stub.mock.restore();f.browser.closeFailure=false;await close();await f.cleanup();}
});
