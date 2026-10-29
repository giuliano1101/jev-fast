import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeLive,pairedComparison,reconcileTrials,type TrialRow} from '../../bench/live/report.js';
function row(overrides:Partial<TrialRow>={}):TrialRow{return {id:'r',mode:'jev',family:'locate',difficulty:'easy',seed:1,phase:'evaluation',status:'SUCCEEDED',elapsed_ms:100,setup_ms:10,actions:1,wrong_actions:0,rejections:0,decisions:1,requests:1,cost_usd:.001,reason:null,...overrides};}
test('all started trials remain in reliability and latency denominators',()=>{
 const s=summarizeLive([row(),row({id:'failed',status:'LOW_CONFIDENCE',elapsed_ms:1000,reason:'LOW_CONFIDENCE',cost_usd:null})]) as Record<string,unknown>;
 assert.equal(s.tasks,2);assert.equal(s.successes,1);assert.equal(s.success_rate,.5);assert.equal(s.p95_all_started_ms,1000);assert.equal(s.known_cost_usd,.001);assert.equal(s.unknown_cost_trials,1);
 const ci=s.success_rate_95_interval as {lower:number;upper:number};assert.ok(ci.lower<.5&&ci.upper>.5);
});
test('recovered success is distinct from first-pass reliability',()=>{
 const s=summarizeLive([row({wrong_actions:1,actions:3}),row()]) as Record<string,unknown>;
 assert.equal(s.successes,2);assert.equal(s.clean_successes,1);assert.equal(s.recovered_successes,1);assert.equal(s.wrong_actions,1);
});
test('paired speed ratio excludes failures without removing them from failure accounting',()=>{
 const p=pairedComparison([row(),row({id:'c1',mode:'computer-use',elapsed_ms:1000,cost_usd:null}),row({id:'j2',seed:2,status:'LOW_CONFIDENCE'}),row({id:'c2',seed:2,mode:'computer-use',elapsed_ms:500,cost_usd:null}),row({id:'cal',phase:'calibration'})]) as Record<string,unknown>;
 assert.equal(p.matched_cases,2);assert.equal(p.both_clean_successes,1);assert.equal(p.median_paired_speed_ratio,10);assert.equal(p.jev_failures_in_matched_cases,1);
});
test('empty trials produce null ratios and no invented timing or success',()=>{
 const s=summarizeLive([]) as Record<string,unknown>;const p=pairedComparison([]) as Record<string,unknown>;
 assert.equal(s.success_rate,null);assert.equal(s.p95_all_started_ms,null);assert.equal(p.median_paired_speed_ratio,null);
});
test('partial known cost is retained when another request usage is unknown',()=>{
 const s=summarizeLive([row({cost_usd:null,known_cost_usd:.002,unknown_usage_requests:1})]);
 assert.equal(s.known_cost_usd,.002);
});
test('censored interrupted timing is excluded from percentiles but retained in success denominator',()=>{
 const s=summarizeLive([row(),row({id:'interrupted',status:'UNKNOWN',elapsed_ms:20,latency_censored:true})]);
 assert.equal(s.tasks,2);assert.equal(s.success_rate,.5);assert.equal(s.p50_all_started_ms,100);
});
test('durable starts without terminal rows become censored UNKNOWN and are not dropped',()=>{
 const events=[{trial:'lost',phase:'trial',status:'started',started_at:1234,mode:'jev',spec:{family:'locate',difficulty:'easy',seed:2,mode:'jev'}},
 {trial:'lost',phase:'transport',status:'reserved',request:1},
 {trial:'lost',phase:'provider',status:'decided',at_ms:400,usage:{input_tokens:100,output_tokens:1},unknown_usage_requests:0}];
 const rows=reconcileTrials([row()],events);assert.equal(rows.length,2);
 const lost=rows.find(r=>r.id==='lost')!;assert.equal(lost.status,'UNKNOWN');assert.equal(lost.latency_censored,true);assert.equal(lost.elapsed_ms,400);assert.equal(lost.requests,1);assert.equal(lost.actions_known,false);assert.ok(lost.known_cost_usd!>0);
});
test('completed trials remain unique and duplicate terminal IDs fail loudly',()=>{
 const start={trial:'r',phase:'trial',status:'started',started_at:1234,mode:'jev',spec:{family:'locate',difficulty:'easy',seed:1,mode:'jev'}};
 assert.equal(reconcileTrials([row()],[start]).length,1);
 assert.throws(()=>reconcileTrials([row(),row()],[start]),/DUPLICATE_TERMINAL_ROW/);
});
