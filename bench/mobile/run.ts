/** Host-only reproducible runner. Importing this module never connects a phone or provider. */
import {lstat,open,rename,type FileHandle} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {runHybridSession,type HybridPlanner,type HybridResult} from '../hybrid/controller.js';
import {FileExecutionJournal,type ExecutionJournal} from '../hybrid/execution-journal.js';
import {procedureScopeSchema,type ProcedureScope} from '../hybrid/workflow-contracts.js';
import {readLocalKey,RequestBudget} from '../live/access.js';
import {MobileHybridAdapter,type MobileToolTiming} from './adapter.js';
import {getMobileTask,type MobileTaskId} from './catalog.js';
import {decideMobile,MobileDecisionError,type MobileAccounting,type MobileDecisionOptions} from './decision.js';
import {MobileTransport,type MobileClient} from './transport.js';

export const MOBILE_RUN_LIMITS=Object.freeze({maxActions:12,maxDurationMs:300000,maxDecisions:13,maxTransportCalls:120});
const taskSchema=z.enum(['M1','M2','M3','M4','M5','M6']);
const trialSchema=z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const modeSchema=z.enum(['jev','teacher-plan']);
const approvalSchema=z.strictObject({approval_id:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),expires_at:z.number().int().positive(),public_controls_only:z.literal(true)});
const leaseKey='mobile-surface'; // Deliberately stable across trials, task IDs, modes, and scope changes.
export interface MobileTrialOptions {
 transport:Pick<MobileTransport,'call'>;journal:ExecutionJournal;taskId:MobileTaskId;trialId:string;scope:ProcedureScope;
 mode:'jev'|'teacher-plan';teacher?:HybridPlanner;provider?:MobileDecisionOptions;signal?:AbortSignal;
}
export interface MobileProviderEvent {usage:MobileAccounting['usage'];status:'decided'|'failed';code?:string;elapsed_ms:number;request_count:number;known_cost_usd:number;unknown_usage_requests:number}
export interface MobileTrialReport {
 schemaVersion:1;taskId:MobileTaskId;trialId:string;mode:MobileTrialOptions['mode'];label:'jev-mobile-catalog-research'|'host-plan-smoke-not-jev';
 result:HybridResult;accounting:Omit<MobileAccounting,'usage'>;providerEvents:MobileProviderEvent[];toolTimings:MobileToolTiming[];elapsed_ms:number;preflight_ms:number;measurement_note:string;
}
function authorized(provider:MobileDecisionOptions|undefined):provider is MobileDecisionOptions {
 const approval=approvalSchema.safeParse(provider?.authorization);
 return approval.success&&approval.data.expires_at>Date.now()&&typeof provider?.key==='string'&&/^[\x21-\x7e]{1,4096}$/.test(provider.key)&&typeof provider.reserve==='function';
}
function failed(reason:string,status:HybridResult['status']='FAILED'):HybridResult {
 return {status,reason,actions:0,decisions:0,teacherHandoffs:0,executors:{direct:0,jev:0,teacher:0},events:[],elapsedMs:0};
}
/** Caller owns transport and journal lifetimes. Teacher input must come from the current host;
 * no oracle, catalog action sequence, or procedure store is used to manufacture a plan.
 */
export async function runMobileTrial(options:MobileTrialOptions):Promise<MobileTrialReport> {
 if(!options?.journal||['getPending','begin','acknowledge','reconcile'].some(key=>typeof (options.journal as unknown as Record<string,unknown>)[key]!=='function'))throw Error('MOBILE_JOURNAL_REQUIRED');
 if(!taskSchema.safeParse(options.taskId).success||!trialSchema.safeParse(options.trialId).success||!modeSchema.safeParse(options.mode).success||!procedureScopeSchema.safeParse(options.scope).success||typeof options.transport?.call!=='function')throw Error('INVALID_MOBILE_RUN');
 if(options.mode==='jev'&&!authorized(options.provider))throw Error('LIVE_NOT_AUTHORIZED');
 if(options.mode==='teacher-plan'&&typeof options.teacher!=='function')throw Error('HOST_PLAN_REQUIRED');
 const started=performance.now(),deadline=Math.min(Date.now()+MOBILE_RUN_LIMITS.maxDurationMs,options.mode==='jev'?options.provider!.authorization.expires_at:Infinity);
 const task=getMobileTask(options.taskId),adapter=new MobileHybridAdapter(options.transport,options.taskId);
 const report:MobileTrialReport={schemaVersion:1,taskId:options.taskId,trialId:options.trialId,mode:options.mode,label:options.mode==='jev'?'jev-mobile-catalog-research':'host-plan-smoke-not-jev',result:failed('RESET_REJECTED'),accounting:{request_count:0,known_cost_usd:0,unknown_usage_requests:0},providerEvents:[],toolTimings:adapter.toolTimings,elapsed_ms:0,preflight_ms:0,measurement_note:'Use result.elapsedMs for the matched controlled-workflow comparison: it excludes reset preflight and SDK connection time. elapsed_ms includes reset preflight but excludes SDK connection time; accounting retains every provider request and all known cost.'};
 const signal=AbortSignal.any([AbortSignal.timeout(Math.max(1,deadline-Date.now())),...(options.signal?[options.signal]:[])]);
 const add=(value:MobileAccounting,elapsed_ms:number,status:MobileProviderEvent['status'],code?:string)=>{
  report.accounting.request_count+=value.request_count;report.accounting.known_cost_usd+=value.known_cost_usd;report.accounting.unknown_usage_requests+=value.unknown_usage_requests;
  report.providerEvents.push({usage:value.usage?{...value.usage}:null,status,...(code?{code}:{}),elapsed_ms,request_count:value.request_count,known_cost_usd:value.known_cost_usd,unknown_usage_requests:value.unknown_usage_requests});
 };
 try {
  // Durable UNKNOWN blocks even preflight UI reads; it is never automatically reconciled.
  if(await options.journal.getPending(leaseKey)){report.result=failed('SURFACE_QUARANTINED','UNKNOWN');return report;}
  const reset=await adapter.observe({signal,deadline});
  if(reset.readiness!=='settled'||reset.predicates.page_home!==true)return report;
  if(options.mode==='jev'&&!authorized(options.provider)){report.result=failed('LIVE_NOT_AUTHORIZED');return report;}
  report.result=await runHybridSession({
   ...(options.mode==='jev'?{policy:'catalog' as const}:{}),sessionId:`mobile_${options.trialId}`,leaseKey,scope:options.scope,
   goalPredicates:task.goalPredicates,catalog:task.catalog,adapter,journal:options.journal,signal,settle:{maxDurationMs:10000,maxObservations:6},
   budget:{maxActions:12,maxDurationMs:Math.max(1,Math.min(300000,deadline-Date.now())),maxDecisions:13},teacher:options.teacher,
   ...(options.mode==='jev'?{jev:async(request,context)=>{
    try {
     const decision=await decideMobile({task_id:options.taskId,trial_id:options.trialId,predicates:request.observation.predicates,candidates:request.candidates},{...options.provider!,signal:AbortSignal.any([context.signal,...(options.provider!.signal?[options.provider!.signal]:[])])});
     add(decision,decision.elapsed_ms,'decided');
     // Controller deliberately accepts exactly these two fields. Accounting is host-owned.
     return {actionId:decision.actionId,confidence:decision.confidence};
    }catch(error){
     if(error instanceof MobileDecisionError)add(error.accounting,error.elapsed_ms,'failed',error.code);
     else report.providerEvents.push({usage:null,status:'failed',code:'PROVIDER_FAILED',elapsed_ms:0,request_count:0,known_cost_usd:0,unknown_usage_requests:0});
     throw Error('MOBILE_DECISION_FAILED');
    }
   }}:{}),
  });
  if(report.result.status==='SUCCEEDED'&&report.result.actions===0){report.result.status='FAILED';report.result.reason='NO_ACTION_TRIAL';report.result.events=report.result.events.filter(event=>event.reason!=='GOAL_VERIFIED');}
  return report;
 }finally{report.elapsed_ms=performance.now()-started;report.preflight_ms=report.elapsed_ms-report.result.elapsedMs;}
}

const hostConfigSchema=z.strictObject({
 serverCommand:z.string().min(1).max(4096),serverArgs:z.array(z.string().max(8192)).max(128),serverEnv:z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),z.string().max(32768)).optional(),
 device:z.string().min(1).max(256),runtimeDirectory:z.string().refine(isAbsolute),scope:procedureScopeSchema,
});
type HostConfig=z.infer<typeof hostConfigSchema>;
/** Private JSON is read without following a final symlink and is never included in reports. */
async function privateJson(path:string):Promise<unknown> {
 try {
  const before=await lstat(path);
  if(!before.isFile()||before.nlink!==1||(before.mode&0o777)!==0o600||before.uid!==process.getuid?.()||before.size>65536)throw Error('REJECTED');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const opened=await file.stat();if(opened.dev!==before.dev||opened.ino!==before.ino)throw Error('REJECTED');const bytes=await file.readFile();if(bytes.length>65536)throw Error('REJECTED');return JSON.parse(bytes.toString('utf8'));}finally{await file.close();}
 }catch{throw Error('MOBILE_PRIVATE_FILE_REJECTED');}
}
export interface MobileConnection {client:MobileClient;close:()=>Promise<void>}
async function connect(config:HostConfig):Promise<MobileConnection> {
 const client=new Client({name:'jev-mobile-research-host',version:'1.0.0'});
 const transport=new StdioClientTransport({command:config.serverCommand,args:config.serverArgs,env:config.serverEnv,stderr:'pipe'});
 try {await client.connect(transport);transport.stderr?.on('data',()=>{});return {client,close:()=>client.close()};}catch{await client.close();throw Error('MOBILE_CONNECT_FAILED');}
}
const budgetSchema=z.strictObject({version:z.literal(1),requests:z.number().int().nonnegative(),maxUsd:z.number().positive().max(3),maxRequests:z.number().int().positive().max(300),expiresAt:z.number().int().positive()}).refine(value=>value.requests<=value.maxRequests&&value.requests/100<=value.maxUsd);
/** All paths are host supplied. No discovered device, default key, budget renewal or retries. */
export async function runMobileCli(argv:string[],dependencies:{connect?:(config:HostConfig)=>Promise<MobileConnection>}={}):Promise<MobileTrialReport> {
 const accepted=new Set(['--config','--task','--trial','--mode','--plan','--key-file','--approval-file','--budget-dir','--output']),args:Record<string,string>={};
 for(let i=0;i<argv.length;i+=2){const key=argv[i],value=argv[i+1];if(!key||!accepted.has(key)||!value||value.startsWith('--')||Object.hasOwn(args,key))throw Error('MOBILE_CLI_ARGUMENTS');args[key]=value;}
 if(!args['--config']||!args['--output']||!taskSchema.safeParse(args['--task']).success||!trialSchema.safeParse(args['--trial']).success||!modeSchema.safeParse(args['--mode']).success)throw Error('MOBILE_CLI_ARGUMENTS');
 const config=hostConfigSchema.parse(await privateJson(resolve(args['--config']))),taskId=taskSchema.parse(args['--task']),trialId=trialSchema.parse(args['--trial']),mode=modeSchema.parse(args['--mode']);
 let teacher:HybridPlanner|undefined,provider:MobileDecisionOptions|undefined,budget:RequestBudget|undefined,connection:MobileConnection|undefined,journal:FileExecutionJournal|undefined,output:FileHandle|undefined;
 const outputPath=resolve(args['--output']);
 try {
  // Reserve the audit path before opening the budget or connecting any device. A failed or
  // interrupted attempt retains its marker; an existing report can never trigger a rerun.
  output=await open(outputPath,'wx',0o600);
  await output.writeFile(JSON.stringify({schemaVersion:1,taskId,trialId,mode,status:'PREFLIGHT_NOT_COMPLETED'})+'\n');await output.sync();
  const outputDirectory=await open(dirname(outputPath),'r');try{await outputDirectory.sync();}finally{await outputDirectory.close();}
  if(mode==='teacher-plan'){
   if(!args['--plan']||args['--key-file']||args['--approval-file']||args['--budget-dir'])throw Error('MOBILE_CLI_ARGUMENTS');
   const allowed=getMobileTask(taskId).catalog.actions.map(action=>action.actionId);
   const plan=z.array(z.string().refine(value=>allowed.includes(value))).min(1).max(12).parse(await privateJson(resolve(args['--plan'])));
   teacher=async()=>({actionIds:[...plan]});
  }else{
   if(!args['--key-file']||!args['--approval-file']||!args['--budget-dir']||args['--plan'])throw Error('MOBILE_CLI_ARGUMENTS');
   const authorization=approvalSchema.parse(await privateJson(resolve(args['--approval-file'])));
   if(authorization.expires_at<=Date.now())throw Error('LIVE_NOT_AUTHORIZED');
   const directory=resolve(args['--budget-dir']);
   const state=budgetSchema.parse(await privateJson(join(directory,'budget.json')));
   if(state.expiresAt<=Date.now()||state.requests>=state.maxRequests||(state.requests+1)/100>state.maxUsd)throw Error('BUDGET_UNAVAILABLE');
   const key=readLocalKey(resolve(args['--key-file']));
   budget=RequestBudget.openExisting(directory,{maxUsd:state.maxUsd,maxRequests:state.maxRequests,expiresAt:state.expiresAt});
   provider={authorization,key,reserve:()=>budget!.reserve()};
  }
  journal=await FileExecutionJournal.open(join(config.runtimeDirectory,'journal'));
  if(mode==='jev'&&!authorized(provider))throw Error('LIVE_NOT_AUTHORIZED');
  connection=await (dependencies.connect??connect)(config);
  const report=await runMobileTrial({transport:new MobileTransport(connection.client,{device:config.device,maxCalls:120}),journal,taskId,trialId,scope:config.scope,mode,teacher,provider});
  const reserved=await output.stat(),current=await lstat(outputPath);
  if(!current.isFile()||current.nlink!==1||current.dev!==reserved.dev||current.ino!==reserved.ino)throw Error('MOBILE_OUTPUT_OWNERSHIP_LOST');
  const temporary=join(dirname(outputPath),`.mobile-report-${randomUUID()}.tmp`);
  const final=await open(temporary,'wx',0o600);
  try{await final.writeFile(`${JSON.stringify(report,null,2)}\n`);await final.sync();}finally{await final.close();}
  const beforeReplace=await lstat(outputPath);
  if(!beforeReplace.isFile()||beforeReplace.nlink!==1||beforeReplace.dev!==reserved.dev||beforeReplace.ino!==reserved.ino)throw Error('MOBILE_OUTPUT_OWNERSHIP_LOST');
  await rename(temporary,outputPath);
  const directory=await open(dirname(outputPath),'r');try{await directory.sync();}finally{await directory.close();}
  return report;
 }finally{
  // Each resource is closed even if another close fails. Errors remain observable to the host.
  try{await connection?.close();}finally{try{await journal?.close();}finally{try{budget?.close();}finally{await output?.close();}}}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runMobileCli(process.argv.slice(2)).then(report=>{process.stdout.write(JSON.stringify({taskId:report.taskId,trialId:report.trialId,label:report.label,status:report.result.status,reason:report.result.reason})+'\n');if(report.result.status!=='SUCCEEDED')process.exitCode=1;}).catch(()=>{process.stderr.write('MOBILE_RUN_REJECTED\n');process.exitCode=1;});
}
