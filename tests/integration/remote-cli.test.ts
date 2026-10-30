import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,access,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {makeRemoteCertificates,remoteFixture} from '../helpers/remote-fixture.js';
const entry=resolve('dist/src/cli/index.js');
async function run(args:string[]){return new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{const child=spawn(process.execPath,[entry,...args],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});}
test('remote CLI uses one configured agent, reports authenticated health, and stops while offline',{timeout:40000},async()=>{
 const certs=makeRemoteCertificates(),gateway=await remoteFixture(certs),root=await mkdtemp('/tmp/jev-remote-cli-'),runtime=join(root,'run'),config=join(root,'profile.json');let gatewayClosed=false;
 try{
  const token=gateway.token('a');
  for(const [name,data] of Object.entries({'ca.pem':certs.ca,'agent.pem':certs.a.cert,'agent.key':certs.a.key,token,'receipt.pem':gateway.keys.publicKey.export({format:'pem',type:'spki'})}))await writeFile(join(root,name),data,{mode:0o600});
  await writeFile(config,JSON.stringify({mode:'remote',endpoint:gateway.url,caFile:'ca.pem',certFile:'agent.pem',keyFile:'agent.key',tokenFile:'token',receiptPublicKeyFile:'receipt.pem',issuer:'gateway',audience:'executor',identity:gateway.identities.a,enforcementMode:'test_mock'}),{mode:0o600});
  const shared=await run(['service','start','--runtime',runtime,'--config',config,'--share-a-with-b','--json']);assert.equal(JSON.parse(shared.stdout).error.code,'REMOTE_SHARING_NOT_SUPPORTED');
  const started=await run(['service','start','--runtime',runtime,'--config',config,'--json']);assert.equal(started.code,0,started.stdout+started.stderr);const health=JSON.parse(started.stdout);assert.equal(health.remoteReachable,true);assert.equal(health.transport,'remote');assert.equal(health.provider,'mock');assert.equal(health.model,'mock-v1');assert.deepEqual(health.identity,gateway.identities.a);await assert.rejects(access(join(runtime,'client-b.json')));
  const demo=await run(['demo','--runtime',runtime,'--json']);assert.equal(demo.code,0,demo.stdout+demo.stderr);assert.equal(JSON.parse(demo.stdout).status,'SUCCEEDED');
  const wrong=await run(['service','start','--runtime',runtime,'--json']);assert.equal(JSON.parse(wrong.stdout).error.code,'SERVICE_PROFILE_MISMATCH');
  await gateway.close();gatewayClosed=true;
  const offline=await run(['doctor','--runtime',runtime,'--json']);assert.equal(offline.code,0);assert.equal(JSON.parse(offline.stdout).remoteReachable,false);assert.equal(JSON.parse(offline.stdout).model,'unknown');
  assert.ok(!(await readFile(join(runtime,'service.log'),'utf8')).includes(token));
  const stopped=await run(['service','stop','--runtime',runtime,'--json']);assert.equal(stopped.code,0,stopped.stdout+stopped.stderr);
  const offlineStart=await run(['service','start','--runtime',runtime,'--config',config,'--json']);assert.equal(offlineStart.code,0,offlineStart.stdout+offlineStart.stderr);assert.equal(JSON.parse(offlineStart.stdout).remoteReachable,false);assert.equal(JSON.parse(offlineStart.stdout).ready,true);
  assert.equal((await run(['service','stop','--runtime',runtime,'--json'])).code,0);
 }finally{await run(['service','stop','--runtime',runtime,'--json']);if(!gatewayClosed)await gateway.close();certs.close();await rm(root,{recursive:true,force:true});}
});
