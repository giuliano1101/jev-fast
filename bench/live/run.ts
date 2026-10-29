/** Experimental graded harness: 12 decisions / 120 seconds, not the shipped 8-step P0 engine. */
import {mkdir,readFile,writeFile,open} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {Page} from 'playwright';
import {validateDecision,type DecisionProvider,type DecisionInput} from '../../src/core/contracts.js';
import {Fault} from '../../src/core/errors.js';
import {JevProvider} from '../../src/providers/jev.js';
import {readLocalKey,RequestBudget} from './access.js';
import {ChallengeServer,launchChallengeBrowser,challengeUrl,observeChallenge,executeChallenge,readOracle,type ChallengeSpec,type ChallengeObservation,type ChallengeCandidate,type ChallengeOracle} from './challenge.js';
import type {TrialRow} from './report.js';

export const HARNESS_LIMITS=Object.freeze({decisions:12,overall_ms:120000,provider_ms:15000,snapshot_ttl_ms:2000,stale_refreshes:2,minimum_confidence:.9});
type TrialResult={row:TrialRow;events:unknown[];oracle:ChallengeOracle};
export interface TrialOptions {onEvent?:(event:Record<string,unknown>)=>Promise<void>;phase?:TrialRow['phase'];}
/** Uses only the visible instruction and candidate descriptions, never the scoring oracle. */
function scriptedChoice(observation:ChallengeObservation):ChallengeCandidate|undefined{
 const {instruction,candidates}=observation;
 const exact=/labeled exactly “([^”]+)”/.exec(instruction)?.[1];
 if(exact)return candidates.find(c=>c.operation==='click'&&c.description.startsWith(`Click ${exact} — `));
 const name=/\bSample-\d+\b/.exec(instruction)?.[0];
 if(instruction.startsWith('Open the card')){
  const review=candidates.find(c=>c.operation==='click'&&c.description.startsWith('Click Mark reviewed — '));
  if(review)return review;
  return candidates.find(c=>c.operation==='click'&&c.description.includes(`Name: ${name} Status: Ready | Owner: Morgan `));
 }
 const wait=candidates.find(c=>c.operation==='wait');if(wait)return wait;
 const fill=candidates.find(c=>c.operation==='fill'&&!c.description.includes(`[current value: ${name}]`));if(fill)return fill;
 const category=/Choose category (alpha|beta|gamma),/.exec(instruction)?.[1];
 const select=candidates.find(c=>c.operation==='select'&&c.value===category&&!c.description.includes(`[current selection: ${category}]`));if(select)return select;
 const next=candidates.find(c=>c.operation==='click'&&/^Click (Next|Save)$/.test(c.description));if(next)return next;
 const checkbox=candidates.find(c=>c.description.includes('I checked the sample details [unchecked]'));if(checkbox)return checkbox;
 return candidates.find(c=>(c.operation==='click'&&c.description==='Click Confirm save')||(c.operation==='scroll'&&c.description==='Scroll to Confirm save'));
}
function failureOracle(spec:ChallengeSpec,start:number):ChallengeOracle{return {...spec,page_start_at:start,ready_at:null,completed_at:null,elapsed_ms:null,page_elapsed_ms:Date.now()-start,success:false,wrong_actions:0,actions:0,complete_count:0,recovered:false,interactions:[],final_state:{}};}
const reasons=new Set(['INVALID_DECISION','INVALID_PROBABILITIES','INVALID_RESPONSE','INVALID_RETRY_AFTER','UNSAFE_OBSERVATION','INVALID_CANDIDATE','PROVIDER_DEADLINE','PROVIDER_TRANSPORT_ERROR','PROVIDER_HTTP_ERROR','RESPONSE_LIMIT','USAGE_EXCEEDS_RESERVATION','REQUEST_CAP','COST_CAP','LIVE_NOT_AUTHORIZED','CANCELLED','TRIAL_DEADLINE']);
const safeReason=(error:unknown,fallback:string)=>error instanceof Fault&&reasons.has(error.code)?error.code:fallback;
async function bounded<T>(operation:()=>Promise<T>,deadline:number):Promise<T>{
 if(Date.now()>=deadline)throw new Fault('TRIAL_DEADLINE');let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Fault('TRIAL_DEADLINE')),Math.max(1,deadline-Date.now()));})]);}finally{if(timer)clearTimeout(timer);}
}
export function liveCases(phase:'calibration'|'evaluation',calibrationSeed=101){
 if(!Number.isInteger(calibrationSeed)||calibrationSeed<101||calibrationSeed>105||phase==='evaluation'&&calibrationSeed!==101)throw new Error('CALIBRATION_SEED_REJECTED');
 const cases:Array<Readonly<{spec:Readonly<ChallengeSpec>;mode:'jev'|'scripted'}>>=[];let index=0;
 for(const family of ['locate','form'] as const)for(const difficulty of ['easy','medium','hard'] as const)for(const seed of phase==='calibration'?[calibrationSeed]:[1,2,3,4,5]){
  const modes:Array<'jev'|'scripted'>=phase==='calibration'?['jev']:index++%2?['scripted','jev']:['jev','scripted'];
  for(const mode of modes)cases.push(Object.freeze({mode,spec:Object.freeze({family,difficulty,seed,mode:phase==='calibration'?'calibration':mode==='scripted'?'baseline':'jev',run:`${phase}-${family}-${difficulty}-${seed}-${mode}`})}));
 }return Object.freeze(cases);
}

export async function runTrial(page:Page,origin:string,spec:ChallengeSpec,mode:'jev'|'scripted',provider?:DecisionProvider,options:TrialOptions={}):Promise<{row:TrialRow;events:unknown[];oracle:ChallengeOracle}>{
 const frozen=Object.freeze({...spec}),start=Date.now(),deadline=start+HARNESS_LIMITS.overall_ms,events:unknown[]=[];
 const row:TrialRow={id:frozen.run,mode,family:frozen.family,difficulty:frozen.difficulty,seed:frozen.seed,phase:options.phase??(frozen.mode==='calibration'?'calibration':'evaluation'),status:'FAILED',elapsed_ms:0,setup_ms:0,actions:0,wrong_actions:0,rejections:0,decisions:0,requests:0,cost_usd:0,reason:null};
 const emit=async(event:Record<string,unknown>)=>{const entry={trial:frozen.run,at_ms:Date.now()-start,...event};events.push(entry);if(options.onEvent)await bounded(()=>options.onEvent!(entry),Math.max(deadline,Date.now()+1000));};
 const goal=Object.freeze({task:frozen.family==='form'?'form' as const:'detail' as const,language:'en' as const});
 let stale=0,uncertain=false,knownCost=0,unknownCost=false,unknownUsageRequests=0,completeVisible=false;
 try{
  const setup=performance.now();try{await page.goto(challengeUrl(origin,frozen),{waitUntil:'domcontentloaded',timeout:Math.max(1,deadline-Date.now())});}finally{row.setup_ms=performance.now()-setup;}
  // The auxiliary scripted baseline knows this fixture's one-time refresh schedule.
  // This explicit wait is included in page_elapsed_ms; Jev receives no such accommodation.
  if(mode==='scripted'&&frozen.family==='locate'&&frozen.difficulty==='hard'){
   await emit({phase:'baseline-policy',status:'waiting',reason:'SCRIPTED_KNOWN_REFRESH_WAIT',wait_ms:350});
   await bounded(()=>page.waitForTimeout(350),deadline);
  }
  for(let step=0;step<HARNESS_LIMITS.decisions;step++){
   if(Date.now()>=deadline){row.reason='TRIAL_DEADLINE';break;}
   const snapshotAt=Date.now(),observation=await bounded(()=>observeChallenge(page),deadline),snapshotId=`s${step}_${randomUUID()}`;
   await emit({phase:'observe',step,snapshot_id:snapshotId,revision:observation.revision,instruction:observation.instruction,summary:observation.summary,candidates:observation.candidates});
   if(/Completed\. Elapsed:/.test(observation.summary)){completeVisible=true;break;}
   if(!observation.candidates.length){row.reason='NO_CANDIDATES';break;}
   row.decisions++;let candidate:ChallengeCandidate|undefined,confidence:number|null=null;
   if(mode==='jev'){
    if(!provider){row.reason='PROVIDER_REQUIRED';unknownCost=true;break;}
    const input:DecisionInput={snapshot_id:snapshotId,synthetic:true,goal,summary:`Visible instruction: ${observation.instruction}\nVisible state: ${observation.summary}`.slice(0,4000),candidates:observation.candidates.map(c=>({candidate_id:c.id,description:c.description}))};
    const controller=new AbortController(),callDeadline=Math.min(deadline,Date.now()+HARNESS_LIMITS.provider_ms);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
     await emit({phase:'provider',step,status:'started',snapshot_id:snapshotId});
     const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Fault('PROVIDER_DEADLINE'));},Math.max(1,callDeadline-Date.now()));});
     const raw=await Promise.race([provider.decide(input,{signal:controller.signal,deadline:callDeadline}),timeout]);
     const decision=validateDecision(raw,snapshotId,observation.candidates.map(c=>c.id));
     row.requests+=decision.request_count;const missingUsage=Math.max(decision.unknown_usage_requests,decision.request_count-(decision.usage?1:0));unknownUsageRequests+=missingUsage;unknownCost ||= missingUsage>0;
     if(decision.usage)knownCost+=decision.usage.input_tokens*.042/1e6;
     confidence=decision.confidence;candidate=observation.candidates.find(c=>c.id===decision.candidate_id);
     await emit({phase:'provider',step,status:'decided',snapshot_id:snapshotId,candidate_id:decision.candidate_id,confidence,requests:decision.request_count,usage:decision.usage,unknown_usage_requests:decision.unknown_usage_requests,elapsed_ms:decision.elapsed_ms});
     if(Date.now()>=callDeadline){row.reason='PROVIDER_DEADLINE';break;}
     if(confidence<HARNESS_LIMITS.minimum_confidence){row.rejections++;row.reason='LOW_CONFIDENCE';break;}
    }catch(error){row.reason=safeReason(error,'PROVIDER_FAILED');unknownCost=true;await emit({phase:'provider',step,status:'failed',reason:row.reason});break;}
    finally{if(timer)clearTimeout(timer);controller.abort();}
   }else candidate=scriptedChoice(observation);
   if(!candidate){row.reason='NO_SCRIPTED_CHOICE';break;}
   // Audit is flushed before a physical operation. Recheck TTL after any slow audit sink.
   await emit({phase:'execute',step,status:'started',candidate_id:candidate.id,confidence,operation:candidate.operation,preinput_stale:false});
   let result:'executed'|'stale';
   if(Date.now()>=deadline){row.reason='TRIAL_DEADLINE';break;}
   if(Date.now()-snapshotAt>=HARNESS_LIMITS.snapshot_ttl_ms)result='stale';
   else{
    try{result=await executeChallenge(page,candidate!,observation.revision,{expiresAt:snapshotAt+HARNESS_LIMITS.snapshot_ttl_ms,deadline});}
    catch{uncertain=true;row.reason='EXECUTION_UNKNOWN';await emit({phase:'execute',step,status:'unknown',candidate_id:candidate.id,confidence,reason:row.reason});break;}
   }
   await emit({phase:'execute',step,status:result,candidate_id:candidate.id,confidence,preinput_stale:result==='stale',reason:result==='stale'?'PREINPUT_STALE':null});
   if(result==='stale'){row.rejections++;if(++stale>HARNESS_LIMITS.stale_refreshes){row.reason='STALE_REFRESH_LIMIT';break;}}
  }
  // Completion may occur on the twelfth input, so use visible state once more before scoring.
  if(!row.reason)completeVisible=/Completed\. Elapsed:/.test(await bounded(()=>page.locator('main').innerText({timeout:1000}),deadline));
  if(!row.reason&&!completeVisible)row.reason='STEP_LIMIT';
 }catch(error){row.reason=safeReason(error,'TRIAL_FAILED');}
 let oracle:ChallengeOracle;
 try{oracle=await bounded(()=>readOracle(page),Date.now()+1000);row.actions_known=true;row.latency_censored=false;}catch{row.actions_known=false;row.latency_censored=true;oracle=failureOracle(frozen,start);row.reason??='ORACLE_UNAVAILABLE';}
 row.actions=oracle.actions;row.wrong_actions=oracle.wrong_actions;row.elapsed_ms=oracle.page_elapsed_ms;row.cost_usd=unknownCost?null:knownCost;row.known_cost_usd=knownCost;row.unknown_usage_requests=unknownUsageRequests;
 row.status=uncertain?'UNKNOWN':!row.reason&&completeVisible&&oracle.success&&oracle.complete_count===1?'SUCCEEDED':'FAILED';
 if(row.status==='FAILED'&&!row.reason)row.reason='FALSE_COMPLETION';
 await emit({phase:'terminal',status:row.status,reason:row.reason,clean:row.status==='SUCCEEDED'&&row.wrong_actions===0,recovered:row.status==='SUCCEEDED'&&row.wrong_actions>0,known_cost_usd:knownCost,unknown_usage_requests:unknownUsageRequests,unknown_cost:unknownCost});
 return {row,events,oracle};
}

/** The start record is durable before setup, allowing recovery of every started trial. */
export function trialStartEvent(spec:ChallengeSpec,mode:'jev'|'scripted',startedAt:number){return {trial:spec.run,phase:'trial',status:'started',spec,mode,started_at:startedAt,at_ms:0};}
/** Once the row is durable, ancillary result failure must not append a second terminal row. */
export async function persistTrialResult(result:TrialResult,paths:{rows:string;results:string},append:(path:string,value:unknown)=>Promise<void>,committed:()=>void){
 await append(paths.rows,result.row);committed();await append(paths.results,result);
}
/** Each request attempt, including provider retries, reserves the same persistent budget before fetch. */
export async function runLive(keyPath:string,phase:'calibration'|'evaluation',calibrationSeed=101){
 if(phase!=='calibration'&&phase!=='evaluation')throw new Error('EXPLICIT_PHASE_REQUIRED');
 const cases=liveCases(phase,calibrationSeed);
 const root=resolve('artifacts/live',phase,`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
 await mkdir(root,{recursive:true,mode:0o700});
 const paths={directory:root,manifest:join(root,'manifest.json'),rows:join(root,'rows.jsonl'),events:join(root,'events.jsonl'),results:join(root,'results.jsonl')};
 const manifest:Record<string,unknown>={version:1,cases,status:'running',phase,created_at:new Date().toISOString(),harness:HARNESS_LIMITS,note:'Exploratory graded browser harness, not the shipped 8-step P0 engine. Scripted is an architecture baseline; no production acceleration claim.',paths};
 await writeFile(paths.manifest,JSON.stringify(manifest,null,2),{mode:0o600});
 const append=async(path:string,value:unknown)=>{const file=await open(path,'a',0o600);try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}};
 let budget:RequestBudget|undefined,server:ChallengeServer|undefined,provider:JevProvider|undefined,browser:Awaited<ReturnType<typeof launchChallengeBrowser>>|undefined;
 const rows:TrialRow[]=[];let active:{spec:ChallengeSpec;mode:'jev'|'scripted';started:number;requests:number;knownCost:number;unknownUsage:number;lastAtMs:number;terminalAttempted:boolean}|undefined;let transportRequests=0;
 try{
  // A prior smoke run establishes the original expiry. Never reset or extend its ledger.
  const prior=JSON.parse(await readFile(resolve('.runtime/live-budget/budget.json'),'utf8')) as {expiresAt:number;maxUsd:number;maxRequests:number};
  budget=RequestBudget.open(resolve('.runtime/live-budget'),{expiresAt:prior.expiresAt,maxUsd:Math.min(3,prior.maxUsd),maxRequests:Math.min(300,prior.maxRequests)});
  const key=readLocalKey(keyPath);
  provider=new JevProvider({key,authorization:{approval_id:'user-20261030-usd3',expires_at:budget.summary().expiresAt,synthetic_only:true,max_requests:300,max_cost_usd:3},transport:async(url,options)=>{
   if(url!=='https://api.typesafe.ai/v1/systemone'||options?.redirect!=='error')throw new Error('ENDPOINT_DENIED');
   const reservation=budget!.reserve();transportRequests++;
   await append(paths.events,{trial:active?.spec.run,phase:'transport',status:'reserved',request:reservation.request,at_ms:active?Date.now()-active.started:0});
   return fetch(url,{...options,redirect:'error'});
  }});
  server=await ChallengeServer.start();browser=await launchChallengeBrowser();
  const hashes:Record<string,string>={};for(const path of ['fixtures/challenge.html','bench/live/run.ts','bench/live/challenge.ts','bench/live/access.ts','src/providers/jev.ts','src/providers/request-body.ts'])hashes[path]=createHash('sha256').update(await readFile(resolve(path))).digest('hex');
  manifest.source_sha256=hashes;
  const executedHashes:Record<string,string>={};for(const path of ['./run.js','./challenge.js','./access.js','../../src/providers/jev.js','../../src/providers/request-body.js','../../src/core/contracts.js','../../src/core/errors.js'])executedHashes[path]=createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex');
  manifest.executed_sha256=executedHashes;manifest.runtime={node:process.version,platform:process.platform,arch:process.arch,browser:browser.version(),viewport:{width:900,height:600}};
  await writeFile(paths.manifest,JSON.stringify(manifest,null,2),{mode:0o600});
  for(const {spec,mode} of cases){
    active={spec,mode,started:Date.now(),requests:transportRequests,knownCost:provider.accounting().known_cost_usd,unknownUsage:provider.accounting().unknown_usage_requests,lastAtMs:0,terminalAttempted:false};
    await append(paths.events,trialStartEvent(spec,mode,active.started));
    const context=await browser.newContext({viewport:{width:900,height:600},acceptDownloads:false,serviceWorkers:'block'});
    try{
     const origin=server.origin;
     await context.route('**/*',async route=>{
      if(new URL(route.request().url()).origin!==origin){await route.abort('blockedbyclient');return;}
      try{const response=await route.fetch({maxRedirects:0,timeout:2000});if(response.status()>=300&&response.status()<400)await route.abort('blockedbyclient');else await route.fulfill({response});}catch{await route.abort('blockedbyclient').catch(()=>{});}
     });
     await context.routeWebSocket('**/*',socket=>socket.close());
     const page=await context.newPage();context.on('page',popup=>{if(popup!==page)void popup.close();});page.on('download',download=>{void download.cancel();});
     const result=await runTrial(page,origin,spec,mode,mode==='jev'?provider:undefined,{phase,onEvent:async event=>{active!.lastAtMs=typeof event.at_ms==='number'?Math.max(event.at_ms,active!.lastAtMs):active!.lastAtMs;await append(paths.events,event);}});
     result.row.requests=transportRequests-active.requests;
     result.row.known_cost_usd=provider.accounting().known_cost_usd-active.knownCost;result.row.unknown_usage_requests=provider.accounting().unknown_usage_requests-active.unknownUsage;result.row.cost_usd=result.row.unknown_usage_requests>0?null:result.row.known_cost_usd;
     active.terminalAttempted=true;
     await persistTrialResult(result,paths,append,()=>{rows.push(result.row);active=undefined;});
    }finally{await context.close();}
  }
  const report={...manifest,status:'completed',finished_at:new Date().toISOString(),rows:rows.length,budget:budget.summary(),accounting:provider.accounting()};
  await writeFile(paths.manifest,JSON.stringify(report,null,2),{mode:0o600});return {paths,rows,report};
 }catch{
  // A failed write may already have appended bytes. Recovery reconciles starts against rows; never append a competing terminal row.
  if(active&&!active.terminalAttempted){const row:TrialRow={id:active.spec.run,mode:active.mode,family:active.spec.family,difficulty:active.spec.difficulty,seed:active.spec.seed,phase,status:'UNKNOWN',elapsed_ms:active.lastAtMs,latency_censored:true,actions_known:false,known_cost_usd:(provider?.accounting().known_cost_usd??active.knownCost)-active.knownCost,unknown_usage_requests:(provider?.accounting().unknown_usage_requests??active.unknownUsage)-active.unknownUsage,setup_ms:0,actions:0,wrong_actions:0,rejections:0,decisions:0,requests:transportRequests-active.requests,cost_usd:null,reason:'RUN_INTERRUPTED'};await append(paths.rows,row);rows.push(row);}
  const report={...manifest,status:'failed',finished_at:new Date().toISOString(),rows:rows.length,reason:'LIVE_RUN_FAILED_CLOSED',...(budget?{budget:budget.summary()}: {}),...(provider?{accounting:provider.accounting()}: {})};
  await writeFile(paths.manifest,JSON.stringify(report,null,2),{mode:0o600});return {paths,rows,report};
 }finally{try{await browser?.close();}finally{try{await server?.close();}finally{budget?.close();}}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const phase=process.argv[3],seed=process.argv[4];
 if(!process.argv[2]||(phase!=='calibration'&&phase!=='evaluation')||!(process.argv.length===4||process.argv.length===5&&phase==='calibration'&&/^10[1-5]$/.test(seed??''))){console.error('Usage: node dist/bench/live/run.js KEY_PATH calibration [101..105] | KEY_PATH evaluation');process.exitCode=1;}
 else runLive(process.argv[2],phase,seed===undefined?101:Number(seed)).then(result=>{console.log(JSON.stringify({paths:result.paths,report:result.report}));if(result.report.status!=='completed')process.exitCode=1;}).catch(()=>{console.error('LIVE_RUN_FAILED_CLOSED');process.exitCode=1;});
}
