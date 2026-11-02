import {offlineWindowsChoice} from '../fixtures/windows-choice.js';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright';
import {chromiumExecutable} from '../../src/browser/executable.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {windowsWorkbench} from '../fixtures/windows-workbench.js';
import {WindowsBrowser} from '../../src/windows/browser.js';
import {PrivateStore} from '../../src/windows/store.js';
import {JevNetworkClient,type JsonObject} from '../../src/windows/network-client.js';
import {ActionRouter} from '../../src/windows/router.js';
import {LocalPanel} from '../../src/windows/panel.js';
import {inspectArtifact} from '../../src/windows/artifacts.js';

test('browser snapshots allow countdown-only resize and reject an indistinguishable replacement control',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jev-windows-grounding-')),site=await windowsWorkbench(),store=new PrivateStore(join(root,'journal'));await store.initialize();let replace=false;
 const network=new JevNetworkClient(store,{call:async(name,args)=>{if(name==='jev.network_status')return {enabled:true,connector_online:true,local_ready:true};if(replace)await site.replaceIdenticalControl();else await sleep(100);return {request_id:args.request_id,delivery_status:'COMPLETED',reply:{ok:true,result:offlineWindowsChoice(args.params)}};},close:async()=>{}});
 const browser=new WindowsBrowser({runtime:root,profile:join(root,'profile'),headless:true,allowedFileRoots:[root]}),router=new ActionRouter(store,network);const session=await browser.open();
 const action=async(input:JsonObject,expected:JsonObject)=>{const observed=await browser.observe(session.session_id);return await router.act(browser.executor(session.session_id),{operation_id:randomUUID(),target:session.session_id,snapshot_id:observed.snapshot_id,task:'Synthetic grounding regression',actions:[{id:'selected',description:'Perform the authorized regression action',action:input}],expected});};
 try{
  await action({operation:'navigate',url:site.url+'/dynamic'},{urlIncludes:'/dynamic'});assert.equal((await action({operation:'resize',width:390,height:844},{viewport:{width:390,height:844}})).verified,true);
  await action({operation:'navigate',url:site.url+'/replace'},{urlIncludes:'/replace'});const observed=await browser.observe(session.session_id),control=(observed.state.controls as JsonObject[]).find(c=>c.label==='Same control');assert.ok(control);replace=true;
  await assert.rejects(router.act(browser.executor(session.session_id),{operation_id:randomUUID(),target:session.session_id,snapshot_id:observed.snapshot_id,task:'Reject a replaced control',actions:[{id:'selected',description:'Click the original observed control',action:{operation:'click',control_id:control.control_id}}],expected:{textIncludes:'never'}}),/CONTROL_UNAVAILABLE/);assert.equal(site.committed,0);
 }finally{await browser.shutdown();await site.close();await store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('Windows actual browser supports controls, iframe, popup, upload/download, touch and persistent test login without hosted calls',{timeout:90000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jev-windows-browser-')),site=await windowsWorkbench(),store=new PrivateStore(join(root,'journal'));await store.initialize();
 const network=new JevNetworkClient(store,{call:async(name,args)=>name==='jev.network_status'?{enabled:true,connector_online:true,local_ready:true,continuation_token:'offline-test'}:{request_id:args.request_id,delivery_status:'COMPLETED',reply:{ok:true,result:offlineWindowsChoice(args.params)}},close:async()=>{}});
 const browser=new WindowsBrowser({runtime:root,profile:join(root,'profile'),headless:true,allowedFileRoots:[root]});
 const router=new ActionRouter(store,network);let session=await browser.open();
 const step=async(action:JsonObject,expected:JsonObject)=>{const observed=await browser.observe(session.session_id);const result=await router.act(browser.executor(session.session_id),{operation_id:randomUUID(),target:session.session_id,snapshot_id:observed.snapshot_id,task:'Offline acceptance workbench action',actions:[{id:'selected',description:'Perform this authorized workbench action',action}],expected});assert.equal(result.verified,true);return result;};
 const control=async(label:string)=>{const o=await browser.observe(session.session_id);return (o.state.controls as JsonObject[]).find(c=>String(c.label).includes(label))!.control_id;};
 try{
  await step({operation:'navigate',url:site.url},{textIncludes:'Windows Jev workbench'});
  const name=await control('Test name');await step({operation:'fill',control_id:name,value:'Alice'},{control:{control_id:name,value:'Alice'}});
  const category=await control('Category');await step({operation:'select',control_id:category,value:'b'},{control:{control_id:category,value:'b'}});
  await step({operation:'click',control_id:await control('Commit once')},{textIncludes:'Committed 1 Alice b'});assert.equal(site.committed,1);
  const input=join(root,'upload.txt');await writeFile(input,'test fixture');await step({operation:'upload',control_id:await control('Upload file'),paths:[input]},{textIncludes:'Uploaded upload.txt'});
  await step({operation:'click',control_id:await control('Download PDF')},{downloadCount:1});
  const observed=await browser.observe(session.session_id),download=(observed.state.downloads as JsonObject[])[0]!;assert.equal((await inspectArtifact(String(download.path),[root])).readable,true);
  await step({operation:'click',control_id:await control('Download ZIP')},{downloadCount:2});
  const zipState=await browser.observe(session.session_id),zip=(zipState.state.downloads as JsonObject[]).find(file=>file.name==='acceptance.zip');assert.ok(zip);assert.equal((await inspectArtifact(String(zip.path),[root])).full_document_validation,true);
  const frameControl=await control('Frame action');await step({operation:'click',control_id:frameControl},{control:{control_id:frameControl,label:'Frame done'}});
  await step({operation:'tap',control_id:await control('Test canvas'),x:20,y:20},{textIncludes:'Touches: 1'});
  await step({operation:'replay',control_id:await control('Test canvas'),steps:[{kind:'tap',x:20,y:20,delay_ms:10},{kind:'tap',x:30,y:30,delay_ms:10}]},{textIncludes:'Touches: 3'});
  assert.equal((await browser.diagnostics(session.session_id)).state.canvases.length,1);
  await step({operation:'resize',width:390,height:844},{viewport:{width:390,height:844}});assert.equal((await browser.screenshot(session.session_id)).readable,true);
  await step({operation:'click',control_id:await control('Open popup')},{textIncludes:'Independent popup ready'});
  await step({operation:'navigate',url:site.url+'/login'},{textIncludes:'Test login retained'});await browser.shutdown();
  session=await browser.open();await step({operation:'navigate',url:site.url+'/session'},{textIncludes:'Authenticated test session'});
 }finally{await browser.shutdown();await site.close();await store.close();await rm(root,{recursive:true,force:true});}
});
test('CDP attachment reuses an existing test login and disconnects without closing pre-existing tabs',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'jev-windows-cdp-')),site=await windowsWorkbench(),profile=join(root,'external-profile');
 const child=spawn(chromiumExecutable(),['--headless=new','--no-sandbox','--remote-debugging-port=0','--no-first-run','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let external:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined;let browser:WindowsBrowser|undefined;
 try{
  const deadline=Date.now()+10000;let port:string|undefined;
  while(Date.now()<deadline&&!port){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{await sleep(100);}}
  assert.ok(port);const cdpUrl='http://127.0.0.1:'+port;external=await chromium.connectOverCDP(cdpUrl);const original=external.contexts()[0]!.pages()[0]!;await original.goto(site.url+'/login');
  browser=new WindowsBrowser({runtime:root,profile:join(root,'unused-profile'),cdpUrl,allowedFileRoots:[root]});const s=await browser.open();await browser.validate(s.session_id,s.snapshot_id,{operation:'navigate',url:site.url+'/session'});await browser.execute(s.session_id,{operation:'navigate',url:site.url+'/session'});assert.equal((await browser.verify(s.session_id,{textIncludes:'Authenticated test session'})).met,true);
  await browser.shutdown();assert.equal(original.isClosed(),false);await original.goto(site.url+'/session');assert.match(await original.locator('body').innerText(),/Authenticated test session/);
 }finally{await browser?.shutdown();await external?.close();child.kill();await site.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
test('configured panel actions verify actual HTTP receipt and current state, never a live stream',{timeout:15000},async()=>{
 const site=await windowsWorkbench(),panel=new LocalPanel({id:'test-panel',url:site.url,statusPath:'/api/status',actions:{ready:{method:'POST',path:'/api/action',body:{}}}});
 try{const before=await panel.observe(),executor=panel.executor();await executor.validate('test-panel',before.snapshot_id,{action_id:'ready'});const result=await executor.execute('test-panel',{action_id:'ready'});assert.equal((await executor.verify('test-panel',{statePointer:'/state',equals:'ready',receiptPointer:'/receipt',receiptEquals:'ack-'+site.nonce},result)).met,true);await assert.rejects(executor.validate('test-panel',before.snapshot_id,{action_id:'ready'}),/STALE_SNAPSHOT/);await assert.rejects(executor.validate('test-panel',(await panel.observe()).snapshot_id,{action_id:'not-configured'}),/PANEL_ACTION_NOT_CONFIGURED/);}finally{await site.close();}
});
test('artifact inspection rejects a disguised HTML download and files outside authorized roots',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jev-windows-artifact-'));try{const path=join(root,'fake.pdf');await writeFile(path,'<html>expired login</html>');await assert.rejects(inspectArtifact(path,[root]),/INVALID_PDF_ARTIFACT/);await assert.rejects(inspectArtifact(resolve('package.json'),[root]),/FILE_OUTSIDE_AUTHORIZED_ROOTS/);}finally{await rm(root,{recursive:true,force:true});}
});
