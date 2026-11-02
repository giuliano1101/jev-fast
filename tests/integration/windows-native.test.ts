import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NativeCommon,NativeAdapter} from '../../src/windows/native.js';
import {PrivateStore} from '../../src/windows/store.js';
import {JevNetworkClient,type JsonObject} from '../../src/windows/network-client.js';
import {ActionRouter} from '../../src/windows/router.js';
import {offlineWindowsChoice} from '../fixtures/windows-choice.js';

test('upstream native Windows driver performs actual Unicode keyboard input and guarded button invocation',{skip:process.platform!=='win32'||process.env.CI==='true',timeout:60000},async()=>{
 const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-STA','-File',resolve('tests/fixtures/windows-desktop.ps1')],{windowsHide:true,stdio:['ignore','pipe','ignore']});
 const root=await mkdtemp(join(tmpdir(),'jev-windows-native-')),store=new PrivateStore(join(root,'journal')),common=new NativeCommon();
 try{
  const pid=await new Promise<number>((done,reject)=>{let value='';const timer=setTimeout(()=>reject(Error('NATIVE_FIXTURE_TIMEOUT')),10000);child.stdout.on('data',(part:Buffer)=>{value+=part.toString();if(value.includes('\n')){clearTimeout(timer);try{done((JSON.parse(value) as {process_id:number}).process_id);}catch(e){reject(e);}}});child.once('error',reject);});
  await store.initialize();const adapter=new NativeAdapter(common,store,root,[root]);await assert.rejects(adapter.prepare(2147483647),/NATIVE_OBSERVATION_UNAVAILABLE/);const prepared=await adapter.prepare(pid);
  const other=new NativeAdapter(common,store,root,[root]);await other.prepare(pid);
  const oldInput=(prepared.state.elements as JsonObject[]).find(e=>e.role==='ControlType.Edit'&&e.settable);assert.ok(oldInput);
  await assert.rejects(adapter.executor(prepared.target_id).validate(prepared.target_id,prepared.snapshot_id,{tool:'desktop_set_value',arguments:{app:pid,observation_id:prepared.snapshot_id,element_id:oldInput.element_id,value:'must not execute'}}),/STALE_SNAPSHOT/);
  await assert.rejects(other.executor(prepared.target_id).observe(prepared.target_id),/NATIVE_TARGET_NOT_OWNED/);
  const network=new JevNetworkClient(store,{call:async(name,args)=>name==='jev.network_status'?{enabled:true,connector_online:true,local_ready:true}:{request_id:args.request_id,delivery_status:'COMPLETED',reply:{ok:true,result:offlineWindowsChoice(args.params)}},close:async()=>{}}),router=new ActionRouter(store,network);
  let observed=await adapter.fresh(prepared.target_id);const input=(observed.state.elements as JsonObject[]).find(e=>e.role==='ControlType.Edit'&&e.settable);assert.ok(input);
  let result=await router.act(adapter.executor(prepared.target_id),{operation_id:randomUUID(),target:prepared.target_id,snapshot_id:observed.snapshot_id,task:'Type the synthetic text 原生 Jev into the observed test input.',actions:[{id:'type',description:'Enter 原生 Jev in the test text box',action:{tool:'desktop_type_text',arguments:{app:pid,observation_id:observed.snapshot_id,element_id:input.element_id,text:'原生 Jev'}}}],expected:{element:{role:'ControlType.Edit',value:'原生 Jev'}}});assert.equal(result.verified,true);
  observed=await adapter.fresh(prepared.target_id);const button=(observed.state.elements as JsonObject[]).find(e=>e.label==='Commit test'&&(e.actions as string[]).includes('invoke'));assert.ok(button);
  result=await router.act(adapter.executor(prepared.target_id),{operation_id:randomUUID(),target:prepared.target_id,snapshot_id:observed.snapshot_id,task:'Invoke the observed test button.',actions:[{id:'invoke',description:'Invoke Commit test',action:{tool:'desktop_perform_action',arguments:{app:pid,observation_id:observed.snapshot_id,element_id:button.element_id,action:'invoke'}}}],expected:{textIncludes:'Committed 原生 Jev'}});assert.equal(result.verified,true);
  const picture=await adapter.fresh(prepared.target_id,true),image=picture.state.image as JsonObject;assert.equal(typeof image.path,'string');assert.ok((await readFile(String(image.path))).length>100);
 }finally{await common.close();child.kill();await store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
