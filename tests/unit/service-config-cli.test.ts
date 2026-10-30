import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,chmod,symlink,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const cli=resolve('dist/src/cli/index.js');
async function run(args:string[]){return new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{const child=spawn(process.execPath,[cli,...args],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});}
test('private mock config, policy diagnostics, and start profile comparison',{timeout:30000},async()=>{
 const root=await mkdtemp('/tmp/jev-config-'),runtime=join(root,'run'),config=join(root,'config.json');await writeFile(config,JSON.stringify({mode:'mock'}),{mode:0o600});
 try{
  const start=await run(['service','start','--runtime',runtime,'--config',config,'--json']);assert.equal(start.code,0,start.stdout+start.stderr);
  const health=JSON.parse((await run(['doctor','--runtime',runtime,'--json'])).stdout);assert.equal(health.provider,'mock');assert.equal(health.model,'mock-v1');assert.equal(health.protocol,'decision-v1');assert.equal(health.enforcement,'advisory-only');assert.equal(health.remoteReachable,null);assert.ok(health.build);assert.match(health.profileFingerprint,/^sha256:/);
  const doctorDefault=await run(['doctor','--runtime',runtime]);assert.equal(JSON.parse(doctorDefault.stdout).enforcement,'advisory-only');
  const policy=JSON.parse((await run(['policy','status','--runtime',runtime,'--json'])).stdout);assert.equal(policy.policy,'p0-v1');
  const same=await run(['service','start','--runtime',runtime,'--config',config,'--json']);assert.equal(JSON.parse(same.stdout).already_running,true);
  const conflict=await run(['service','start','--runtime',runtime,'--share-a-with-b','--json']);assert.equal(JSON.parse(conflict.stdout).error.code,'SERVICE_PROFILE_MISMATCH');
 }finally{await run(['service','stop','--runtime',runtime,'--json']);await rm(root,{recursive:true,force:true});}
});
test('CLI rejects unsafe and unknown configuration without leaking file contents',async()=>{
 const root=await mkdtemp('/tmp/jev-config-'),config=join(root,'secret.json'),runtime=join(root,'run');
 try{
  await writeFile(config,JSON.stringify({mode:'mock',secret:'DO_NOT_LEAK'}),{mode:0o600});
  const unknown=await run(['service','start','--runtime',runtime,'--config',config,'--json']);assert.equal(JSON.parse(unknown.stdout).error.code,'INVALID_SERVICE_CONFIGURATION');assert.ok(!unknown.stdout.includes('DO_NOT_LEAK'));
  await writeFile(config,JSON.stringify({mode:'mock'}));await chmod(config,0o644);
  const unsafe=await run(['service','start','--runtime',runtime,'--config',config,'--json']);assert.equal(JSON.parse(unsafe.stdout).error.code,'UNSAFE_PRIVATE_FILE');
  await chmod(config,0o600);await symlink(config,join(root,'link'));
  const link=await run(['service','start','--runtime',runtime,'--config',join(root,'link'),'--json']);assert.equal(JSON.parse(link.stdout).error.code,'UNSAFE_PRIVATE_FILE');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('CLI rejects command-specific flags instead of silently ignoring them',async()=>{
 for(const args of [['schemas','--runtime','/tmp/unused'],['doctor','--args','{}'],['service','health','--credential','/tmp/unused'],['demo','--args','{}']]){
  const result=await run([...args,'--json']);assert.equal(result.code,1);assert.equal(JSON.parse(result.stdout).error.code,'INVALID_ARGUMENTS');
 }
});
test('doctor inspects installation even before a service exists and does not create runtime',async()=>{
 const root=await mkdtemp('/tmp/jev-doctor-'),runtime=join(root,'missing');
 try{const result=await run(['doctor','--runtime',runtime,'--json']);assert.equal(result.code,0,result.stdout+result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.ready,false);assert.equal(value.installation.node.supported,true);assert.equal(value.installation.runtime.status,'missing');assert.equal(typeof value.installation.chromium.executableAvailable,'boolean');const {access}=await import('node:fs/promises');await assert.rejects(access(runtime));}finally{await rm(root,{recursive:true,force:true});}
});
