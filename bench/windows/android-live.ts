/** Opt-in real configured-phone workflows; no cloud device allocation or volume changes. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WindowsEngine} from '../../src/windows/engine.js';
import {loadWindowsConfig} from '../../src/windows/config.js';
import type {JsonObject} from '../../src/windows/network-client.js';
import type {HostStep} from '../../src/windows/host-workflow.js';
import {Fault} from '../../src/core/errors.js';

export async function runAndroidLive(configPath:string,reportPath:string,expectedModel:string){
 const config=await loadWindowsConfig(configPath);let engine=new WindowsEngine(config),uncertain=false;
 const cases:JsonObject[]=[],started=new Date().toISOString(),knownRequests=new Map<string,JsonObject>();
 const record=async(id:string,operation:()=>Promise<JsonObject|void>)=>{const at=Date.now();try{const result=await operation()??{},decision=result.decision as JsonObject|undefined;if(typeof result.request_id==='string'&&decision?.provider==='jev')knownRequests.set(result.request_id,decision);cases.push({id,status:'passed',elapsed_ms:Date.now()-at,request_id:result.request_id,provider:decision?.provider,model:decision?.model});console.log(JSON.stringify({test:id,status:'passed'}));return result;}catch(error){const code=error instanceof Fault?error.code:'ACCEPTANCE_ASSERTION_FAILED';uncertain=/UNKNOWN|CONTINUATION/.test(code);cases.push({id,status:'failed',code,uncertain});throw error;}};
 const step=(workflow_id:string,step_id:string,tool:string,args:JsonObject,task:string):HostStep=>({workflow_id,step_id,host:'android',task,state:{authorized_test:true,volume_change_allowed:false},actions:[{id:'selected',tool,arguments:args,description:task}]});
 await engine.initialize();
 try{
  await record('real-host-directory',async()=>{await engine.network.ready();const directory=await engine.hostTools('android'),tools=directory.tools as Array<{name:string;inputSchema:JsonObject}>;for(const name of ['mobile_list_available_devices','mobile_get_foreground_app','mobile_press_button','mobile_get_screen_size','mobile_get_orientation','mobile_batch_commands'])assert.ok(tools.some(t=>t.name===name),name);const press=tools.find(t=>t.name==='mobile_press_button')!;assert.ok((press.inputSchema.required as string[]).includes('button'));});
  const first=randomUUID();
  await record('workflow-1-device-match',async()=>{const result=await engine.hostStep(step(first,'devices','mobile_list_available_devices',{},'Read the already connected local phone directory; never allocate a cloud device.'));const payload=result.payload as JsonObject[];const devices=payload.flatMap(p=>Array.isArray(p.devices)?p.devices:[]) as JsonObject[];assert.equal(devices.length,1);assert.equal(devices[0]?.platform,'android');assert.equal(devices[0]?.state,'online');assert.equal(devices[0]?.model,expectedModel);return result;});
  await record('workflow-1-foreground-read',async()=>{const result=await engine.hostStep(step(first,'foreground','mobile_get_foreground_app',{},'Read the actual foreground application without changing the phone.'));assert.ok(JSON.stringify(result.payload).length>4);return result;});
  const second=randomUUID(),home=step(second,'home','mobile_press_button',{button:'HOME'},'Press HOME exactly once on the verified configured phone. Do not change media volume.');
  const original=await record('workflow-2-home-once',async()=>await engine.hostStep(home));
  await record('workflow-2-confirmed-step-reopen-no-replay',async()=>{const before=(await engine.store.keys('request-')).length;await engine.close();engine=new WindowsEngine(config);await engine.initialize();const cached=await engine.hostStep(home);assert.equal(cached.request_id,original.request_id);assert.equal((await engine.store.keys('request-')).length,before);assert.equal((await engine.host.progress(second)).steps.find(s=>s.step_id==='home')?.phase,'executed');return cached;});
  await record('workflow-2-home-posterior',async()=>{const result=await engine.hostStep(step(second,'read-after','mobile_get_foreground_app',{},'Read the actual foreground app after HOME; do not send another HOME.'));assert.match(JSON.stringify(result.payload),/launcher|com\.miui\.home|com\.huawei\.android\.launcher|com\.oppo\.launcher|com\.coloros\.launcher/i);return result;});
  const third=randomUUID();
  await record('workflow-3-stable-read-batch',async()=>{const result=await engine.hostStep(step(third,'metadata-batch','mobile_batch_commands',{steps:[{name:'mobile_get_screen_size',arguments:{}},{name:'mobile_get_orientation',arguments:{}}],listElementsAtEnd:true,stopOnError:true},'Read screen size and orientation in one batch on the unchanged home screen; list elements at the end. No input, app launch or volume change.'));const payload=JSON.stringify(result.payload);assert.match(payload,/portrait|landscape/i);assert.match(payload,/width|height|resolution|screen.?size/i);return result;});
 }catch(error){process.exitCode=1;console.log(JSON.stringify({error:error instanceof Fault?error.code:'ACCEPTANCE_ASSERTION_FAILED',uncertain}));}
 finally{
  if(!uncertain){try{await engine.release();cases.push({id:'owned-connection-release',status:'passed'});}catch{process.exitCode=1;cases.push({id:'owned-connection-release',status:'failed',code:'CLEANUP_UNCONFIRMED'});}}
  await engine.close();await mkdir(dirname(resolve(reportPath)),{recursive:true});await writeFile(reportPath,JSON.stringify({executor:'real-jev-windows-android-workflows',started,finished:new Date().toISOString(),uncertain,passed:cases.filter(c=>c.status==='passed').length,failed:cases.filter(c=>c.status==='failed').length,unique_decision_requests:knownRequests.size,usage:[...knownRequests].map(([request_id,d])=>({request_id,provider:d.provider,model:d.model,usage:d.usage})),cases,limits:['No cloud devices allocated.','No media-volume changes attempted; the configured host exposes no media-volume read tool, so actual percentage is not claimed.','No public interaction or production account action performed.','Three short workflows are not acceptance for every mobile app.']},null,2)+'\n');
 }
}
async function main(){const args=process.argv.slice(2);if(args.length!==6||args[0]!=='--config'||args[2]!=='--report'||args[4]!=='--expected-model')throw new Fault('INVALID_ARGUMENTS');await runAndroidLive(args[1]!,args[3]!,args[5]!);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{console.error('ANDROID_LIVE_ACCEPTANCE_FAILED');process.exitCode=1;});
