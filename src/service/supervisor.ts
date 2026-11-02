import {spawn,execFile} from 'node:child_process';
import {promisify,parseArgs} from 'node:util';
import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {join,isAbsolute,dirname,basename,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {readPrivateJson} from './config.js';
import {readServiceIntent} from './intent.js';
import {privateRuntime} from './runtime.js';
import {provenDead,removeDeadMarker,markerLock,lifecycleLock} from './recovery.js';
import {safeCode} from './ipc.js';
import {Fault} from '../core/errors.js';
const absolute=z.string().min(1).refine(isAbsolute);
const lock=z.strictObject({directory:absolute,name:z.enum(['owner.lock','network-connector.lock'])});
const jobSchema=z.strictObject({id:z.enum(['gateway','connector','panel','tunnel']),command:absolute,args:z.array(z.string().max(8192)).max(100),cwd:absolute,locks:z.array(lock).max(10).optional()});
const configSchema=z.strictObject({version:z.literal(1),runtime:absolute,coordinator:z.strictObject({node:absolute,cli:absolute}),jobs:z.array(jobSchema).max(4),intervalMs:z.number().int().min(1000).max(60000).optional()}).refine(value=>new Set(value.jobs.map(job=>job.id)).size===value.jobs.length);
type Config=z.infer<typeof configSchema>;
type Job=z.infer<typeof jobSchema>;
interface JobStatus {id:string;state:'running'|'started'|'stopped'|'failed';}
const markerSchema=z.strictObject({version:z.literal(1),pid:z.number().int().positive(),specHash:z.string().regex(/^[a-f0-9]{64}$/)});
const execute=promisify(execFile);
/** Commands are loaded once from an owner-only local file, never from network/public tool arguments. */
export class Supervisor {
 private constructor(private config:Config){}
 static async fromFile(path:string):Promise<Supervisor>{
  if(!isAbsolute(path))throw new Fault('INVALID_SUPERVISOR_CONFIGURATION');
  const parsed=configSchema.safeParse(await readPrivateJson(path));if(!parsed.success)throw new Fault('INVALID_SUPERVISOR_CONFIGURATION');
  await privateRuntime(parsed.data.runtime);return new Supervisor(parsed.data);
 }
 get intervalMs(){return this.config.intervalMs??2000;}
 tick():Promise<JobStatus[]>{return markerLock(this.config.runtime,'watchdog-cycle.lock',()=>this.reconcile());}
 private async reconcile():Promise<JobStatus[]>{
  const running=(await readServiceIntent(this.config.runtime))?.desired==='running';let ready=false;
  // The decision gateway is upstream of coordinator health; recovering it cannot depend on that health.
  const gateway=this.config.jobs.find(job=>job.id==='gateway');let gatewayStatus:JobStatus|undefined;
  if(gateway){try{gatewayStatus={id:'gateway',state:running?await this.reconcileEnabledJob(gateway):'stopped'};}catch{gatewayStatus={id:'gateway',state:'failed'};}}
  if(running){
   try{const {stdout}=await execute(this.config.coordinator.node,[this.config.coordinator.cli,'service','start','--recover','--runtime',this.config.runtime,'--json'],{cwd:dirname(this.config.coordinator.cli),timeout:30000,maxBuffer:65536});ready=JSON.parse(stdout).ready===true;}catch{/* Fail closed: no connector recovery without the selected coordinator. */}
  }
  const results:JobStatus[]=[{id:'coordinator',state:running?(ready?'running':'failed'):'stopped'}];
  for(const job of this.config.jobs){
   if(job.id==='gateway'){results.push(gatewayStatus!);continue;}
   if(job.id==='connector'&&!ready){results.push({id:job.id,state:running?'failed':'stopped'});continue;}
   try{results.push({id:job.id,state:job.id==='connector'?await this.reconcileEnabledJob(job):await this.reconcileJob(job)});}catch{results.push({id:job.id,state:'failed'});}
  }
  return results;
 }
 private reconcileEnabledJob(job:Job):Promise<'running'|'started'|'stopped'>{
  return lifecycleLock(this.config.runtime,async()=>{if((await readServiceIntent(this.config.runtime))?.desired!=='running')return 'stopped';return this.reconcileJob(job);});
 }
 private async reconcileJob(job:Job):Promise<'running'|'started'>{
  const runtime=this.config.runtime,name=`watchdog-${job.id}.json`,path=join(runtime,name),specHash=createHash('sha256').update(JSON.stringify(job)).digest('hex');
  try{
   await lstat(path);const marker=markerSchema.parse(await readPrivateJson(path));
   if(marker.specHash!==specHash)throw new Fault('SUPERVISOR_JOB_MISMATCH');
   if(!provenDead(marker.pid))return 'running';
   await removeDeadMarker(runtime,name);
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const lock of job.locks??[])await removeDeadMarker(lock.directory,lock.name);
  const log=await open(join(runtime,`watchdog-${job.id}.log`),constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{
   const info=await log.stat();if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600)throw new Fault('UNSAFE_RUNTIME');
   const child=spawn(job.command,job.args,{cwd:job.cwd,shell:false,detached:true,stdio:['ignore',log.fd,log.fd]});
   await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
   try{
    const marker=await open(path,'wx',0o600);try{await marker.writeFile(JSON.stringify({version:1,pid:child.pid,specHash})+'\n');await marker.sync();}finally{await marker.close();}
   }catch(error){child.kill('SIGTERM');throw error;}
   child.unref();return 'started';
  }finally{await log.close();}
 }
}
async function main(){
 let args;try{args=parseArgs({options:{config:{type:'string'},once:{type:'boolean'},'recover-lock':{type:'string'}},strict:true,allowPositionals:false});}catch{throw new Fault('INVALID_ARGUMENTS');}
 if(args.values['recover-lock']){
  if(args.values.config||args.values.once||!isAbsolute(args.values['recover-lock']))throw new Fault('INVALID_ARGUMENTS');
  const path=args.values['recover-lock'];await removeDeadMarker(dirname(path),basename(path));process.stdout.write('{"recovery_checked":true}\n');return;
 }
 if(!args.values.config)throw new Fault('INVALID_ARGUMENTS');const supervisor=await Supervisor.fromFile(args.values.config);
 if(args.values.once){process.stdout.write(JSON.stringify(await supervisor.tick())+'\n');return;}
 let stopped=false;let wake:()=>void=()=>{};for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{stopped=true;wake();});
 while(!stopped){try{await supervisor.tick();}catch(error){process.stderr.write(safeCode(error)+'\n');}if(stopped)break;await new Promise<void>(resolve=>{const timer=setTimeout(resolve,supervisor.intervalMs);wake=()=>{clearTimeout(timer);resolve();};});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main().catch(error=>{process.stderr.write(safeCode(error)+'\n');process.exitCode=1;});
