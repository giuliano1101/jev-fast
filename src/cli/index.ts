import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {loadServiceProfile} from '../service/config.js';
import {inspectInstallation} from '../service/doctor.js';
import {buildMetadata} from '../service/build.js';
import {Fault} from '../core/errors.js';
import {parseTool,toolDefinitions} from '../service/contracts.js';
import {readCredential,ipcCall,safeCode,type Credential} from '../service/ipc.js';
import {defaultRuntime,privateRuntime} from '../service/runtime.js';
const help=`Jev local coordinator CLI\n\nCommands:\n  service start | health | stop [--runtime DIR]\n  service start [--config FILE]\n  doctor | policy status [--runtime DIR]\n  schemas [--json]\n  demo [--runtime DIR] [--credential FILE] [--json]\n  open_session | observe | run_goal | cancel | status | close_session\n    --args '{"session_id":"..."}' [--credential FILE] [--json]\n\nAll tools share the coordinator safety gate. Real profiles additionally expose browser_* for arbitrary HTTP/HTTPS websites, choose_action for host actions, and host_* for operator-configured MCP devices. Independent browser sessions may run concurrently; goal budgets are caller options. The private service configuration selects offline mock (default) or authenticated remote decisions. Each remote profile binds local client a to one configured agent.\nservice start --share-a-with-b enables an explicit a-to-b session ACL for local contention testing.\n`;
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function summary(value:unknown):string{
 if(typeof value!=='object'||value===null)return JSON.stringify(value);const row=value as Record<string,unknown>;
 if(row.status)return `${row.status}${row.reason?`: ${row.reason}`:''}${typeof row.steps==='number'?` (${row.steps} steps)`:''}`;
 if(row.stopped)return 'Service stopped.';if(row.ready)return `Service ready (${String(row.provider)})${row.already_running?' — already running':''}.`;
 if(row.closed)return 'Session closed.';if(row.session_id)return `Session ${row.session_id}${row.busy===true?' busy':''}.`;
 if(row.snapshot_id)return `Observation ${row.snapshot_id}: ${row.summary}`;
 return JSON.stringify(value);
}
async function health(runtime:string){return ipcCall(await readCredential(join(runtime,'client-a.json')),'service.health',{});}
async function start(runtime:string,shared:boolean,configFile?:string):Promise<unknown>{
 const profile=await loadServiceProfile(configFile,shared);
 let existing:unknown;try{existing=await health(runtime);}catch{/* The exclusive lock arbitrates unavailable coordinators. */}
 if(existing){if((existing as Record<string,unknown>).profileFingerprint!==profile.fingerprint)throw new Fault('SERVICE_PROFILE_MISMATCH');return {...existing as object,already_running:true};}
 await privateRuntime(runtime);
 const log=await open(join(runtime,'service.log'),constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{const info=await log.stat();if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==process.getuid?.())throw new Fault('UNSAFE_RUNTIME');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../service/main.js',import.meta.url)),'--runtime',runtime,...(shared?['--share-a-with-b']:[]),...(configFile?['--config',resolve(configFile)]:[])],{detached:true,stdio:['ignore',log.fd,log.fd]});
  let exited=false;child.once('exit',()=>{exited=true;});child.once('error',()=>{exited=true;});child.unref();
  for(let attempt=0;attempt<100;attempt++){try{const ready=await health(runtime) as Record<string,unknown>;if(ready.profileFingerprint!==profile.fingerprint)throw new Fault('SERVICE_PROFILE_MISMATCH');return ready;}catch(error){if(error instanceof Fault&&error.code==='SERVICE_PROFILE_MISMATCH')throw error;if(exited)throw new Fault('SERVICE_START_FAILED');await delay(100);}}
  throw new Fault('SERVICE_START_TIMEOUT');
 }finally{await log.close();}
}
async function stop(runtime:string):Promise<unknown>{
 const credential=await readCredential(join(runtime,'operator.json'));await ipcCall(credential,'service.stop',{});
 for(let attempt=0;attempt<100;attempt++){
  try{await lstat(join(runtime,'service.lock'));}catch{return {stopped:true};}
  await delay(50);
 }
 throw new Fault('SERVICE_STOP_TIMEOUT');
}
async function demo(credential:Credential):Promise<unknown>{
 const opened=await ipcCall(credential,'jev.open_session',parseTool('jev.open_session',{fixture_id:'standard'})) as {session_id:string};
 try{return await ipcCall(credential,'jev.run_goal',parseTool('jev.run_goal',{session_id:opened.session_id,goal_id:randomUUID(),idempotency_key:randomUUID(),goal:{task:'form',language:'en',seed:1},success:{kind:'task_complete'}}));}
 finally{await ipcCall(credential,'jev.close_session',parseTool('jev.close_session',{session_id:opened.session_id}));}
}
async function main(){
 let args;try{args=parseArgs({options:{help:{type:'boolean',short:'h'},json:{type:'boolean'},runtime:{type:'string'},config:{type:'string'},credential:{type:'string'},args:{type:'string'},'share-a-with-b':{type:'boolean'}},strict:true,allowPositionals:true});}catch{throw new Fault('INVALID_ARGUMENTS');}
 const {values,positionals}=args;if(values.help){if(positionals.length||Object.keys(values).some(key=>key!=='help'))throw new Fault('INVALID_ARGUMENTS');process.stdout.write(help);return;}
 const command=positionals.join(' ');
 const allowed=command==='schemas'?['json']:command==='service start'?['json','runtime','config','share-a-with-b']:['service health','service stop','doctor','policy status'].includes(command)?['json','runtime']:command==='demo'?['json','runtime','credential']:['json','runtime','credential','args'];
 if(Object.keys(values).some(key=>!allowed.includes(key)))throw new Fault('INVALID_ARGUMENTS');
 if((values.config!==undefined||values['share-a-with-b']!==undefined)&&!(positionals[0]==='service'&&positionals[1]==='start'&&positionals.length===2))throw new Fault('INVALID_ARGUMENTS');
 const runtime=resolve(values.runtime??defaultRuntime());let result:unknown;
 if(positionals.length===1&&positionals[0]==='schemas')result=toolDefinitions;
 else if(positionals.length===1&&positionals[0]==='doctor'){
  const installation=await inspectInstallation(runtime);let current:Record<string,unknown>;
  try{current=await health(runtime) as Record<string,unknown>;}catch{current={ready:false,diagnostic:'LOCAL_SERVICE_UNAVAILABLE',build:buildMetadata};}
  result={...current,installation};
 }
 else if(positionals.length===2&&positionals[0]==='policy'&&positionals[1]==='status')result=await health(runtime);
 else if(positionals[0]==='service'&&positionals.length===2){
  switch(positionals[1]){case 'start':result=await start(runtime,values['share-a-with-b']??false,values.config);break;case 'health':result=await health(runtime);break;case 'stop':result=await stop(runtime);break;default:throw new Fault('UNKNOWN_METHOD');}
 }else if(positionals.length===1&&positionals[0]==='demo')result=await demo(await readCredential(values.credential??join(runtime,'client-a.json')));
 else if(positionals.length===1){
  let input:unknown;try{input=JSON.parse(values.args??'{}');}catch{throw new Fault('INVALID_ARGUMENTS');}
  const method=positionals[0]!.startsWith('jev.')?positionals[0]!: 'jev.'+positionals[0];
  const request=parseTool(method,input);result=await ipcCall(await readCredential(values.credential??join(runtime,'client-a.json')),method,request);
 }else throw new Fault('INVALID_ARGUMENTS');
 process.stdout.write((values.json||command==='doctor'||command==='policy status'?JSON.stringify(result):summary(result))+'\n');
}
void main().catch(error=>{const code=safeCode(error);if(process.argv.includes('--json'))process.stdout.write(JSON.stringify({error:{code}})+'\n');else process.stderr.write(code+'\n');process.exitCode=1;});
