import test from 'node:test';
import assert from 'node:assert/strict';
import type {DecisionInput, DecisionProvider} from '../../src/core/contracts.js';
import {ChallengeServer, launchChallengeBrowser, type ChallengeSpec} from '../../bench/live/challenge.js';
const modulePath='../../bench/live/run.js';
const runner=await import(modulePath).catch(()=>null);
test('bounded graded harness exports its runner',()=>assert.ok(runner?.runTrial,'runTrial is required'));
function answer(input:DecisionInput,confidence=.99){return {provider:'mock',model:'mock-v1',snapshot_id:input.snapshot_id,candidate_id:input.candidates[0]!.candidate_id,confidence,usage:null,elapsed_ms:0,request_count:1,retry_count:0,unknown_usage_requests:1};}
function spec(family:ChallengeSpec['family'],difficulty:ChallengeSpec['difficulty'],run:string):ChallengeSpec{return {family,difficulty,seed:1,mode:'test',run};}
test('scripted visible-controls baseline solves all six variants and includes loading time',{timeout:35000},async()=>{
 assert.ok(runner);const server=await ChallengeServer.start(),browser=await launchChallengeBrowser();
 try{for(const family of ['locate','form'] as const)for(const difficulty of ['easy','medium','hard'] as const){
  const page=await browser.newPage({viewport:{width:900,height:600}});
  const result=await runner.runTrial(page,server.origin,spec(family,difficulty,`${family}-${difficulty}`),'scripted');
  assert.equal(result.row.status,'SUCCEEDED',JSON.stringify(result.row));assert.equal(result.row.wrong_actions,0);assert.equal(result.oracle.complete_count,1);
  assert.equal(result.row.elapsed_ms,result.oracle.page_elapsed_ms);assert.ok(result.row.decisions<=12);assert.equal(result.row.requests,0);
  if(family==='form'&&difficulty==='hard')assert.ok(result.row.elapsed_ms>=800);
  if(family==='locate'&&difficulty==='hard'){assert.ok(result.row.elapsed_ms>=350);assert.ok(result.events.some((event:Record<string,unknown>)=>event.phase==='baseline-policy'&&event.reason==='SCRIPTED_KNOWN_REFRESH_WAIT'&&event.wait_ms===350));}
  await page.close();
 }}finally{await browser.close();await server.close();}
});
test('low confidence and invalid candidate answers stop before physical input; reasons are redacted',{timeout:20000},async()=>{
 assert.ok(runner);const server=await ChallengeServer.start(),browser=await launchChallengeBrowser();
 try{for(const [kind,expected] of [['low','LOW_CONFIDENCE'],['invalid','INVALID_DECISION'],['throw','PROVIDER_FAILED']] as const){
  const page=await browser.newPage();const provider:DecisionProvider={async decide(input){assert.equal(input.goal.task,'detail');assert.match(input.summary,/button labeled exactly/);assert.doesNotMatch(JSON.stringify(input),/challengeOracle|page_start_at|complete_count|final_state/);if(kind==='throw')throw new Error('SECRET_KEY_DO_NOT_LOG');return {...answer(input,kind==='low'?.4:.99),...(kind==='invalid'?{candidate_id:'missing'}:{})};}};
  const result=await runner.runTrial(page,server.origin,spec('locate','easy',kind),'jev',provider);
  assert.equal(result.row.reason,expected);assert.equal(result.oracle.actions,0);assert.equal(result.row.status,'FAILED');assert.doesNotMatch(JSON.stringify(result),/SECRET_KEY/);assert.equal(result.row.cost_usd,null);await page.close();
 }}finally{await browser.close();await server.close();}
});
test('Jev routes a singleton wait through its provider and awaits audit before execution',{timeout:20000},async()=>{
 assert.ok(runner);const server=await ChallengeServer.start(),browser=await launchChallengeBrowser(),page=await browser.newPage();let calls=0;const log:unknown[]=[];
 try{const provider:DecisionProvider={async decide(input){calls++;assert.equal(input.candidates.length,1);assert.match(input.candidates[0]!.description,/Wait/);return answer(input,.1);}};
  const result=await runner.runTrial(page,server.origin,spec('form','hard','wait'),'jev',provider,{onEvent:async(event:unknown)=>{log.push(event);}});
  assert.equal(calls,1);assert.equal(result.row.reason,'LOW_CONFIDENCE');assert.equal(result.oracle.actions,0);assert.deepEqual(result.events,log);
 }finally{await browser.close();await server.close();}
});
test('post-input lost acknowledgement remains UNKNOWN even when scoring oracle says success',{timeout:20000},async()=>{
 assert.ok(runner);const server=await ChallengeServer.start(),browser=await launchChallengeBrowser(),page=await browser.newPage();let prototype:Record<string,unknown>|undefined,original:unknown;const audit:Record<string,unknown>[]=[];
 try{const provider:DecisionProvider={async decide(input){const handle=await page.getByRole('button',{name:'Open Sample-1',exact:true}).elementHandle();assert.ok(handle);prototype=Object.getPrototypeOf(handle);original=prototype!.click;
   prototype!.click=async function(this:unknown,...args:unknown[]){assert.ok(audit.some(e=>e.phase==='execute'&&e.status==='started'));await (original as (...args:unknown[])=>Promise<void>).apply(this,args);throw new Error('lost private response');};
   const choice=input.candidates.find(c=>c.description.startsWith('Click Open Sample-1 — Name: Sample-1 ')&&!c.description.includes('copy'));assert.ok(choice);return {...answer(input),candidate_id:choice.candidate_id};}};
  const result=await runner.runTrial(page,server.origin,spec('locate','easy','lost'),'jev',provider,{onEvent:async(event:Record<string,unknown>)=>{audit.push(event);}});
  assert.equal(result.oracle.success,true);assert.equal(result.oracle.complete_count,1);assert.equal(result.row.status,'UNKNOWN');assert.equal(result.row.reason,'EXECUTION_UNKNOWN');assert.equal(result.row.decisions,1);
 }finally{if(prototype)prototype.click=original;await browser.close();await server.close();}
});
test('stale snapshots refresh at most twice, consume decisions, and never execute',{timeout:20000},async()=>{
 assert.ok(runner);const server=await ChallengeServer.start(),browser=await launchChallengeBrowser(),page=await browser.newPage();let calls=0;
 try{const provider:DecisionProvider={async decide(input){calls++;await page.waitForTimeout(2050);return answer(input);}};
  const result=await runner.runTrial(page,server.origin,spec('locate','easy','ttl'),'jev',provider);
  assert.equal(calls,3);assert.equal(result.row.decisions,3);assert.equal(result.row.rejections,3);assert.equal(result.row.reason,'STALE_REFRESH_LIMIT');assert.equal(result.oracle.actions,0);
  assert.equal(result.events.filter((e:Record<string,unknown>)=>e.preinput_stale===true).length,3);
 }finally{await browser.close();await server.close();}
});
test('recoverable wrong choices remain scored and known usage is summed',{timeout:20000},async()=>{
 assert.ok(runner);const server=await ChallengeServer.start(),browser=await launchChallengeBrowser(),page=await browser.newPage();let calls=0;
 try{const provider:DecisionProvider={async decide(input){const label=calls++===0?'Sample-11':'Sample-1';const choice=input.candidates.find(c=>c.description.startsWith(`Click Open ${label} — `));assert.ok(choice);
   return {...answer(input),candidate_id:choice.candidate_id,usage:{input_tokens:100,output_tokens:2},unknown_usage_requests:0};}};
  const result=await runner.runTrial(page,server.origin,spec('locate','easy','recover'),'jev',provider);
  assert.equal(result.row.status,'SUCCEEDED');assert.equal(result.oracle.recovered,true);assert.equal(result.row.wrong_actions,1);assert.equal(result.row.requests,2);assert.equal(result.row.cost_usd,200*.042/1e6);assert.equal(result.row.known_cost_usd,200*.042/1e6);assert.equal(result.row.unknown_usage_requests,0);
  assert.ok(result.events.some((e:Record<string,unknown>)=>e.phase==='terminal'&&e.recovered===true));
 }finally{await browser.close();await server.close();}
});
test('twelve-step cap retains every wrong action and audit failure prevents input',{timeout:20000},async()=>{
 assert.ok(runner);const server=await ChallengeServer.start(),browser=await launchChallengeBrowser();
 try{const provider:DecisionProvider={async decide(input){const choice=input.candidates.find(c=>c.description.startsWith('Click Open Sample-11 — '));assert.ok(choice);return {...answer(input),candidate_id:choice.candidate_id};}};
  const page=await browser.newPage();const result=await runner.runTrial(page,server.origin,spec('locate','easy','cap'),'jev',provider);assert.equal(result.row.decisions,12);assert.equal(result.row.reason,'STEP_LIMIT');assert.equal(result.row.wrong_actions,12);assert.equal(result.row.requests,12);await page.close();
  const auditPage=await browser.newPage();const stopped=await runner.runTrial(auditPage,server.origin,spec('locate','easy','audit'),'scripted',undefined,{onEvent:async(event:Record<string,unknown>)=>{if(event.phase==='execute')throw new Error('disk failed');}});assert.equal(stopped.oracle.actions,0);assert.notEqual(stopped.row.status,'SUCCEEDED');await auditPage.close();
 }finally{await browser.close();await server.close();}
});

test('manifest plan freezes six calibration cases and sixty alternating evaluation trials',()=>{assert.ok(runner);const calibration=runner.liveCases('calibration'),evaluation=runner.liveCases('evaluation');assert.equal(calibration.length,6);assert.ok(calibration.every((c:{spec:ChallengeSpec;mode:string})=>c.spec.seed===101&&c.mode==='jev'));assert.equal(evaluation.length,60);assert.deepEqual(evaluation.slice(0,4).map((c:{mode:string})=>c.mode),['jev','scripted','scripted','jev']);assert.ok(Object.isFrozen(evaluation));assert.ok(Object.isFrozen(evaluation[0].spec));});

test('partial usage retains known spend while total remains unknown',{timeout:20000},async()=>{
 assert.ok(runner);const server=await ChallengeServer.start(),browser=await launchChallengeBrowser(),page=await browser.newPage();let calls=0;
 try{const provider:DecisionProvider={async decide(input){const first=calls++===0;const choice=input.candidates.find(c=>c.description.startsWith(`Click Open ${first?'Sample-11':'Sample-1'} — `));assert.ok(choice);return {...answer(input),candidate_id:choice.candidate_id,...(first?{usage:{input_tokens:100,output_tokens:2},unknown_usage_requests:0}:{})};}};
  const result=await runner.runTrial(page,server.origin,spec('locate','easy','partial-usage'),'jev',provider);
  assert.equal(result.row.status,'SUCCEEDED');assert.equal(result.row.cost_usd,null);assert.equal(result.row.known_cost_usd,100*.042/1e6);assert.equal(result.row.unknown_usage_requests,1);
 }finally{await browser.close();await server.close();}
});
test('terminal commit clears active before detail failure, preserving exactly one row',async()=>{
 assert.ok(runner);const writes:unknown[]=[];let active=true;
 await assert.rejects(()=>runner.persistTrialResult({row:{id:'one'},events:[],oracle:{}},{rows:'rows',results:'results'},async(path:string,value:unknown)=>{if(path==='results')throw new Error('disk full');writes.push(value);},()=>{active=false;}),/disk full/);
 assert.equal(active,false);assert.equal(writes.length,1);
});
test('durable start event carries absolute epoch and immutable trial identity',()=>{
 assert.ok(runner);const started=1234567890000;const start=runner.trialStartEvent(spec('form','easy','start'),'jev',started);
 assert.equal(start.started_at,started);assert.equal(start.at_ms,0);assert.equal(start.status,'started');assert.equal(start.trial,'start');assert.equal(start.mode,'jev');assert.deepEqual(start.spec,spec('form','easy','start'));
});
test('calibration seed 102 stays separate from evaluation seeds and invalid seed overrides fail',()=>{
 assert.ok(runner);const cases=runner.liveCases('calibration',102);assert.equal(cases.length,6);assert.ok(cases.every((c:{spec:ChallengeSpec;mode:string})=>c.spec.seed===102&&c.mode==='jev'&&c.spec.run.includes('-102-')));
 for(const seed of [1,100,106,101.5,NaN])assert.throws(()=>runner.liveCases('calibration',seed),/CALIBRATION_SEED_REJECTED/);
 assert.throws(()=>runner.liveCases('evaluation',102),/CALIBRATION_SEED_REJECTED/);
 assert.deepEqual([...new Set(runner.liveCases('evaluation').map((c:{spec:ChallengeSpec})=>c.spec.seed))],[1,2,3,4,5]);
});
