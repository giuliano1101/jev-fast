import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserAdapter} from '../../src/browser/adapter.js';
import {FixtureServer} from '../../fixtures/server.js';
import {taskSchema,type Goal,type Snapshot,type Candidate} from '../../src/core/contracts.js';
const signal=new AbortController().signal;
async function validatedOrCompleted(browser:BrowserAdapter,id:string,snapshot:Snapshot,choice:Candidate,goal:Goal):Promise<boolean>{
 const valid=await browser.validate(id,snapshot,choice,goal,signal);
 if(!valid&&(goal.task==='async'||goal.task==='wait')&&await browser.check(id,{kind:'task_complete'}))return false;
 assert.equal(valid,true,`${goal.task}/${goal.language}: ${choice.description} became stale before execution`);return true;
}
for(const language of ['en','zh'] as const) test(`F01–F03 real browser all twelve tasks ${language}`,{timeout:60000},async()=>{
 const fixture=await FixtureServer.start(); const browser=new BrowserAdapter(fixture.origin);
 const seen=new Set<string>();try{for(const task of taskSchema.options){
  const id=`task_${task}`;await browser.open(id,'standard');const goal:Goal={task,language,seed:3};
  let actions=0; await browser.observe(id,goal);
  while(!await browser.check(id,{kind:'task_complete'})&&actions<8){
   const snapshot=await browser.observe(id,goal);const choice=snapshot.candidates[0];
   // Async fixtures may finish between the loop check and this observation.
   // An empty candidate set is valid only when the terminal state is now verified.
   if(!choice){assert.ok(await browser.check(id,{kind:'task_complete'}),`${task}: no candidate before completion`);break;}
   if(!await validatedOrCompleted(browser,id,snapshot,choice,goal))break;
   seen.add(choice.operation);await browser.execute(id,choice,goal,signal);assert.equal(await browser.check(id,choice.expected_postcondition),true,`${task}: ${choice.description}`);actions++;
  }
  assert.ok(await browser.check(id,{kind:'task_complete'}),task);await browser.close(id);
 }assert.deepEqual([...seen].sort(),['back','click','fill','scroll','select','wait']);}finally{await browser.shutdown();await fixture.close();}
});


test('async completion between observation and validation is an independently verified terminal race',{timeout:20000},async()=>{
 let page:import('playwright').Page|undefined;const fixture=await FixtureServer.start();const browser=new BrowserAdapter(fixture.origin,{onPage:(_id,p)=>{page=p;}});
 try{
  await browser.open('terminal_race','standard');const goal:Goal={task:'async',language:'en',seed:4};
  const initial=await browser.observe('terminal_race',goal);await page!.clock.install();
  await browser.execute('terminal_race',initial.candidates[0]!,goal,signal);
  const pending=await browser.observe('terminal_race',goal),wait=pending.candidates.find(c=>c.operation==='wait')!;assert.ok(wait);
  assert.equal(await browser.check('terminal_race',{kind:'task_complete'}),false);
  await page!.clock.fastForward(100);
  assert.equal(await browser.validate('terminal_race',pending,wait,goal,signal),false);
  assert.equal(await browser.check('terminal_race',{kind:'task_complete'}),true);
  assert.equal(await validatedOrCompleted(browser,'terminal_race',pending,wait,goal),false);
 }finally{await browser.shutdown();await fixture.close();}
});


test('terminal race handling preserves validation failures for other tasks and unfinished async tasks',async t=>{
 const browser=new BrowserAdapter('http://127.0.0.1:7777');
 t.mock.method(browser,'validate',async()=>false);t.mock.method(browser,'check',async()=>true);
 const snapshot={} as Snapshot,choice={description:'synthetic action'} as Candidate;
 await assert.rejects(validatedOrCompleted(browser,'test',snapshot,choice,{task:'form',language:'en',seed:1}),/form\/en: synthetic action became stale/);
 t.mock.method(browser,'check',async()=>false);
 await assert.rejects(validatedOrCompleted(browser,'test',snapshot,choice,{task:'async',language:'zh',seed:1}),/async\/zh: synthetic action became stale/);
});
