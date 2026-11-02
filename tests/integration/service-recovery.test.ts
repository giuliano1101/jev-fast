import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {executeBounded} from '../../src/control/server.js';
const cli=resolve('dist/src/cli/index.js');
const run=(runtime:string,args:string[])=>executeBounded(process.execPath,[cli,'service',...args,'--runtime',runtime,'--json'],{timeoutMs:20000});
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
test('watchdog recovers isolated coordinator and daemon crashes but never revives off',{timeout:40000},async()=>{
 const {Supervisor}=await import('../../src/service/supervisor.js');const root=await mkdtemp('/tmp/jev-chain-'),runtime=join(root,'run'),config=join(root,'watch.json'),fixture=join(root,'daemon.cjs');
 await writeFile(fixture,'setInterval(()=>{},1000);');const jobs=['gateway','connector','panel','tunnel'].map(id=>({id,command:process.execPath,args:[fixture],cwd:root}));
 await writeFile(config,JSON.stringify({version:1,runtime,coordinator:{node:process.execPath,cli},jobs}),{mode:0o600});const pids=new Set<number>();
 const pid=async(id:string)=>{const value=JSON.parse(await readFile(join(runtime,`watchdog-${id}.json`),'utf8')).pid as number;pids.add(value);return value;};
 try{
  assert.equal((await run(runtime,['start'])).code,0);const supervisor=await Supervisor.fromFile(config);
  const started=await supervisor.tick();assert.ok(started.every(row=>['running','started'].includes(row.state)));const connector=await pid('connector');for(const job of jobs)await pid(job.id);
  const coordinator=JSON.parse(await readFile(join(runtime,'service.lock'),'utf8')).pid;process.kill(coordinator,'SIGKILL');await wait(async()=>{try{process.kill(coordinator,0);return false;}catch{return true;}});
  assert.ok((await supervisor.tick()).every(row=>row.state==='running'));assert.notEqual(JSON.parse(await readFile(join(runtime,'service.lock'),'utf8')).pid,coordinator);assert.equal(await pid('connector'),connector);
  process.kill(connector,'SIGKILL');await wait(async()=>{try{process.kill(connector,0);return false;}catch{return true;}});assert.equal((await supervisor.tick()).find(row=>row.id==='connector')?.state,'started');const recovered=await pid('connector');assert.notEqual(recovered,connector);
  assert.equal((await run(runtime,['stop'])).code,0);process.kill(recovered,'SIGKILL');await wait(async()=>{try{process.kill(recovered,0);return false;}catch{return true;}});
  const off=await supervisor.tick();assert.equal(off.find(row=>row.id==='coordinator')?.state,'stopped');assert.equal(off.find(row=>row.id==='gateway')?.state,'stopped');assert.equal(off.find(row=>row.id==='connector')?.state,'stopped');assert.equal(await pid('connector'),recovered);assert.notEqual((await run(runtime,['health'])).code,0);
 }finally{for(const child of pids)try{process.kill(child,'SIGKILL');}catch{/* already exited */}await run(runtime,['stop']);await rm(root,{recursive:true,force:true});}
});
