import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {launchChallengeBrowser} from '../../bench/live/challenge.js';
import {runHybridSession,type HybridAdapter,type HybridCatalog} from '../../bench/hybrid/controller.js';

test('hybrid controller handles real rendered filter reset and transient labels without replay',{timeout:30000},async()=>{
 const html=await readFile(new URL('../../../fixtures/hybrid-flow.html',import.meta.url),'utf8').catch(()=>null);
 assert.ok(html,'hybrid fault fixture must exist');
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(html);});server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
 const browser=await launchChallengeBrowser();
 try{for(const mode of ['reset','transient']){
  const page=await browser.newPage();await page.goto(`${origin}/?mode=${mode}`);let serial=0;let last='';
  const actions=['sort','published','image'];
  const catalog:HybridCatalog={predicateIds:['ready',...actions],actions:actions.map(actionId=>({actionId,preconditions:['ready'],postconditions:[actionId],mayInvalidate:actionId==='sort'?['published','image']:[],safeRepeat:true,deterministic:false}))};
  const adapter:HybridAdapter={
   observe:async()=>{const state=await page.locator('#controls').evaluate(el=>({busy:el.getAttribute('aria-busy')==='true',values:Object.fromEntries(Array.from(el.querySelectorAll('button')).map(b=>[b.id,b.getAttribute('aria-pressed')==='true']))}));last=`observation-${++serial}`;return {observationId:last,stateKey:'filter-start',readiness:state.busy?'pending':'settled',predicates:{ready:!state.busy,...state.values},visibleActionIds:state.busy?[]:actions};},
   bind:async(actionId,observation)=>observation.observationId===last?{actionId,observationId:last,token:`${last}:${actionId}`}:null,
   execute:async(binding)=>{if(binding.token!==`${last}:${binding.actionId}`)return {status:'rejected'};await page.getByRole('button',{name:{sort:'Highest views',published:'Published',image:'Image text'}[binding.actionId]!,exact:true}).click();return {status:'executed'};},
  };
  const result=await runHybridSession({sessionId:`ui-${mode}`,leaseKey:'hybrid-ui-fixture',scope:{applicationId:'fixture',pageType:'filters',accountScope:'a'.repeat(64),environmentFingerprint:'b'.repeat(64),language:'en',observerVersion:'v1'},catalog,goalPredicates:actions,adapter,teacher:async()=>({actionIds:actions})});
  assert.equal(result.status,'SUCCEEDED',JSON.stringify(result));
  assert.equal(result.teacherHandoffs,1);assert.equal(result.actions,mode==='reset'?3:1);
  assert.equal(await page.locator('#counts').innerText(),mode==='reset'?'sort:1 published:1 image:1':'sort:1 published:0 image:0');
  for(const id of actions)assert.equal(await page.locator(`#${id}`).getAttribute('aria-pressed'),'true');
  await page.close();
 }}finally{await browser.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
