import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm,mkdir,symlink,chmod,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {bindServiceIntent,readServiceIntent,writeServiceIntent,type ServiceIntent} from '../../src/service/intent.js';
import {lifecycleLock} from '../../src/service/recovery.js';
const running:ServiceIntent={version:1,desired:'running',selection:{configFile:null,shared:false,fingerprint:'fixture'}};
test('independent runtime bindings serialize registry updates and retain private durable authorities',async()=>{
 const root=await realpath(await mkdtemp('/tmp/jev-bindings-')),stable=join(root,'stable'),registry=join(stable,'bindings.json'),previous=process.env.JEV_SERVICE_INTENT_BINDINGS;process.env.JEV_SERVICE_INTENT_BINDINGS=registry;
 try{
  const runtimes=[join(root,'a'),join(root,'b')];for(const runtime of runtimes)await lifecycleLock(runtime,()=>writeServiceIntent(runtime,running));
  await Promise.all(runtimes.map((runtime,index)=>bindServiceIntent(runtime,join(stable,`intent-${index}.json`))));
  const bindings=JSON.parse(await readFile(registry,'utf8')).bindings;assert.deepEqual(bindings.map((row:{runtime:string})=>row.runtime).sort(),runtimes);assert.equal((await stat(registry)).mode&0o777,0o600);
  for(const runtime of runtimes)assert.deepEqual(await readServiceIntent(runtime),running);
  await bindServiceIntent(runtimes[0]!,join(stable,'intent-0.json'));await assert.rejects(bindServiceIntent(runtimes[0]!,join(stable,'other.json')),/SERVICE_INTENT_ALREADY_BOUND/);
  await rm(join(stable,'intent-0.json'));assert.equal(await readServiceIntent(runtimes[0]!),undefined,'missing bound authority must not use stale running runtime copy');
  await chmod(registry,0o644);await assert.rejects(readServiceIntent(runtimes[1]!),/SERVICE_INTENT_BINDING_INVALID/);
 }finally{if(previous===undefined)delete process.env.JEV_SERVICE_INTENT_BINDINGS;else process.env.JEV_SERVICE_INTENT_BINDINGS=previous;await rm(root,{recursive:true,force:true});}
});
test('binding rejects symlink parents/targets and never infers running from missing intent',async()=>{
 const root=await realpath(await mkdtemp('/tmp/jev-binding-private-')),stable=join(root,'stable'),runtime=join(root,'run'),registry=join(stable,'bindings.json'),previous=process.env.JEV_SERVICE_INTENT_BINDINGS;process.env.JEV_SERVICE_INTENT_BINDINGS=registry;
 try{
  await mkdir(stable,{mode:0o700});await assert.rejects(bindServiceIntent(runtime,join(stable,'missing.json')),/SERVICE_INTENT_MISSING/);assert.equal(await readServiceIntent(runtime),undefined);
  await lifecycleLock(runtime,()=>writeServiceIntent(runtime,running));await symlink(stable,join(root,'alias'));await assert.rejects(bindServiceIntent(runtime,join(root,'alias','intent.json')),/SERVICE_INTENT_BINDING_INVALID/);
  await writeFile(join(stable,'real.json'),JSON.stringify(running),{mode:0o600});await symlink(join(stable,'real.json'),join(stable,'intent.json'));await assert.rejects(bindServiceIntent(runtime,join(stable,'intent.json')),/SERVICE_INTENT_INVALID/);
  await rm(join(stable,'intent.json'));await bindServiceIntent(runtime,join(stable,'intent.json'));await rm(registry);await symlink(join(stable,'real.json'),registry);await assert.rejects(readServiceIntent(runtime),/SERVICE_INTENT_BINDING_INVALID/);
 }finally{if(previous===undefined)delete process.env.JEV_SERVICE_INTENT_BINDINGS;else process.env.JEV_SERVICE_INTENT_BINDINGS=previous;await rm(root,{recursive:true,force:true});}
});
test('runtime aliases share one authority before and after deleting the runtime directory',async()=>{
 const root=await realpath(await mkdtemp('/tmp/jev-binding-alias-')),stable=join(root,'stable'),runtime=join(root,'run'),aliasRoot=join(root,'alias'),aliasRuntime=join(aliasRoot,'run'),registry=join(stable,'bindings.json'),intentFile=join(stable,'intent.json'),previous=process.env.JEV_SERVICE_INTENT_BINDINGS;process.env.JEV_SERVICE_INTENT_BINDINGS=registry;
 try{
  await symlink(root,aliasRoot);await lifecycleLock(runtime,()=>writeServiceIntent(runtime,running));await bindServiceIntent(aliasRuntime,intentFile);
  assert.equal(JSON.parse(await readFile(registry,'utf8')).bindings[0].runtime,runtime,'registry stores physical identity');
  await lifecycleLock(runtime,()=>writeServiceIntent(runtime,{...running,desired:'stopped'}));assert.equal((await readServiceIntent(aliasRuntime))?.desired,'stopped');assert.equal(JSON.parse(await readFile(intentFile,'utf8')).desired,'stopped');
  await rm(runtime,{recursive:true,force:true});assert.equal((await readServiceIntent(aliasRuntime))?.desired,'stopped');
  await lifecycleLock(aliasRuntime,()=>writeServiceIntent(aliasRuntime,running));assert.equal((await readServiceIntent(runtime))?.desired,'running');assert.equal(JSON.parse(await readFile(intentFile,'utf8')).desired,'running');
  await bindServiceIntent(runtime,intentFile);assert.equal(JSON.parse(await readFile(registry,'utf8')).bindings.length,1);
 }finally{if(previous===undefined)delete process.env.JEV_SERVICE_INTENT_BINDINGS;else process.env.JEV_SERVICE_INTENT_BINDINGS=previous;await rm(root,{recursive:true,force:true});}
});
