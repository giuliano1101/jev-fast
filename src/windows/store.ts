import {open,readFile,rename,rm,lstat,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Fault} from '../core/errors.js';
import {canonicalDigest} from '../remote/protocol.js';
import {preparePrivateDirectory} from '../service/private-directory.js';

/** One process owns this directory. Atomic, flushed records precede every dispatch. */
export class PrivateStore {
 readonly root:string;
 private unlock:(()=>Promise<void>)|undefined;
 constructor(root:string){this.root=resolve(root);}
 async initialize(){
  preparePrivateDirectory(this.root);
 }
 async lease(name:string){
  const path=this.path('lock-'+canonicalDigest(name));
  for(let attempt=0;attempt<2;attempt++){
   try{
    const file=await open(path,'wx',0o600);await file.writeFile(JSON.stringify({pid:process.pid}));await file.sync();
    return async()=>{await file.close();await rm(path,{force:true});};
   }catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const existing=await this.read<{pid:number}>('lock-'+canonicalDigest(name));
    if(!existing||!Number.isSafeInteger(existing.pid)||existing.pid<=0)throw new Fault('RUNTIME_LOCK_UNCERTAIN');
    try{process.kill(existing.pid,0);throw new Fault('RESOURCE_BUSY');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
    await rm(path,{force:true}); // Dead process only; unfinished action records remain quarantined.
   }
  }
  throw new Fault('RESOURCE_BUSY');
 }
 async own(){if(this.unlock)throw new Fault('RESOURCE_BUSY');this.unlock=await this.lease('process');}
 async close(){await this.unlock?.();this.unlock=undefined;}
 async keys(prefix:string){return (await readdir(this.root)).filter(name=>name.startsWith(prefix)&&name.endsWith('.json')).map(name=>name.slice(0,-5));}
 async remove(key:string){await rm(this.path(key),{force:true});}
 path(key:string){if(!/^[a-zA-Z0-9_.:-]+$/.test(key))throw new Fault('INVALID_STORE_KEY');return join(this.root,key.replaceAll(':','_')+'.json');}
 async read<T>(key:string):Promise<T|undefined>{
  try{const path=this.path(key);if((await lstat(path)).isSymbolicLink())throw new Fault('UNSAFE_PRIVATE_FILE');return JSON.parse(await readFile(path,'utf8')) as T;}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 }
 async write(key:string,value:unknown){
  const target=this.path(key),temp=target+'.'+randomUUID()+'.tmp';
  const file=await open(temp,'wx',0o600);
  try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
  await rename(temp,target);
 }
}
