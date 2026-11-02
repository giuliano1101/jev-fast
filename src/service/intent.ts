import {open,rename,unlink,lstat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {readPrivateJson} from './config.js';
import {privateRuntime} from './runtime.js';
import {Fault} from '../core/errors.js';
const selection=z.strictObject({configFile:z.string().refine(isAbsolute).nullable(),shared:z.boolean(),fingerprint:z.string().min(1).max(200)});
const schema=z.strictObject({version:z.literal(1),desired:z.enum(['running','stopped']),selection:selection.nullable()});
export type ServiceIntent=z.infer<typeof schema>;
export async function readServiceIntent(runtime:string):Promise<ServiceIntent|undefined>{
 const path=join(runtime,'service-intent.json');try{await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 try{return schema.parse(await readPrivateJson(path));}catch{throw new Fault('SERVICE_INTENT_INVALID');}
}
/** Must be called under lifecycleLock. Atomic rename + directory fsync persist operator off before IPC. */
export async function writeServiceIntent(runtime:string,intent:ServiceIntent):Promise<void>{
 const value=schema.parse(intent);await privateRuntime(runtime);const path=join(runtime,'service-intent.json'),temporary=join(runtime,`.service-intent-${randomUUID()}`);
 // Refuse to replace an unsafe pre-existing file.
 await readServiceIntent(runtime);
 const file=await open(temporary,'wx',0o600);
 try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
 try{await rename(temporary,path);const directory=await open(runtime,'r');try{await directory.sync();}finally{await directory.close();}}finally{await unlink(temporary).catch(()=>{});}
}
