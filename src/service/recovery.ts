import {constants} from 'node:fs';
import {lstat,open,unlink,type FileHandle} from 'node:fs/promises';
import {basename,join} from 'node:path';
import type {Stats} from 'node:fs';
import {Fault} from '../core/errors.js';
import {privateRuntime} from './runtime.js';
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino;
export function provenDead(pid:number):boolean {
 if(!Number.isSafeInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
}
async function snapshot(directory:string,name:string,kind:'file'|'socket'='file'):Promise<Stats|undefined>{
 if(basename(name)!==name||name==='.'||name==='..')throw new Fault('UNSAFE_RECOVERY_PATH');
 try{const info=await lstat(join(directory,name));if(info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||(kind==='socket'?!info.isSocket():!info.isFile()||info.nlink!==1))throw new Fault('UNSAFE_RECOVERY_PATH');return info;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}
async function checkedUnlink(directory:string,name:string,before:Stats,parent:Stats,pid:number){
 if(!provenDead(pid)||!same(parent,await lstat(directory))||!same(before,await lstat(join(directory,name))))throw new Fault('RECOVERY_IDENTITY_CHANGED');
 await unlink(join(directory,name));
}
async function readMarker(directory:string,name:string){
 const before=await snapshot(directory,name);if(!before)return;
 const file=await open(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{if(!same(before,await file.stat())||before.size>4096)throw new Fault('UNSAFE_RECOVERY_PATH');let value:{pid?:unknown};try{value=JSON.parse(await file.readFile('utf8')) as {pid?:unknown};}catch{throw new Fault('RECOVERY_OWNER_UNKNOWN');}if(typeof value.pid!=='number'||!Number.isSafeInteger(value.pid)||value.pid<=0)throw new Fault('RECOVERY_OWNER_UNKNOWN');return {before,pid:value.pid};}finally{await file.close();}
}
/** Only explicit lock/marker files are eligible; never use this for database or ledger data. */
export async function removeDeadMarker(directory:string,name:string):Promise<boolean>{
 await privateRuntime(directory);if(!/^(?:owner\.lock|service\.lock|network-connector\.lock|service-lifecycle\.lock|watchdog-cycle\.lock|watchdog-[a-z]+\.json)$/.test(name))throw new Fault('UNSAFE_RECOVERY_PATH');
 const parent=await lstat(directory),marker=await readMarker(directory,name);if(!marker)return false;
 if(!provenDead(marker.pid))throw new Fault('RECOVERY_OWNER_ALIVE');
 await checkedUnlink(directory,name,marker.before,parent,marker.pid);return true;
}
/** Caller holds the lifecycle lock. Only the dead coordinator's ephemeral files are removed. */
export async function recoverCoordinatorFiles(directory:string,clients:readonly string[]):Promise<void>{
 await privateRuntime(directory);const parent=await lstat(directory),marker=await readMarker(directory,'service.lock');if(!marker)return;
 if(!provenDead(marker.pid))throw new Fault('RECOVERY_OWNER_ALIVE');
 const files:{name:string;info:Stats}[]=[];
 for(const name of [...clients.map(client=>`client-${client}.json`),'operator.json']){
  const info=await snapshot(directory,name);if(!info)continue;
  const file=await open(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{if(!same(info,await file.stat())||info.size>4096)throw new Fault('UNSAFE_RECOVERY_PATH');const value=JSON.parse(await file.readFile('utf8')) as {version?:unknown;socket?:unknown;token?:unknown};if(value.version!==1||value.socket!==join(directory,'coordinator.sock')||typeof value.token!=='string'||!/^[a-f0-9]{64}$/.test(value.token))throw new Fault('UNSAFE_RECOVERY_PATH');}finally{await file.close();}
  files.push({name,info});
 }
 const socket=await snapshot(directory,'coordinator.sock','socket');if(socket)files.push({name:'coordinator.sock',info:socket});
 // Validate every artifact before modifying any, then release the owner marker last.
 for(const {name,info} of files)await checkedUnlink(directory,name,info,parent,marker.pid);
 await checkedUnlink(directory,'service.lock',marker.before,parent,marker.pid);
}
/** Serializes start/stop/recovery; lock reclamation never treats EPERM as death. */
export async function lifecycleLock<T>(directory:string,operation:()=>Promise<T>):Promise<T>{return markerLock(directory,'service-lifecycle.lock',operation);}
export async function markerLock<T>(directory:string,name:'service-lifecycle.lock'|'watchdog-cycle.lock',operation:()=>Promise<T>):Promise<T>{
 await privateRuntime(directory);const path=join(directory,name);let file:FileHandle|undefined;
 for(let attempt=0;attempt<200;attempt++){
  try{file=await open(path,'wx',0o600);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;try{await removeDeadMarker(directory,name);}catch(error){if(!(error instanceof Fault&&['RECOVERY_OWNER_ALIVE','RECOVERY_OWNER_UNKNOWN'].includes(error.code))&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,50));}
 }
 if(!file)throw new Fault('SERVICE_LIFECYCLE_BUSY');
 const before=await file.stat();try{await file.writeFile(JSON.stringify({pid:process.pid})+'\n');await file.sync();return await operation();}
 finally{await file.close();const current=await lstat(path);if(!same(before,current))throw new Fault('RECOVERY_IDENTITY_CHANGED');await unlink(path);}
}
