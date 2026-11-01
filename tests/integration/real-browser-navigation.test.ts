import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RealBrowserService} from '../../src/browser/real.js';
import type {ChoiceResponse} from '../../src/choice/contracts.js';
for(const operation of ['click','press'] as const)test(`${operation} returns DOM-ready navigation without waiting for a hanging image`,{timeout:20000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'jev-navigation-'));let submitted=0,images=0,domReady=0;
 const server=createServer((request,response)=>{
  if(request.url==='/never-image'){images++;response.writeHead(200,{'content-type':'image/png'});response.write(Buffer.from([137,80,78,71]));return;}
  if(request.url==='/dom-ready'){domReady++;response.end('ok');return;}
  response.setHeader('content-type','text/html');
  if(request.url?.startsWith('/results')){submitted++;response.end('<h1>Search result is ready</h1><img src="/never-image"><script>document.addEventListener("DOMContentLoaded",()=>fetch("/dom-ready"))</script>');return;}
  response.end('<form action="/results"><label>Search <input name="query" value="public browsing"></label><button>Search now</button></form>');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
 const service=new RealBrowserService({storageDir:directory,chooseAction:async(_owner,args)=>({provider:'jev',model:'jev-1.14.0',selected_id:args.actions[0]!.id,confidence:1,usage:null,proof:{payload:{},signature:'offline-test'}} as unknown as ChoiceResponse)});
 try{
  const opened=await service.open('owner',{url:`http://127.0.0.1:${address.port}/`}),control=opened.observation.controls.find(value=>value.tag===(operation==='click'?'button':'input'))!;
  const args={session_id:opened.session_id,snapshot_id:opened.observation.snapshot_id,idempotency_key:'submit',task:'Search once',actions:[{id:'search',operation,control_id:control.control_id,...(operation==='press'?{key:'Enter'}:{})}],timeout_ms:1500,postcondition:{textIncludes:'Search result is ready'}};
  const result=await service.act('owner',args);assert.equal(result.execution,'executed',result.reason);
  let after=result.after!;for(let attempt=0;!after.text.includes('Search result is ready')&&attempt<50;attempt++){await new Promise(resolve=>setTimeout(resolve,10));after=await service.observe('owner',{session_id:opened.session_id});}
  assert.equal(submitted,1);assert.ok(images>0);assert.match(after.text,/Search result is ready/);
  if(result.postcondition_met)assert.match(result.after!.text,/Search result is ready/);
  for(let attempt=0;domReady===0&&attempt<50;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(domReady>0,'DOMContentLoaded must fire while the image remains unfinished');
  assert.deepEqual(await service.act('owner',args),result);assert.equal(submitted,1);
 }finally{server.closeAllConnections();await service.shutdown();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}
});

for(const operation of ['click','press'] as const)test(`${operation} reports the actual current page while its main-document navigation is still pending`,{timeout:20000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'jev-pending-navigation-'));let submitted=0;
 const server=createServer((request,response)=>{
  if(request.url?.startsWith('/pending-results')){submitted++;return;}
  response.setHeader('content-type','text/html');response.end('<h1>Search page</h1><form action="/pending-results"><label>Search <input name="query"></label><button>Search now</button></form>');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
 const service=new RealBrowserService({storageDir:directory,chooseAction:async(_owner,args)=>({provider:'jev',model:'jev-1.14.0',selected_id:args.actions[0]!.id,confidence:1,usage:null,proof:{payload:{},signature:'offline-test'}} as unknown as ChoiceResponse)});
 try{
  const opened=await service.open('owner',{url:`http://127.0.0.1:${address.port}/`}),control=opened.observation.controls.find(value=>value.tag===(operation==='click'?'button':'input'))!;
  const args={session_id:opened.session_id,snapshot_id:opened.observation.snapshot_id,idempotency_key:'pending-submit',task:'Search once',actions:[{id:'search',operation,control_id:control.control_id,...(operation==='press'?{key:'Enter'}:{})}],timeout_ms:800,postcondition:{textIncludes:'Search result is ready'}};
  const result=await service.act('owner',args);assert.equal(result.execution,'executed',result.reason);
  for(let attempt=0;submitted===0&&attempt<50;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(submitted,1);assert.equal(result.postcondition_met,false);
  const pending=await service.observe('owner',{session_id:opened.session_id});assert.equal(pending.navigation_pending,true);assert.equal(pending.text,'');assert.deepEqual(pending.controls,[]);
  assert.deepEqual(await service.act('owner',args),result);assert.equal(submitted,1);
 }finally{server.closeAllConnections();await service.shutdown();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true});}
});
