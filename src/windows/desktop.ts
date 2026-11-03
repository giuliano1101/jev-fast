import {WindowsUiaWorker} from './uia-worker.js';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {mkdir} from 'node:fs/promises';
import {Fault} from '../core/errors.js';
import {canonicalDigest} from '../remote/protocol.js';
import type {Executor,Observation} from './router.js';
import type {JsonObject} from './network-client.js';
import {inspectArtifact} from './artifacts.js';

const desktopAction=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('invoke'),control_id:z.string()}),z.object({operation:z.literal('set_value'),control_id:z.string(),value:z.string()}),
 z.object({operation:z.literal('toggle'),control_id:z.string()}),z.object({operation:z.literal('select'),control_id:z.string()})
]);
export function uiaCall(input:JsonObject,script=resolve('scripts/windows-uia.ps1')):Promise<JsonObject>{
 if(process.platform!=='win32')throw new Fault('WINDOWS_EXECUTOR_UNAVAILABLE');
 return new Promise((done,reject)=>{
  const child=spawn(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='';let bytes=0;const timer=setTimeout(()=>{child.kill();reject(new Fault('WINDOWS_UIA_TIMEOUT'));},30000);
  child.stdout.on('data',(part:Buffer)=>{bytes+=part.length;if(bytes>16*1024*1024){child.kill();reject(new Fault('WINDOWS_UIA_OUTPUT_TOO_LARGE'));}else output+=part.toString('utf8');});
  child.stderr.resume();child.once('error',()=>{clearTimeout(timer);reject(new Fault('WINDOWS_UIA_UNAVAILABLE'));});
  child.once('close',code=>{clearTimeout(timer);if(code!==0){reject(new Fault('WINDOWS_UIA_FAILURE'));return;}try{done(JSON.parse(output.replace(/^\uFEFF/,'')) as JsonObject);}catch{reject(new Fault('WINDOWS_UIA_INVALID_REPLY'));}});
  child.stdin.end(JSON.stringify(input));
 });
}
export class WindowsDesktop {
 private targets=new Map<string,JsonObject>();
 private approved=new Map<string,JsonObject>();
 private worker:WindowsUiaWorker;
 constructor(readonly script=resolve('scripts/windows-uia.ps1')){this.worker=new WindowsUiaWorker(script);}
 async close(){await this.worker.close();}
 async list(){return await this.worker.call({operation:'list'});}
 async attach(process_id:number,window_handle:number){
  const target={process_id,window_handle};const state=await this.worker.call({operation:'observe',target});
  const id=randomUUID();this.targets.set(id,{...target,process_started:state.process_started});return {target_id:id,snapshot_id:canonicalDigest(state),state};
 }
 private target(id:string){const t=this.targets.get(id);if(!t)throw new Fault('DESKTOP_TARGET_UNAVAILABLE');return t;}
 async observe(id:string):Promise<Observation>{const state=await this.worker.call({operation:'observe',target:this.target(id)});return {snapshot_id:canonicalDigest(state),state};}
 async screenshot(id:string,runtime:string){const folder=join(runtime,'screenshots');await mkdir(folder,{recursive:true,mode:0o700});const path=join(folder,randomUUID()+'.png');await this.worker.call({operation:'screenshot',target:this.target(id),capture_path:path});return await inspectArtifact(path,[runtime]);}
 executor(_id:string):Executor{return {
  name:'windows-desktop',resource:'windows-desktop-input',observe:target=>this.observe(target),
  validate:async(target,snapshot,input)=>{const action=desktopAction.parse(input),observation=await this.observe(target);if(observation.snapshot_id!==snapshot)throw new Fault('STALE_SNAPSHOT');const control=(observation.state.controls as JsonObject[]).find(c=>c.control_id===action.control_id);if(!control||!control.enabled||control.offscreen||control.password||!(control.operations as string[]).includes(action.operation))throw new Fault('CONTROL_UNAVAILABLE');this.approved.set(canonicalDigest({target,action}),control);},
  execute:async(target,input)=>{const action=desktopAction.parse(input),key=canonicalDigest({target,action}),expected_control=this.approved.get(key);this.approved.delete(key);if(!expected_control)throw new Fault('ACTION_NOT_PREFLIGHTED');return await this.worker.call({operation:'act',target:this.target(target),action,expected_control});},
  verify:async(target,expected)=>{const observation=await this.observe(target);const controls=observation.state.controls as JsonObject[];let met=false;
   if(typeof expected.nameIncludes==='string')met=controls.some(c=>String(c.name).includes(expected.nameIncludes as string));
   if(expected.control&&typeof expected.control==='object'){const wanted=expected.control as JsonObject;met=controls.some(c=>Object.entries(wanted).every(([k,v])=>c[k]===v));}
   return {met,state:observation};}
 };}
}
