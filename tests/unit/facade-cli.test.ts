import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const cli=resolve('dist/src/cli/index.js');
async function run(args:string[]){return new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{const child=spawn(process.execPath,[cli,...args],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});}
test('CLI help and generated schemas advertise only the same six tools',{timeout:10000},async()=>{
 const help=await run(['--help']);assert.equal(help.code,0);assert.match(help.stdout,/service start/);assert.match(help.stdout,/run_goal/);
 const schemas=await run(['schemas','--json']);assert.equal(schemas.code,0);assert.equal(JSON.parse(schemas.stdout).length,6);
 const rejected=await run(['open_session','--args','{"fixture_id":"standard","client_id":"b"}','--json']);assert.equal(rejected.code,1);assert.deepEqual(JSON.parse(rejected.stdout),{error:{code:'INVALID_ARGUMENTS'}});
});
test('CLI starts one daemon, reports readiness, executes a mock demo and stops via operator auth',{timeout:30000},async()=>{
 const dir=await mkdtemp('/tmp/jev-cli-');const runtime=join(dir,'run');
 try{
  const start=await run(['service','start','--runtime',runtime,'--json']);assert.equal(start.code,0,start.stderr+start.stdout);assert.equal(JSON.parse(start.stdout).ready,true);
  const again=await run(['service','start','--runtime',runtime,'--json']);assert.equal(again.code,0);assert.equal(JSON.parse(again.stdout).already_running,true);
  const health=await run(['service','health','--runtime',runtime,'--json']);assert.equal(JSON.parse(health.stdout).provider,'mock');
  const demo=await run(['demo','--runtime',runtime,'--json']);assert.equal(demo.code,0,demo.stderr+demo.stdout);assert.equal(JSON.parse(demo.stdout).status,'SUCCEEDED');
  const credential=JSON.parse(await readFile(join(runtime,'client-a.json'),'utf8'));assert.ok(!(await readFile(join(runtime,'service.log'),'utf8')).includes(credential.token));
  const stop=await run(['service','stop','--runtime',runtime,'--json']);assert.equal(stop.code,0,stop.stdout+stop.stderr);assert.equal(JSON.parse(stop.stdout).stopped,true);
  await assert.rejects(access(join(runtime,'coordinator.sock')));await assert.rejects(access(join(runtime,'operator.json')));
 }finally{await run(['service','stop','--runtime',runtime,'--json']);await rm(dir,{recursive:true,force:true});}
});
