import {mkdir,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Fault} from '../core/errors.js';
export const defaultRuntime=()=>`/tmp/jev-${process.getuid?.()??'local'}`;
export async function privateRuntime(path:string):Promise<string>{
 const absolute=resolve(path);await mkdir(absolute,{recursive:true,mode:0o700});const info=await lstat(absolute);
 if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o700)throw new Fault('UNSAFE_RUNTIME');return absolute;
}
