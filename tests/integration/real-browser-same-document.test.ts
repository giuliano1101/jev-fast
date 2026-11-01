import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RealBrowserService} from '../../src/browser/real.js';
import type {ChoiceResponse} from '../../src/choice/contracts.js';
for(const navigation of ['hash','pushState'] as const)test(`${navigation} navigation keeps the current DOM observable without another DOMContentLoaded`,{timeout:20000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'jev-same-document-'));let documents=0;
 const server=createServer((request,response)=>{if(request.headers['sec-fetch-dest']==='document')documents++;response.setHeader('content-type','text/html');response.end(`<h1>Same document is ready</h1>${navigation==='hash'?'<a href="#section">Change hash</a>':'<button onclick="history.pushState({},String(),String.fromCharCode(47,99,104,97,110,103,101,100))">Change route</button>'}<button>Continue task</button>`);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
 const service=new RealBrowserService({storageDir:directory,chooseAction:async(_owner,args)=>({provider:'jev',model:'jev-1.14.0',selected_id:args.actions[0]!.id,confidence:1,usage:null,proof:{payload:{},signature:'offline-test'}} as unknown as ChoiceResponse)});
 try{
  const opened=await service.open('owner',{url:`http://127.0.0.1:${address.port}/`}),control=opened.observation.controls.find(value=>value.label===(navigation==='hash'?'Change hash':'Change route'))!;
  const result=await service.act('owner',{session_id:opened.session_id,snapshot_id:opened.observation.snapshot_id,idempotency_key:'same-document',task:'Change route once',actions:[{id:'change',operation:'click',control_id:control.control_id}],timeout_ms:2000});assert.equal(result.execution,'executed',result.reason);
  let observed=result.after!;for(let attempt=0;attempt<20;attempt++){if(observed.url.endsWith(navigation==='hash'?'#section':'/changed')&&!observed.navigation_pending)break;await new Promise(resolve=>setTimeout(resolve,10));observed=await service.observe('owner',{session_id:opened.session_id});}
  assert.equal(observed.navigation_pending??false,false,'a same-document navigation never waits for a new DOMContentLoaded');assert.match(observed.text,/Same document is ready/);assert.ok(observed.controls.some(value=>value.label==='Continue task'));assert.ok(observed.url.endsWith(navigation==='hash'?'#section':'/changed'));
  assert.equal(documents,1,'same-document route changes must not fetch a replacement document');
 }finally{await service.shutdown();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}
});

test('a pending external main-document navigation fences the old snapshot before choosing an input',{timeout:20000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'jev-stale-pending-'));let entered!:()=>void,calls=0;const entering=new Promise<void>(resolve=>{entered=resolve;});
 const server=createServer((request,response)=>{if(request.url==='/pending-document'){entered();return;}response.setHeader('content-type','text/html');response.end('<button>Current control</button>');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
 const service=new RealBrowserService({storageDir:directory,chooseAction:async()=>{calls++;throw new Error('stale snapshot must never choose');}});let navigation:Promise<unknown>|undefined;
 try{
  const opened=await service.open('owner',{url:origin}),control=opened.observation.controls[0]!;
  const page=(service as unknown as {sessions:Map<string,{page:import('playwright').Page}>}).sessions.get(opened.session_id)!.page;
  navigation=page.goto(origin+'/pending-document',{waitUntil:'commit',timeout:0});void navigation.catch(()=>{});await entering;
  await assert.rejects(service.act('owner',{session_id:opened.session_id,snapshot_id:opened.observation.snapshot_id,idempotency_key:'stale-input',task:'Click the old control',actions:[{id:'click',operation:'click',control_id:control.control_id}],timeout_ms:200}),/STALE_SNAPSHOT/);assert.equal(calls,0);
 }finally{server.closeAllConnections();await service.shutdown();await navigation?.catch(()=>{});await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}
});
