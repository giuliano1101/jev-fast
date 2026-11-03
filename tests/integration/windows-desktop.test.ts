import {offlineWindowsChoice} from '../fixtures/windows-choice.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {WindowsDesktop} from '../../src/windows/desktop.js';
import {PrivateStore} from '../../src/windows/store.js';
import {JevNetworkClient,parseTool,type JsonObject} from '../../src/windows/network-client.js';
import {ActionRouter} from '../../src/windows/router.js';

test('Windows UIA executor reads and operates a real isolated WPF test window',{skip:process.platform!=='win32'||process.env.CI==='true',timeout:90000},async()=>{
 const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-STA','-File',resolve('tests/fixtures/windows-desktop.ps1')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 const target=await new Promise<{process_id:number;window_handle:number}>((done,reject)=>{let text='';const timer=setTimeout(()=>{child.kill();reject(Error('DESKTOP_FIXTURE_TIMEOUT'));},15000);child.stderr.on('data',()=>{});child.stdout.on('data',(part:Buffer)=>{text+=part.toString();if(text.includes('\n')){clearTimeout(timer);try{done(JSON.parse(text.trim()));}catch(e){reject(e);}}});child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('DESKTOP_FIXTURE_CLOSED'));});});
 const root=await mkdtemp(join(tmpdir(),'jev-windows-uia-')),store=new PrivateStore(join(root,'journal'));await store.initialize().catch(async error=>{child.kill();await store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});throw error;});
 const desktop=new WindowsDesktop(),attached=await desktop.attach(target.process_id,target.window_handle).catch(async error=>{child.kill();await desktop.close();throw error;});
 const network=new JevNetworkClient(store,{call:async(name,args)=>name==='jev.network_status'?{enabled:true,connector_online:true,local_ready:true}:{request_id:args.request_id,delivery_status:'COMPLETED',reply:{ok:true,result:offlineWindowsChoice(args.params,'selected')}},close:async()=>{}}),router=new ActionRouter(store,network);
 try{
  let observation=await desktop.observe(attached.target_id),controls=observation.state.controls as JsonObject[];const input=controls.find(c=>c.automation_id==='jevFixtureInput');assert.ok(input);
  let result=await router.act(desktop.executor(attached.target_id),{operation_id:randomUUID(),target:attached.target_id,snapshot_id:observation.snapshot_id,task:'Offline native UIA acceptance',actions:[{id:'selected',description:'Fill test input',action:{operation:'set_value',control_id:input.control_id,value:'Windows Jev'}}],expected:{control:{automation_id:'jevFixtureInput',value:'Windows Jev'}}});assert.equal(result.verified,true);
  observation=await desktop.observe(attached.target_id);controls=observation.state.controls as JsonObject[];const button=controls.find(c=>c.automation_id==='jevFixtureCommit');assert.ok(button);
  result=await router.act(desktop.executor(attached.target_id),{operation_id:randomUUID(),target:attached.target_id,snapshot_id:observation.snapshot_id,task:'Offline native UIA acceptance',actions:[{id:'selected',description:'Commit test input',action:{operation:'invoke',control_id:button.control_id}}],expected:{nameIncludes:'Committed Windows Jev'}});assert.equal(result.verified,true);
  const capture=await desktop.screenshot(attached.target_id,root);assert.ok(capture.bytes>0);
 }finally{await desktop.close();child.kill();await store.close();await rm(root,{recursive:true,force:true});}
});
test('Windows actual MCP stdio loads schemas, routes unsupported work and validates an authorized artifact',{timeout:45000},async t=>{
 await mkdir(resolve('.runtime'),{recursive:true});const root=await mkdtemp(join(resolve('.runtime'),'jev-windows-mcp-')),config=join(root,'config.json'),artifact=join(root,'result.txt');await writeFile(artifact,'Acceptance artifact');await writeFile(config,JSON.stringify({runtime:join(root,'runtime'),allowedFileRoots:[root]}));
 const client=new Client({name:'offline-windows-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/src/windows/main.js'),'--config',config,'--direct'],stderr:'pipe'});
 const started=Date.now(),stage=(name:string)=>t.diagnostic('Windows stdio '+name+': '+(Date.now()-started)+'ms');
 // Windows CI cold-starts the private-directory ACL helper and native worker.
 // Keep that setup within a finite test budget and report where time is spent.
 t.after(async()=>{try{await client.close();}finally{try{await transport.close();}finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});stage('closed');}}});
 await client.connect(transport);stage('connected');const tools=await client.listTools();assert.equal(tools.tools.length,28);assert.ok(tools.tools.some(t=>t.name==='jev_windows.request_recover'));stage('schemas');
 if(process.platform==='win32'){const native=await client.callTool({name:'jev_windows.native_status',arguments:{}});assert.equal(native.isError,undefined);const status=parseTool(native);assert.equal((status.native as JsonObject).platform,'windows');assert.equal((status.tools as unknown[]).length,14);stage('native metadata');}
 const route=await client.callTool({name:'jev_windows.route',arguments:{capability:'shell',environment:'windows'}});assert.ok(JSON.stringify(route).includes('NO_EXECUTOR_FOR_TARGET_ENVIRONMENT'));stage('route');const file=await client.callTool({name:'jev_windows.artifact_inspect',arguments:{path:artifact}});assert.ok(!file.isError);assert.ok(JSON.stringify(file).includes('Acceptance artifact')===false);assert.ok(JSON.stringify(file).includes('sha256'));stage('artifact');
});
