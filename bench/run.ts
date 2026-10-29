import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,platform,release,arch,cpus,totalmem} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Engine,type EngineEvent} from '../src/core/engine.js';
import type {Goal,DecisionProvider} from '../src/core/contracts.js';
import {BrowserAdapter} from '../src/browser/adapter.js';
import {MockProvider} from '../src/providers/mock.js';
import {FixtureServer} from '../fixtures/server.js';
import {taskSuite,calibrationSeeds,evaluationSeeds} from '../fixtures/tasks.js';
import {summarize,type TaskRow,type Stages} from './metrics.js';
const stages=():Stages=>({observe:0,candidate:0,policy:0,provider:0,execute:0,verify:0});
type Progress={rows:TaskRow[];events:Array<EngineEvent&{task_id:string;mode:string}>;activeStart?:number;exported:boolean;unknownActions:number};
const hash=(data:string)=>createHash('sha256').update(data).digest('hex');
export async function runBenchmark(options:{outputDir:string;goals?:Goal[]}):Promise<{rows:TaskRow[]}>{
 const progress:Progress={rows:[],events:[],exported:false,unknownActions:0};const output=resolve(options.outputDir);
 await mkdir(output,{recursive:true});
 await writeFile(join(output,'manifest.json'),JSON.stringify({status:'running',live_api_called:false,samples:0}));
 await writeFile(join(output,'summary.md'),'# Jev P0 mock benchmark\n\nStatus: running. Previous results are superseded.\n');
 await writeFile(join(output,'tasks.csv'),'id,mode,task,language,seed,status,reason,elapsed_ms\n');
 await writeFile(join(output,'events.jsonl'),'');
 await writeFile(join(output,'summary.json'),JSON.stringify({status:'running'}));
 try{return await executeBenchmark(options,progress);}catch{
  if(!progress.exported){
   for(const row of progress.rows)if(row.status==='RUNNING'){row.status='FAILED';row.reason='RUN_FAILURE';row.elapsed_ms=performance.now()-(progress.activeStart??performance.now());row.fallback=true;}
   const overall=summarize(progress.rows);
   await writeFile(join(output,'manifest.json'),JSON.stringify({status:'failed',reason:'RUN_FAILURE',live_api_called:false,samples:progress.rows.length,unknown_actions:progress.unknownActions,created_at:new Date().toISOString()},null,2));
   await writeFile(join(output,'summary.md'),`# Jev P0 mock benchmark\n\nStatus: failed (RUN_FAILURE). Started tasks: ${overall.tasks}; successes: ${overall.successes}. No real API calls.\n`);
   await writeFile(join(output,'summary.json'),JSON.stringify({status:'failed',overall},null,2));
   await writeFile(join(output,'tasks.csv'),csvRows(progress.rows));
   await writeFile(join(output,'events.jsonl'),progress.events.map(event=>JSON.stringify(event)).join('\n')+'\n');
  }
  throw new Error('BENCHMARK_FAILED');
 }
}
async function executeBenchmark(options:{outputDir:string;goals?:Goal[]},progress:Progress):Promise<{rows:TaskRow[]}>{
 const output=resolve(options.outputDir);await mkdir(output,{recursive:true});
 const dir=await mkdtemp(join(tmpdir(),'jev-benchmark-'));const fixture=await FixtureServer.start();const browser=new BrowserAdapter(fixture.origin);
 let mode:'mock'|'scripted'='mock';const mock=new MockProvider();
 const provider:DecisionProvider={decide:async(i,c)=>{const d=await mock.decide(i,c);return mode==='scripted'?{...d,provider:'scripted',model:'scripted-v1'}:d;}};
 const events=progress.events;let taskId='';
 const engine=await Engine.create({storageDir:dir,browser,provider,clients:['benchmark'],onEvent:event=>events.push({...event,task_id:taskId,mode})});
 const rows=progress.rows;const goals=options.goals??taskSuite();let browserVersion='';let unknownActions=0;
 try{
 for(const [index,goal] of goals.entries())for(const selected of (index%2?['mock','scripted']:['scripted','mock']) as Array<'mock'|'scripted'>){
  mode=selected;taskId=`${goal.task}-${goal.language}-${goal.seed}-${mode}`;const start=performance.now();const eventStart=events.length;progress.activeStart=start;
  const pending:TaskRow={id:taskId,mode,task:goal.task,language:goal.language,seed:goal.seed,status:'RUNNING',reason:'',elapsed_ms:0,timeout_ms:60000,actions:0,action_errors:0,policy_rejections:0,fallback:false,safety_violations:0,requests:0,retries:0,input_tokens:0,output_tokens:0,cost_usd:0,stages:stages()};rows.push(pending);
  const session=await engine.openSession('benchmark',{fixture_id:'standard'});browserVersion=browser.browserVersion;
  const result=await engine.runGoal('benchmark',{session_id:session.session_id,goal_id:taskId,idempotency_key:taskId,goal,success:{kind:'task_complete'},max_steps:8,time_budget_ms:60000});
  const actionRecords=result.action_ids.map(id=>engine.ledger.state.actions[id]!);pending.actions=actionRecords.filter(a=>a.execution_started_at!==undefined&&a.status!=='REJECTED').length;pending.action_errors=actionRecords.filter(a=>a.status==='FAILED').length;
  progress.unknownActions=Object.values(engine.ledger.state.actions).filter(a=>a.status==='UNKNOWN').length;
  for(const event of events.slice(eventStart)){pending.stages[event.phase]+=event.elapsed_ms;pending.requests+=event.requests??0;pending.retries+=event.retries??0;}
  const oracle=await browser.check(session.session_id,{kind:'task_complete'});const status=result.status==='SUCCEEDED'&&!oracle?'ORACLE_FAILED':result.status;
  const actions=result.action_ids.map(id=>engine.ledger.state.actions[id]!);const taskEvents=events.slice(eventStart);const phase=stages();for(const event of taskEvents)phase[event.phase]+=event.elapsed_ms;
  const row:TaskRow={id:taskId,mode,task:goal.task,language:goal.language,seed:goal.seed,status,reason:result.reason??(oracle?'':'ORACLE_FAILED'),elapsed_ms:performance.now()-start,timeout_ms:60000,actions:actions.filter(a=>a.execution_started_at!==undefined&&a.status!=='REJECTED').length,action_errors:actions.filter(a=>a.status==='FAILED').length,policy_rejections:actions.filter(a=>a.status==='REJECTED').length+(['LOW_CONFIDENCE','INVALID_DECISION','INVALID_PROBABILITIES','UNSAFE_OBSERVATION','STALE_SNAPSHOT','PRECONDITION_FAILED','TOO_MANY_CANDIDATES'].includes(result.reason??'')?1:0),fallback:result.status==='FALLBACK'||result.status==='UNKNOWN',safety_violations:result.status==='SUCCEEDED'&&!oracle?1:0,requests:taskEvents.reduce((n,e)=>n+(e.requests??0),0),retries:taskEvents.reduce((n,e)=>n+(e.retries??0),0),input_tokens:0,output_tokens:0,cost_usd:0,stages:phase};
  Object.assign(pending,row);await engine.closeSession('benchmark',{session_id:session.session_id});
 }
 unknownActions=Object.values(engine.ledger.state.actions).filter(a=>a.status==='UNKNOWN').length;
 }finally{const cleanup=await Promise.allSettled([engine.shutdown()]);const rest=await Promise.allSettled([browser.shutdown(),fixture.close(),rm(dir,{recursive:true,force:true})]);if([...cleanup,...rest].some(r=>r.status==='rejected'))throw new Error('CLEANUP_FAILED');}
 let commit:string|null=null;try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{/* fresh project has no commit */}
 const manifest={status:rows.every(r=>r.status==='SUCCEEDED')&&!unknownActions?'passed':'failed',title:'Jev P0 mock benchmark — synthetic fixture only',created_at:new Date().toISOString(),timezone:'Asia/Shanghai',samples:rows.length,templates:12,evaluation_seeds:evaluationSeeds,calibration_seeds:calibrationSeeds,hardware:{cpu:cpus()[0]?.model,memory_bytes:totalmem(),platform:platform(),os:release(),arch:arch()},runtime:process.version,browser:browserVersion,code_commit:commit,lock_hash:hash(await readFile('package-lock.json','utf8')),fixture_hash:hash(await readFile('fixtures/page.html','utf8')),models:['mock-v1','scripted-v1'],live_api_called:false,authorization_id:null,max_steps:8,time_budget_ms:60000,snapshot_ttl_ms:2000,confidence_threshold:0.9,order:'paired alternating deterministic',cold_start:'first task includes browser launch; other tasks reuse browser, fresh contexts',baseline:'scripted first locally recommended candidate; mock uses same deterministic selection, no real LLM',cost:'mock simulation 0 USD; no paid request',unknown_actions:unknownActions,network_boundary:'loopback fixture only; cross-origin sink test evidence in safety suite'};
 const groups:Record<string,ReturnType<typeof summarize>>={};for(const m of ['scripted','mock']){groups[m]=summarize(rows.filter(r=>r.mode===m));for(const l of ['zh','en'])groups[`${m}/${l}`]=summarize(rows.filter(r=>r.mode===m&&r.language===l));for(const task of new Set(rows.map(r=>r.task)))groups[`${m}/${task}`]=summarize(rows.filter(r=>r.mode===m&&r.task===task));}
 const overall=summarize(rows);const summary=['# Jev P0 mock benchmark','',`Samples: ${rows.length}; success: ${overall.successes}/${overall.tasks}; UNKNOWN actions: ${unknownActions}.`,'','These are deterministic engineering baselines. No real Jev/API or main-agent LLM was invoked. Zero mock cost is not a hosted estimate.','', '| Mode / stratum | n | success | p50 ms | p95 ms | fallback | action errors |','|---|---:|---:|---:|---:|---:|---:|',...Object.entries(groups).map(([name,s])=>`| ${name} | ${s.tasks} | ${s.successes} | ${s.p50_ms?.toFixed(2)} | ${s.p95_ms?.toFixed(2)} | ${s.fallback_tasks} | ${s.action_errors} |`),'','All started tasks remain in the denominator. Percentiles use nearest rank; cost per success is null if no success. Timing starts before opening the task context, includes initialization, all decisions/actions/waits/verification, and ends at oracle check; context cleanup excluded. Fault cases are tested separately, never mixed into normal success rates. Phase observe includes browser candidate construction; phase candidate measures core candidate validation.','',`Failures: ${JSON.stringify(rows.filter(r=>r.status!=='SUCCEEDED').map(r=>({id:r.id,reason:r.reason})))}`,'','Recompute with `npm run bench:mock`. Raw rows and event phases are attached; summary.json contains all formula results.'].join('\n');
 const csv=csvRows(rows);
 const files:Record<string,string>={'manifest.json':JSON.stringify(manifest,null,2),'events.jsonl':events.map(e=>JSON.stringify(e)).join('\n')+'\n','tasks.csv':csv+'\n','summary.md':summary+'\n','summary.json':JSON.stringify({overall,groups},null,2)};
 for(const [name,text] of Object.entries(files)){if(/CANARY_|Bearer /.test(text))throw new Error('REDACTION_FAILED');await writeFile(join(output,name),text,{mode:0o600});}
 progress.exported=true;
 if(rows.some(r=>r.status!=='SUCCEEDED')||unknownActions)throw new Error('BENCHMARK_FAILED');return {rows};
}
function csvRows(rows:TaskRow[]):string{
 return ['id,mode,task,language,seed,status,reason,elapsed_ms,timeout_ms,actions,action_errors,policy_rejections,fallback,safety_violations,requests,retries,input_tokens,output_tokens,cost_usd,observe_ms,candidate_ms,policy_ms,provider_ms,execute_ms,verify_ms',...rows.map(r=>[r.id,r.mode,r.task,r.language,r.seed,r.status,r.reason,r.elapsed_ms,r.timeout_ms,r.actions,r.action_errors,r.policy_rejections,r.fallback,r.safety_violations,r.requests,r.retries,r.input_tokens,r.output_tokens,r.cost_usd,...Object.values(r.stages)].join(','))].join('\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){runBenchmark({outputDir:'artifacts/mock'}).then(r=>console.log(JSON.stringify({mode:'mock',tasks:r.rows.length,status:'passed',report:'artifacts/mock/summary.md'}))).catch(()=>{console.error('Mock benchmark failed; inspect generated artifacts.');process.exitCode=1;});}
