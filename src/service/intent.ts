import {open,rename,unlink,lstat,mkdir,realpath} from 'node:fs/promises';
import {join,isAbsolute,dirname,basename,resolve,parse,sep} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {readPrivateJson} from './config.js';
import {privateRuntime} from './runtime.js';
import {lifecycleLock} from './recovery.js';
import {Fault} from '../core/errors.js';
const absolute=z.string().refine(isAbsolute).refine(value=>resolve(value)===value);
const selection=z.strictObject({configFile:z.string().refine(isAbsolute).nullable(),shared:z.boolean(),fingerprint:z.string().min(1).max(200)});
const schema=z.strictObject({version:z.literal(1),desired:z.enum(['running','stopped']),selection:selection.nullable()});
const bindingsSchema=z.strictObject({version:z.literal(1),bindings:z.array(z.strictObject({runtime:absolute,intentFile:absolute})).max(1000)}).refine(value=>new Set(value.bindings.map(binding=>binding.runtime)).size===value.bindings.length&&new Set(value.bindings.map(binding=>binding.intentFile)).size===value.bindings.length);
type Bindings=z.infer<typeof bindingsSchema>;
export type ServiceIntent=z.infer<typeof schema>;
/** Explicit operator override also permits tests to use an isolated registry. */
export function serviceIntentBindingsPath():string{
 const override=process.env.JEV_SERVICE_INTENT_BINDINGS;if(override!==undefined){if(!isAbsolute(override)||resolve(override)!==override)throw new Fault('SERVICE_INTENT_BINDING_INVALID');return override;}
 const root=process.platform==='darwin'?join(homedir(),'Library','Application Support','Jev'):process.platform==='win32'?join(homedir(),'AppData','Local','Jev'):join(homedir(),'.local','state','jev');
 return join(root,'service-intent-bindings.json');
}
/** Runtime aliases identify the same owner, including after reboot removes the final directories. */
async function runtimeIdentity(runtime:string):Promise<string>{
 let current=resolve(runtime);const missing:string[]=[];
 for(;;){
  try{return join(await realpath(current),...missing.slice().reverse());}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const parent=dirname(current);if(parent===current)throw new Fault('SERVICE_INTENT_BINDING_INVALID');missing.push(basename(current));current=parent;
 }
}
/** Persistent operator paths may not traverse symlinks; only the final directory must be owner-only. */
async function persistentParent(directory:string,create=false):Promise<boolean>{
 const root=parse(directory).root;let current=root;const parts=directory.slice(root.length).split(sep).filter(Boolean);
 for(const part of parts){
  current=join(current,part);let info;
  try{info=await lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(!create)return false;try{await mkdir(current,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}info=await lstat(current);}
  if(info.isSymbolicLink()||!info.isDirectory())throw new Fault('SERVICE_INTENT_BINDING_INVALID');
  if(current===directory&&(info.uid!==process.getuid?.()||(info.mode&0o777)!==0o700))throw new Fault('SERVICE_INTENT_BINDING_INVALID');
 }
 if(!parts.length)throw new Fault('SERVICE_INTENT_BINDING_INVALID');return true;
}
async function readBindings(path:string):Promise<Bindings|undefined>{
 try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 if(!await persistentParent(dirname(path)))return;
 try{
  const registry=bindingsSchema.parse(await readPrivateJson(path));
  const bindings=await Promise.all(registry.bindings.map(async binding=>({...binding,runtime:await runtimeIdentity(binding.runtime)})));
  return bindingsSchema.parse({...registry,bindings});
 }catch{throw new Fault('SERVICE_INTENT_BINDING_INVALID');}
}
async function intentPath(runtime:string):Promise<{path:string;persistent:boolean}>{
 const identity=await runtimeIdentity(runtime);
 const binding=(await readBindings(serviceIntentBindingsPath()))?.bindings.find(binding=>binding.runtime===identity);
 return binding?{path:binding.intentFile,persistent:true}:{path:join(runtime,'service-intent.json'),persistent:false};
}
async function readIntentFile(path:string,persistent:boolean):Promise<ServiceIntent|undefined>{
 if(persistent&&!await persistentParent(dirname(path)))return;
 try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 try{return schema.parse(await readPrivateJson(path));}catch{throw new Fault('SERVICE_INTENT_INVALID');}
}
export async function readServiceIntent(runtime:string):Promise<ServiceIntent|undefined>{
 const {path,persistent}=await intentPath(runtime);return readIntentFile(path,persistent);
}
async function atomicWrite(path:string,value:unknown):Promise<void>{
 const directory=dirname(path),temporary=join(directory,`.${basename(path)}-${randomUUID()}`);const file=await open(temporary,'wx',0o600);
 try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
 try{await rename(temporary,path);const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}}finally{await unlink(temporary).catch(()=>{});}
}
/** Must be called under lifecycleLock. The bound file is the sole authority, never a mirrored runtime copy. */
export async function writeServiceIntent(runtime:string,intent:ServiceIntent):Promise<void>{
 const value=schema.parse(intent),{path,persistent}=await intentPath(runtime);
 if(persistent)await persistentParent(dirname(path),true);else await privateRuntime(runtime);
 await readIntentFile(path,persistent);await atomicWrite(path,value);
}
/** Operator-only provisioning: serialize migration with start/stop and all other registry updates. */
export async function bindServiceIntent(runtime:string,intentFile:string):Promise<void>{
 if(!isAbsolute(runtime)||resolve(runtime)!==runtime||!isAbsolute(intentFile)||resolve(intentFile)!==intentFile||intentFile.startsWith(runtime+sep)||intentFile===runtime)throw new Fault('SERVICE_INTENT_BINDING_INVALID');
 runtime=await runtimeIdentity(runtime);
 const registryFile=serviceIntentBindingsPath();if(intentFile.startsWith(runtime+sep)||intentFile===runtime||intentFile===registryFile||registryFile.startsWith(runtime+sep)||registryFile===runtime)throw new Fault('SERVICE_INTENT_BINDING_INVALID');
 await persistentParent(dirname(registryFile),true);await persistentParent(dirname(intentFile),true);
 await lifecycleLock(runtime,()=>lifecycleLock(dirname(registryFile),async()=>{
  const registry=await readBindings(registryFile)??{version:1 as const,bindings:[]};const existing=registry.bindings.find(binding=>binding.runtime===runtime);
  if(existing){if(existing.intentFile!==intentFile)throw new Fault('SERVICE_INTENT_ALREADY_BOUND');await readIntentFile(intentFile,true);return;}
  if(registry.bindings.some(binding=>binding.intentFile===intentFile))throw new Fault('SERVICE_INTENT_ALREADY_BOUND');
  const current=await readIntentFile(join(runtime,'service-intent.json'),false);if(!current)throw new Fault('SERVICE_INTENT_MISSING');
  // Never overwrite another existing authority as an implicit migration.
  if(await readIntentFile(intentFile,true))throw new Fault('SERVICE_INTENT_TARGET_EXISTS');
  await atomicWrite(intentFile,current);registry.bindings.push({runtime,intentFile});await atomicWrite(registryFile,bindingsSchema.parse(registry));
 }));
}
