import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {runLifecycle} from '../helpers/lifecycle.js';
const run=runLifecycle;
const wait=async(check:()=>Promise<boolean>)=>{for(let i=0;i<100;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('WAIT_TIMEOUT');};
test('explicit off survives unavailable RPC and recovery never starts a stopped service',{timeout:30000},async()=>{
 const root=await mkdtemp('/tmp/jev-off-'),runtime=join(root,'run');
 try{
  await run(runtime,['stop']);
  const intent=JSON.parse(await readFile(join(runtime,'service-intent.json'),'utf8'));assert.equal(intent.desired,'stopped');assert.equal((await stat(join(runtime,'service-intent.json'))).mode&0o777,0o600);
  const recovered=await run(runtime,['start','--recover']);assert.equal(recovered.code,0,recovered.stdout);assert.equal(JSON.parse(recovered.stdout).stopped,true);assert.notEqual((await run(runtime,['health'])).code,0);
 }finally{await run(runtime,['stop']);await rm(root,{recursive:true,force:true});}
});
test('crashed coordinator recovers selected profile and preserves durable ledgers; healthy recovery does not restart',{timeout:40000},async()=>{
 const root=await mkdtemp('/tmp/jev-recover-'),runtime=join(root,'run'),config=join(root,'profile.json');
 await writeFile(config,JSON.stringify({mode:'mock'}),{mode:0o600});
 try{
  // Default mock is explicitly selected for this isolated fixture, never a hosted fallback.
  const first=await run(runtime,['start','--config',config]);assert.equal(first.code,0,first.stdout);
  const initial=JSON.parse(await readFile(join(runtime,'service.lock'),'utf8'));
  const ledger=await readFile(join(runtime,'ledger','ledger.json'),'utf8');
  process.kill(initial.pid,'SIGKILL');await wait(async()=>{try{process.kill(initial.pid,0);return false;}catch{return true;}});
  await rm(config);const unavailable=await run(runtime,['start','--recover']);assert.notEqual(unavailable.code,0);assert.equal(JSON.parse(await readFile(join(runtime,'service.lock'),'utf8')).pid,initial.pid);
  await writeFile(config,JSON.stringify({mode:'mock'}),{mode:0o600});
  const recovered=await run(runtime,['start','--recover']);assert.equal(recovered.code,0,recovered.stdout);
  assert.equal(JSON.parse(recovered.stdout).ready,true);const next=JSON.parse(await readFile(join(runtime,'service.lock'),'utf8'));assert.notEqual(next.pid,initial.pid);
  assert.equal(await readFile(join(runtime,'ledger','ledger.json'),'utf8'),ledger);
  assert.equal((await run(runtime,['start','--recover'])).code,0);assert.equal(JSON.parse(await readFile(join(runtime,'service.lock'),'utf8')).pid,next.pid);
  await run(runtime,['stop']);assert.equal(JSON.parse(await readFile(join(runtime,'service-intent.json'),'utf8')).desired,'stopped');
  assert.equal(JSON.parse((await run(runtime,['start','--recover'])).stdout).stopped,true);
 }finally{await run(runtime,['stop']);await rm(root,{recursive:true,force:true});}
});
