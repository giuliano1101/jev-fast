import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserAdapter} from '../../src/browser/adapter.js';
import {FixtureServer} from '../../fixtures/server.js';
import {taskSchema,type Goal} from '../../src/core/contracts.js';
const signal=new AbortController().signal;
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
   assert.equal(await browser.validate(id,snapshot,choice,goal,signal),true);
   seen.add(choice.operation);await browser.execute(id,choice,goal,signal);assert.equal(await browser.check(id,choice.expected_postcondition),true,`${task}: ${choice.description}`);actions++;
  }
  assert.ok(await browser.check(id,{kind:'task_complete'}),task);await browser.close(id);
 }assert.deepEqual([...seen].sort(),['back','click','fill','scroll','select','wait']);}finally{await browser.shutdown();await fixture.close();}
});
