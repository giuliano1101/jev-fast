import {spawn} from 'node:child_process';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadServiceProfile} from '../service/config.js';
import {inspectInstallation} from '../service/doctor.js';
import {buildMetadata} from '../service/build.js';
import {Fault} from '../core/errors.js';
import {readCredential,ipcCall} from '../service/ipc.js';
import {defaultRuntime,privateRuntime} from '../service/runtime.js';
import {readServiceIntent,writeServiceIntent} from '../service/intent.js';
import {lifecycleLock,recoverCoordinatorFiles} from '../service/recovery.js';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function serviceHealth(runtime:string){return ipcCall(await readCredential(join(runtime,'client-a.json')),'service.health',{});}
export interface StartServiceOptions {runtime?:string;shared?:boolean;configFile?:string;recover?:boolean}
export async function startService(options:StartServiceOptions={}):Promise<unknown>{
 if(options.recover&&(options.configFile!==undefined||options.shared!==undefined))throw new Fault('INVALID_ARGUMENTS');
 const runtime=resolve(options.runtime??defaultRuntime());let {shared,configFile}=options;const recover=options.recover??false;
 return lifecycleLock(runtime,async()=>{
 const intent=await readServiceIntent(runtime);
 if(recover&&intent?.desired!=='running')return {stopped:true,recovery_skipped:true};
 if(recover&&!intent?.selection)throw new Fault('SERVICE_INTENT_INVALID');
 configFile=configFile??intent?.selection?.configFile??undefined;shared=recover?intent!.selection!.shared:shared??false;
 const profile=await loadServiceProfile(configFile,shared);
 if(recover&&profile.fingerprint!==intent!.selection!.fingerprint)throw new Fault('SERVICE_PROFILE_MISMATCH');
 let existing:unknown;try{existing=await serviceHealth(runtime);}catch{/* The exclusive lock arbitrates unavailable coordinators. */}
 if(existing&&(existing as Record<string,unknown>).profileFingerprint!==profile.fingerprint)throw new Fault('SERVICE_PROFILE_MISMATCH');
 if(!recover)await writeServiceIntent(runtime,{version:1,desired:'running',selection:{configFile:configFile?resolve(configFile):null,shared,fingerprint:profile.fingerprint}});
 if(existing)return {...existing as object,already_running:true};
 await recoverCoordinatorFiles(runtime,profile.clients);
 await privateRuntime(runtime);
 const log=await open(join(runtime,'service.log'),constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{const info=await log.stat();if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==process.getuid?.())throw new Fault('UNSAFE_RUNTIME');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../service/main.js',import.meta.url)),'--runtime',runtime,...(shared?['--share-a-with-b']:[]),...(configFile?['--config',resolve(configFile)]:[])],{detached:true,stdio:['ignore',log.fd,log.fd]});
  let exited=false;child.once('exit',()=>{exited=true;});child.once('error',()=>{exited=true;});child.unref();
  for(let attempt=0;attempt<100;attempt++){try{const ready=await serviceHealth(runtime) as Record<string,unknown>;if(ready.profileFingerprint!==profile.fingerprint)throw new Fault('SERVICE_PROFILE_MISMATCH');return ready;}catch(error){if(error instanceof Fault&&error.code==='SERVICE_PROFILE_MISMATCH')throw error;if(exited)throw new Fault('SERVICE_START_FAILED');await delay(100);}}
  throw new Fault('SERVICE_START_TIMEOUT');
 }finally{await log.close();}
 });
}
export async function stopService(runtime:string):Promise<unknown>{
 return lifecycleLock(runtime,async()=>{
 const intent=await readServiceIntent(runtime);await writeServiceIntent(runtime,{version:1,desired:'stopped',selection:intent?.selection??null});
 const credential=await readCredential(join(runtime,'operator.json'));await ipcCall(credential,'service.stop',{});
 for(let attempt=0;attempt<100;attempt++){
  try{await lstat(join(runtime,'service.lock'));}catch{return {stopped:true};}
  await delay(50);
 }
 throw new Fault('SERVICE_STOP_TIMEOUT');
 });
}

export async function inspectService(runtime:string=defaultRuntime()):Promise<Record<string,unknown>> {
 const installation=await inspectInstallation(runtime);let current:Record<string,unknown>;
 try{current=await serviceHealth(runtime) as Record<string,unknown>;}catch{current={ready:false,diagnostic:'LOCAL_SERVICE_UNAVAILABLE',build:buildMetadata};}
 return {...current,installation};
}
