import {mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ChallengeServer,challengeUrl,type ChallengeSpec} from './challenge.js';

/** Local-only UI control lane; no API/key loading exists in this process. */
async function serve(){
 const output=resolve('artifacts/live/computer-use');await mkdir(output,{recursive:true,mode:0o700});
 const server=await ChallengeServer.start();
 const specs:ChallengeSpec[]=[];
 for(const difficulty of ['easy','medium','hard'] as const)for(const seed of [1,2,3])for(const family of ['locate','form'] as const)
  specs.push({family,difficulty,seed,mode:'cua',run:`cua-${family}-${difficulty}-${seed}`});
 const tasks=specs.map(spec=>({...spec,url:challengeUrl(server.origin,spec)}));
 const manifest={status:'running',started_at:new Date().toISOString(),origin:server.origin,tasks,
  mode:'Current Codex conversation computer use via DOM/AX; no Jev; incremental API cost unavailable',
  timeout_per_task_ms:120000,primary_timing:'page initialization to terminal; includes initial delay, model/tool latency and recovery',
  warning:'This lane must be driven from visible browser state; do not use the source/hidden oracle to select actions.'};
 await writeFile(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});
 let writing:Promise<void>=Promise.resolve();
 const save=()=>{writing=writing.then(async()=>{await writeFile(resolve(output,'scores.tmp'),JSON.stringify(server.results(),null,2),{mode:0o600});await rename(resolve(output,'scores.tmp'),resolve(output,'scores.json'));});return writing;};
 const timer=setInterval(()=>{void save().catch(()=>{});},300);
 let closing=false;
 const close=async()=>{if(closing)return;closing=true;clearInterval(timer);await save();await server.close();await writeFile(resolve(output,'manifest.json'),JSON.stringify({...manifest,status:'stopped',stopped_at:new Date().toISOString()},null,2),{mode:0o600});};
 process.on('SIGINT',()=>{void close().then(()=>process.exit(0));});process.on('SIGTERM',()=>{void close().then(()=>process.exit(0));});
 console.log(JSON.stringify({origin:server.origin,tasks:tasks.length,manifest:resolve(output,'manifest.json')}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)serve().catch(()=>{console.error('LOCAL_CHALLENGE_SERVER_FAILED');process.exitCode=1;});
