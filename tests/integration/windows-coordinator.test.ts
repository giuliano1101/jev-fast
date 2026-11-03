import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startWindowsCoordinator} from '../../src/windows/coordinator.js';
import {loadWindowsConfig} from '../../src/windows/config.js';
import {parseTool,type JsonObject} from '../../src/windows/network-client.js';
import {offlineWindowsChoice} from '../fixtures/windows-choice.js';
import {windowsWorkbench} from '../fixtures/windows-workbench.js';

test('two actual Codex stdio facades share a browser but isolate owners, same ids and cleanup',{timeout:45000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jev-windows-coordinator-')),configPath=join(root,'windows.json'),site=await windowsWorkbench();
 await writeFile(configPath,JSON.stringify({runtime:join(root,'runtime'),allowedFileRoots:[root],browser:{headless:true}}));const config=await loadWindowsConfig(configPath);
 let decisions=0,arrive:()=>void=()=>{},cancelled:()=>void=()=>{};const waiting=new Promise<void>(done=>{arrive=done;}),wasCancelled=new Promise<void>(done=>{cancelled=done;});
 const coordinator=await startWindowsCoordinator(config,{portFactory:()=>({call:async(name,args,signal)=>{
  if(name==='jev.network_status')return {enabled:true,connector_online:true,local_ready:true,continuation_token:'offline-test-only'};
  if(name==='jev.release_connection')return {released:true};
  if((args.params as JsonObject|undefined)?.task==='Cancel before input.'){arrive();await new Promise<void>(done=>{if(signal?.aborted){cancelled();done();}else signal?.addEventListener('abort',()=>{cancelled();done();},{once:true});});}
  decisions++;return {request_id:args.request_id,delivery_status:'COMPLETED',reply:{ok:true,result:offlineWindowsChoice(args.params)}};
 },close:async()=>{}})});
 const clients:Client[]=[],transports:StdioClientTransport[]=[];
 const connect=async()=>{const c=new Client({name:'offline-owner-test',version:'1'}),t=new StdioClientTransport({command:process.execPath,args:[resolve('dist/src/windows/main.js'),'--config',configPath],stderr:'pipe'});clients.push(c);transports.push(t);let diagnostic='';t.stderr?.on('data',(part:Buffer)=>{diagnostic+=part.toString();});try{await c.connect(t);}catch{throw new Error('FACADE_START_FAILED: '+diagnostic.trim());}return c;};
 const call=async(c:Client,name:string,args:JsonObject)=>parseTool(await c.callTool({name:'jev_windows.'+name,arguments:args}));
 try{
  assert.equal((await fetch(coordinator.url+'/health')).status,403);
  const [a,b]=await Promise.all([connect(),connect()]);assert.equal((await a.listTools()).tools.length,28);assert.equal((await b.listTools()).tools.length,28);
  const [one,two]=await Promise.all([call(a,'browser_open',{url:site.url,operation_id:'same-id'}),call(b,'browser_open',{url:site.url,operation_id:'same-id'})]);assert.notEqual(one.session_id,two.session_id);assert.equal(decisions,2);
  const duplicate=await call(a,'browser_open',{url:site.url,operation_id:'same-id'});assert.equal(duplicate.session_id,one.session_id);assert.equal(decisions,2);
  const denied=await a.callTool({name:'jev_windows.browser_observe',arguments:{session_id:two.session_id}});assert.equal(denied.isError,true);assert.ok(JSON.stringify(denied).includes('BROWSER_SESSION_NOT_OWNED'));
  await call(a,'release',{});
  const observed=await call(b,'browser_observe',{session_id:two.session_id});const state=observed.state as JsonObject;assert.ok(String(state.text).includes('Windows Jev workbench'));
  const input=(state.controls as JsonObject[]).find(c=>String(c.label).includes('Test name'));assert.ok(input);
  const result=await call(b,'browser_act',{operation_id:'b-input',target:two.session_id,snapshot_id:observed.snapshot_id,task:'Fill the synthetic field with Owner B',actions:[{id:'fill',description:'Fill Test name with Owner B',action:{operation:'fill',control_id:input.control_id,value:'Owner B'}}],expected:{control:{control_id:input.control_id,value:'Owner B'}}});assert.equal(result.verified,true);
  assert.equal(decisions,3);
  const fresh=await call(b,'browser_observe',{session_id:two.session_id}),commit=((fresh.state as JsonObject).controls as JsonObject[]).find(c=>c.label==='Commit once');assert.ok(commit);const abort=new AbortController();
  const pending=b.callTool({name:'jev_windows.browser_act',arguments:{operation_id:'cancelled-through-facade',target:two.session_id,snapshot_id:fresh.snapshot_id,task:'Cancel before input.',actions:[{id:'commit',description:'Commit once',action:{operation:'click',control_id:commit.control_id}}],expected:{textIncludes:'Committed'}}},undefined,{signal:abort.signal}).catch(()=>undefined);
  await waiting;abort.abort();await wasCancelled;await pending;
  let outcome:JsonObject|undefined;const deadline=Date.now()+5000;while(Date.now()<deadline){outcome=await call(b,'operation_status',{operation_id:'cancelled-through-facade'});if(outcome.phase==='rejected')break;await sleep(25);}
  assert.equal(outcome?.phase,'rejected');assert.equal(site.committed,0);await call(b,'release',{});
 }finally{for(const client of clients)await client.close();for(const transport of transports)await transport.close();await coordinator.close();await site.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
