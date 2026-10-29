import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {reconcileTrials,summarizeLive,pairedComparison,type TrialRow} from './report.js';
import type {ChallengeOracle} from './challenge.js';

async function json(path:string){return JSON.parse(await readFile(path,'utf8'));}
async function jsonLines<T>(path:string):Promise<{items:T[];partial_tail:boolean}>{
 let text:string;try{text=await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {items:[],partial_tail:false};throw error;}
 const lines=text.trimEnd().split('\n').filter(Boolean),items:T[]=[];let partial_tail=false;
 for(const [index,line] of lines.entries())try{items.push(JSON.parse(line));}catch{if(index!==lines.length-1||text.endsWith('\n'))throw new Error('CORRUPT_JSONL');partial_tail=true;}
 return {items,partial_tail};
}
async function loadRun(directory:string){
 const [manifest,rows,events]=await Promise.all([json(join(directory,'manifest.json')),jsonLines<TrialRow>(join(directory,'rows.jsonl')),jsonLines<Record<string,unknown>>(join(directory,'events.jsonl'))]);
 return {directory,manifest,rows:reconcileTrials(rows.items,events.items),partial_tail:rows.partial_tail||events.partial_tail};
}
export async function collect(calibrationDirectory:string,evaluationDirectory:string){
 const output=resolve('artifacts/live/report');await mkdir(output,{recursive:true,mode:0o700});
 const calibration=await loadRun(resolve(calibrationDirectory)),evaluation=await loadRun(resolve(evaluationDirectory));
 const scores=await json(resolve('artifacts/live/computer-use/scores.json')) as ChallengeOracle[];
 const operator=await json(resolve('artifacts/live/computer-use/operator.json'));
 const controlManifest=await json(resolve('artifacts/live/computer-use/manifest.json'));
 const controlRows:TrialRow[]=controlManifest.tasks.map((spec:{run:string;family:TrialRow['family'];difficulty:TrialRow['difficulty'];seed:number})=>{
  const score=scores.find(s=>s.run===spec.run),observed=operator.trials.find((t:{run:string})=>t.run===spec.run);
  const success=score?.success&&score.complete_count===1&&observed?.outcome==='ui_completed';
  return {id:spec.run,mode:'computer-use',family:spec.family,difficulty:spec.difficulty,seed:spec.seed,phase:'evaluation',status:success?'SUCCEEDED':'UNKNOWN',
   elapsed_ms:score?.page_elapsed_ms??0,latency_censored:!success,setup_ms:0,actions:score?.actions??0,actions_known:!!score,
   wrong_actions:score?.wrong_actions??0,rejections:observed?.tool_action_errors??0,decisions:0,requests:0,cost_usd:null,reason:success?null:'CONTROL_INCOMPLETE'};
 });
 const rows=[...evaluation.rows,...controlRows],groups:Record<string,ReturnType<typeof summarizeLive>>={};
 for(const mode of ['jev','computer-use','scripted'] as const){groups[mode]=summarizeLive(rows.filter(r=>r.mode===mode));for(const difficulty of ['easy','medium','hard']){
  groups[`${mode}/${difficulty}`]=summarizeLive(rows.filter(r=>r.mode===mode&&r.difficulty===difficulty));
  for(const family of ['locate','form'])groups[`${mode}/${difficulty}/${family}`]=summarizeLive(rows.filter(r=>r.mode===mode&&r.difficulty===difficulty&&r.family===family));
 }}
 const smokeFiles=(await readdir(resolve('artifacts/live'))).filter(name=>/^smoke-\d+\.json$/.test(name));
 const smoke=await Promise.all(smokeFiles.map(name=>json(resolve('artifacts/live',name))));
 const history=[];
 for(const phase of ['calibration','evaluation'])for(const entry of await readdir(resolve('artifacts/live',phase),{withFileTypes:true})){
  if(!entry.isDirectory())continue;
  const run=await loadRun(resolve('artifacts/live',phase,entry.name));
  const totals=summarizeLive(run.rows);
  history.push({directory:run.directory,phase,status:run.manifest.status,seeds:[...new Set(run.rows.map(r=>r.seed))],summary:totals,
   accounting:run.manifest.accounting??{known_cost_usd:totals.known_cost_usd,unknown_usage_requests:totals.unknown_usage_requests}});
 }
 const budget=await json(resolve('.runtime/live-budget/budget.json'));
 const cost={known_jev_usd:smoke.reduce((n,s)=>n+(s.accounting?.known_cost_usd??0),0)+history.reduce((n,r)=>n+(r.accounting.known_cost_usd??0),0),
  unknown_usage_requests:smoke.reduce((n,s)=>n+(s.accounting?.unknown_usage_requests??0),0)+history.reduce((n,r)=>n+(r.accounting.unknown_usage_requests??0),0),
  reserved_requests:budget.requests,conservative_reserved_usd:budget.requests/100,maximum_usd:budget.maxUsd,control_session_cost_usd:null,price_source:'https://docs.typesafe.ai/models'};
 const report={created_at:new Date().toISOString(),timezone:'Asia/Shanghai',groups,paired:pairedComparison(rows),
  paired_by_difficulty:Object.fromEntries(['easy','medium','hard'].map(d=>[d,pairedComparison(rows.filter(r=>r.difficulty===d))])),
  calibration:summarizeLive(calibration.rows),run_history:history,cost,source_directories:{calibration:calibration.directory,evaluation:evaluation.directory,computer_use:resolve('artifacts/live/computer-use')},
  evidence:{evaluation_planned_cases:evaluation.manifest.cases?.length,reconciled_evaluation_rows:evaluation.rows.length,partial_tail:calibration.partial_tail||evaluation.partial_tail,operator_tool_errors:operator.tool_action_errors,operator_setup_notes:operator.setup_notes},
  limitations:['Controlled synthetic webpages; real browser operations and real hosted Jev decisions; no native macOS applications or real user accounts.',
   'Jev Playwright Chromium vs ordinary Codex IAB AX/DOM tools, narrower candidate space and deterministic fill extraction; operational architecture comparison, not isolated model speed.',
   '12-step exploratory graded harness, not the shipped 8-step P0 engine; confidence threshold fixed at 0.9.',
   'Primary latency starts at page script initialization and includes control delay, model/tool roundtrips and recovery; browser startup/navigation before initialization and post-completion observation excluded.',
   'Percentiles include only uncensored observed timings; interrupted trials remain in success denominators. p95 is nearest rank and small strata have wide uncertainty.',
   'Wrong actions count rejected progression/decoy clicks, not every temporary field edit. Clean success means no recorded page mistake; tool/guard recovery is reported separately.',
   'Comparison cost for current Codex session is unavailable, not zero; API costs are reported token-based estimates, not invoices.'],
 };
 await writeFile(join(output,'rows.json'),JSON.stringify(rows,null,2),{mode:0o600});
 await writeFile(join(output,'summary.json'),JSON.stringify(report,null,2),{mode:0o600});
 const fields=['id','mode','family','difficulty','seed','status','elapsed_ms','wrong_actions','rejections','requests','cost_usd','reason'] as const;
 await writeFile(join(output,'rows.csv'),[fields.join(','),...rows.map(r=>fields.map(k=>JSON.stringify(r[k]??'')).join(','))].join('\n')+'\n',{mode:0o600});
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==4){console.error('Usage: node dist/bench/live/collect.js CALIBRATION_DIR EVALUATION_DIR');process.exitCode=1;}
 else collect(process.argv[2]!,process.argv[3]!).then(report=>console.log(JSON.stringify(report))).catch(()=>{console.error('LIVE_REPORT_FAILED_CLOSED');process.exitCode=1;});
}
