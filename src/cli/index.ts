import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Fault} from '../core/errors.js';
import {parseTool,toolDefinitions} from '../service/contracts.js';
import {readCredential,ipcCall,safeCode,type Credential} from '../service/ipc.js';
import {defaultRuntime,privateRuntime} from '../service/runtime.js';
const help=`Jev local mock CLI\n\nCommands:\n  service start | health | stop [--runtime DIR]\n  schemas [--json]\n  demo [--runtime DIR] [--credential FILE] [--json]\n  open_session | observe | run_goal | cancel | status | close_session\n    --args '{"session_id":"..."}' [--credential FILE] [--json]\n\nAll tools share the coordinator safety gate. Only local synthetic fixtures and mock decisions are enabled.\nservice start --share-a-with-b enables an explicit a-to-b session ACL for local contention testing.\n`;
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function summary(value:unknown):string{
 if(typeof value!=='object'||value===null)return JSON.stringify(value);const row=value as Record<string,unknown>;
 if(row.status)return `${row.status}${row.reason?`: ${row.reason}`:''}${typeof row.steps==='number'?` (${row.steps} steps)`:''}`;
 if(row.stopped)return 'Service stopped.';if(row.ready)return `Service ready (mock)${row.already_running?' — already running':''}.`;
 if(row.closed)return 'Session closed.';if(row.session_id)return `Session ${row.session_id}${row.busy===true?' busy':''}.`;
 if(row.snapshot_id)return `Observation ${row.snapshot_id}: ${row.summary}`;
 return JSON.stringify(value);
}
async function health(runtime:string){return ipcCall(await readCredential(join(runtime,'client-a.json')),'service.health',{});}
async function start(runtime:string,shared:boolean):Promise<unknown>{
 try{const existing=await health(runtime);return {...existing as object,already_running:true};}catch{/* Start only after the credential and readiness checks fail; the exclusive locks arbitrate. */}
 await privateRuntime(runtime);
 const log=await open(join(runtime,'service.log'),constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
 try{const info=await log.stat();if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==process.getuid?.())throw new Fault('UNSAFE_RUNTIME');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../service/main.js',import.meta.url)),'--runtime',runtime,...(shared?['--share-a-with-b']:[])],{detached:true,stdio:['ignore',log.fd,log.fd]});
  let exited=false;child.once('exit',()=>{exited=true;});child.once('error',()=>{exited=true;});child.unref();
  for(let attempt=0;attempt<100;attempt++){try{return await health(runtime);}catch{if(exited)throw new Fault('SERVICE_START_FAILED');await delay(100);}}
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
 let args;try{args=parseArgs({options:{help:{type:'boolean',short:'h'},json:{type:'boolean'},runtime:{type:'string'},credential:{type:'string'},args:{type:'string'},'share-a-with-b':{type:'boolean'}},strict:true,allowPositionals:true});}catch{throw new Fault('INVALID_ARGUMENTS');}
 const {values,positionals}=args;if(values.help){process.stdout.write(help);return;}
 const runtime=resolve(values.runtime??defaultRuntime());let result:unknown;
 if(positionals.length===1&&positionals[0]==='schemas')result=toolDefinitions;
 else if(positionals[0]==='service'&&positionals.length===2){
  switch(positionals[1]){case 'start':result=await start(runtime,values['share-a-with-b']??false);break;case 'health':result=await health(runtime);break;case 'stop':result=await stop(runtime);break;default:throw new Fault('UNKNOWN_METHOD');}
 }else if(positionals.length===1&&positionals[0]==='demo')result=await demo(await readCredential(values.credential??join(runtime,'client-a.json')));
 else if(positionals.length===1){
  let input:unknown;try{input=JSON.parse(values.args??'{}');}catch{throw new Fault('INVALID_ARGUMENTS');}
  const method=positionals[0]!.startsWith('jev.')?positionals[0]!: 'jev.'+positionals[0];
  const request=parseTool(method,input);result=await ipcCall(await readCredential(values.credential??join(runtime,'client-a.json')),method,request);
 }else throw new Fault('INVALID_ARGUMENTS');
 process.stdout.write((values.json?JSON.stringify(result):summary(result))+'\n');
}
void main().catch(error=>{const code=safeCode(error);if(process.argv.includes('--json'))process.stdout.write(JSON.stringify({error:{code}})+'\n');else process.stderr.write(code+'\n');process.exitCode=1;});
