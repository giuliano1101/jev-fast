import {access,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {chromiumExecutable} from '../browser/executable.js';
/** Inspection only: no browser launch, file creation, enrollment or repair. */
export async function inspectInstallation(runtime:string){
 const [major=0,minor=0]=process.versions.node.split('.').map(Number);
 const inspect=async(path:string,kind:'directory'|'socket',mode:number)=>{try{const info=await lstat(path);return {status:!info.isSymbolicLink()&&(kind==='directory'?info.isDirectory():info.isSocket())&&info.uid===process.getuid?.()&&(info.mode&0o777)===mode?'private':'unsafe'};}catch(error){return {status:(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unreadable'};}};
 let executableAvailable=false;try{await access(chromiumExecutable(),constants.X_OK);executableAvailable=true;}catch{/* Report missing executable; do not install or launch. */}
 return {node:{version:process.versions.node,supported:major>24||major===24&&minor>=19},chromium:{executableAvailable,launchVerified:false},runtime:await inspect(runtime,'directory',0o700),socket:await inspect(join(runtime,'coordinator.sock'),'socket',0o600)};
}
