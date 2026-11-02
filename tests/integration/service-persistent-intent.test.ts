import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {executeBounded} from '../../src/control/server.js';
const cli=resolve('dist/src/cli/index.js');
const modulePath='../../src/service/intent.js';
const api=await import(modulePath);
const run=(runtime:string,args:string[])=>executeBounded(process.execPath,[cli,'service',...args,'--runtime',runtime,'--json'],{timeoutMs:20000});
test('bound running intent survives runtime deletion and recovery retains the exact configured profile',{timeout:30000},async()=>{
 assert.equal(typeof api.bindServiceIntent,'function');const root=await realpath(await mkdtemp('/tmp/jev-intent-persist-')),runtime=join(root,'run'),stable=join(root,'stable'),registry=join(stable,'bindings.json'),intentFile=join(stable,'intent.json'),config=join(root,'profile.json');
 const previous=process.env.JEV_SERVICE_INTENT_BINDINGS;process.env.JEV_SERVICE_INTENT_BINDINGS=registry;
 await writeFile(config,JSON.stringify({mode:'mock'}),{mode:0o600});
 try{
  const first=await run(runtime,['start','--config',config,'--share-a-with-b']);assert.equal(first.code,0,first.stdout);
  const pid=JSON.parse(await readFile(join(runtime,'service.lock'),'utf8')).pid;process.kill(pid,'SIGKILL');
  for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{break;}await new Promise(resolve=>setTimeout(resolve,20));}
  await api.bindServiceIntent(runtime,intentFile);const before=JSON.parse(await readFile(intentFile,'utf8'));assert.equal(before.desired,'running');assert.equal(before.selection.configFile,config);assert.equal(before.selection.shared,true);
  await rm(runtime,{recursive:true,force:true});const resumed=await run(runtime,['start','--recover']);assert.equal(resumed.code,0,resumed.stdout);assert.equal(JSON.parse(resumed.stdout).profileFingerprint,before.selection.fingerprint);
  assert.equal((await readFile(registry,'utf8')).includes(runtime),true);
 }finally{await run(runtime,['stop']);if(previous===undefined)delete process.env.JEV_SERVICE_INTENT_BINDINGS;else process.env.JEV_SERVICE_INTENT_BINDINGS=previous;await rm(root,{recursive:true,force:true});}
});
test('CLI stop updates only bound durable authority; deleting runtime cannot resurrect operator off',{timeout:30000},async()=>{
 assert.equal(typeof api.bindServiceIntent,'function');const root=await realpath(await mkdtemp('/tmp/jev-intent-off-')),runtime=join(root,'run'),stable=join(root,'stable'),registry=join(stable,'bindings.json'),intentFile=join(stable,'intent.json');const previous=process.env.JEV_SERVICE_INTENT_BINDINGS;process.env.JEV_SERVICE_INTENT_BINDINGS=registry;
 try{
  assert.equal((await run(runtime,['start'])).code,0);await api.bindServiceIntent(runtime,intentFile);
  // A stale runtime copy must never override the persistent stopped authority.
  assert.equal((await run(runtime,['stop'])).code,0);assert.equal(JSON.parse(await readFile(intentFile,'utf8')).desired,'stopped');await mkdir(runtime,{recursive:true,mode:0o700});await writeFile(join(runtime,'service-intent.json'),JSON.stringify({version:1,desired:'running',selection:{configFile:null,shared:false,fingerprint:'stale'}}),{mode:0o600});
  assert.equal((await api.readServiceIntent(runtime)).desired,'stopped');await rm(runtime,{recursive:true,force:true});const recovered=await run(runtime,['start','--recover']);assert.equal(recovered.code,0,recovered.stdout);assert.equal(JSON.parse(recovered.stdout).stopped,true);assert.notEqual((await run(runtime,['health'])).code,0);
 }finally{await run(runtime,['stop']);if(previous===undefined)delete process.env.JEV_SERVICE_INTENT_BINDINGS;else process.env.JEV_SERVICE_INTENT_BINDINGS=previous;await rm(root,{recursive:true,force:true});}
});
