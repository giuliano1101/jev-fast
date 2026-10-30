import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserAdapter} from '../../src/browser/adapter.js';
import {FixtureServer} from '../../fixtures/server.js';
import type {Goal} from '../../src/core/contracts.js';
const signal=new AbortController().signal;

test('rich form observations distinguish completed field, selection, and submit readiness without raw values',{timeout:20000},async()=>{
 const fixture=await FixtureServer.start(),browser=new BrowserAdapter(fixture.origin);
 try{
  await browser.open('form','standard');const goal:Goal={task:'form',language:'en',seed:25};
  const first=await browser.observe('form',goal),empty=JSON.parse(first.safe_summary);
  assert.equal(empty.projection?.version,'fixture-v2');assert.equal(empty.projection.name_matches_goal,false);
  assert.equal(empty.projection.next_step,'fill_name');assert.match(empty.projection.instruction,/name.*next.*category.*submit/i);
  assert.ok(first.candidates.some(c=>c.target_ref==='cancel'));
  await browser.execute('form',first.candidates[0]!,goal,signal);
  const filled=await browser.observe('form',goal),afterName=JSON.parse(filled.safe_summary);
  assert.equal(afterName.projection.name_matches_goal,true);assert.equal(afterName.projection.next_step,'next');
  assert.ok(!filled.candidates.some(c=>c.target_ref==='name'));
  await browser.execute('form',filled.candidates[0]!,goal,signal);
  const select=await browser.observe('form',goal);assert.equal(JSON.parse(select.safe_summary).projection.next_step,'select_category');
  await browser.execute('form',select.candidates[0]!,goal,signal);
  const ready=await browser.observe('form',goal),readySummary=JSON.parse(ready.safe_summary);
  assert.equal(readySummary.projection.category_matches_goal,true);assert.equal(readySummary.projection.next_step,'submit');
  assert.match(ready.candidates[0]!.description,/ready.*submit/i);assert.ok(ready.candidates.some(c=>c.target_ref==='cancel'));
  for(const observation of [first,filled,select,ready])assert.doesNotMatch(observation.safe_summary,/Synthetic-25|synthetic-25@|CANARY|"complete"/);
 }finally{await browser.shutdown();await fixture.close();}
});

test('correction error remains visible while email progress distinguishes fill from resubmit',{timeout:20000},async()=>{
 const fixture=await FixtureServer.start(),browser=new BrowserAdapter(fixture.origin);
 try{
  await browser.open('correction','standard');const goal:Goal={task:'correction',language:'zh',seed:27};
  const initial=await browser.observe('correction',goal);assert.equal(JSON.parse(initial.safe_summary).projection?.next_step,'show_validation');
  await browser.execute('correction',initial.candidates[0]!,goal,signal);
  const error=await browser.observe('correction',goal),before=JSON.parse(error.safe_summary);
  assert.equal(before.error,true);assert.equal(before.projection.email_matches_goal,false);assert.equal(before.projection.next_step,'fill_email');
  await browser.execute('correction',error.candidates[0]!,goal,signal);
  const corrected=await browser.observe('correction',goal),after=JSON.parse(corrected.safe_summary);
  assert.equal(after.error,true);assert.equal(after.projection.email_matches_goal,true);assert.equal(after.projection.next_step,'submit');
  assert.notEqual(corrected.safe_summary,error.safe_summary);assert.match(corrected.candidates[0]!.description,/corrected.*submit/i);
  assert.ok(corrected.candidates.some(c=>c.target_ref==='cancel'));assert.ok(!corrected.candidates.some(c=>c.target_ref==='email'));
 }finally{await browser.shutdown();await fixture.close();}
});

test('legacy mode preserves the prior summary and descriptions',{timeout:20000},async()=>{
 const fixture=await FixtureServer.start(),browser=new BrowserAdapter(fixture.origin,{projection:'legacy'});
 try{
  await browser.open('legacy','standard');const goal:Goal={task:'form',language:'en',seed:31};
  const snapshot=await browser.observe('legacy',goal);
  assert.deepEqual(JSON.parse(snapshot.safe_summary),{task:'form',step:0,submitted:0,cancelled:false,loaded:false,scrolled:false,error:false});
  assert.equal(snapshot.candidates[0]!.description,'fill name (synthetic action)');
 }finally{await browser.shutdown();await fixture.close();}
});
