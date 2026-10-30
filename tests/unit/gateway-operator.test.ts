import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {generateKeyPairSync} from 'node:crypto';
import {join,resolve} from 'node:path';
import {makeRemoteCertificates} from '../helpers/remote-fixture.js';
import {certificateSha256,verifyAgentToken} from '../../src/remote/credentials.js';
import {startGatewayFromConfig} from '../../src/remote/main.js';
import {RemoteDecisionProvider} from '../../src/remote/client.js';
import {GatewayStore} from '../../src/remote/store.js';
const entry=resolve('dist/src/remote/main.js');
async function run(args:string[]){return new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{const child=spawn(process.execPath,[entry,...args],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});}
test('operator enrollment, exclusive private token mint, and revocation use durable store',{timeout:30000},async()=>{
 const root=await mkdtemp('/tmp/jev-operator-'),certs=makeRemoteCertificates(),keys=generateKeyPairSync('ed25519');
 const privateKey=keys.privateKey.export({format:'pem',type:'pkcs8'}),publicKey=keys.publicKey.export({format:'pem',type:'spki'}),identity={owner_id:'owner',device_id:'device',agent_id:'agent'};
 const config=join(root,'gateway.json'),spec=join(root,'enroll.json'),out=join(root,'token');let service:Awaited<ReturnType<typeof startGatewayFromConfig>>|undefined;
 try{
  for(const [name,bytes] of Object.entries({'server.pem':certs.server.cert,'server.key':certs.server.key,'ca.pem':certs.ca,'agent.pem':certs.a.cert,'sign.key':privateKey,'sign.pub':publicKey}))await writeFile(join(root,name),bytes,{mode:0o600});
  await writeFile(config,JSON.stringify({certFile:'server.pem',keyFile:'server.key',caFile:'ca.pem',receiptPrivateKeyFile:'sign.key',tokenPublicKeyFile:'sign.pub',tokenPrivateKeyFile:'sign.key',storageDir:'state',port:0,issuer:'gateway',audience:'executor'}),{mode:0o600});
  await writeFile(spec,JSON.stringify({identity,certFile:'agent.pem',expiresAt:Date.now()+60000}),{mode:0o600});
  const help=await run(['--help']);assert.equal(help.code,0,help.stderr);assert.match(help.stdout,/enroll/);
  service=await startGatewayFromConfig(config);const address=service.server.address();assert.ok(address&&typeof address!=='string');assert.equal(address.address,'127.0.0.1');
  const enroll=await run(['enroll','--config',config,'--spec',spec]);assert.equal(enroll.code,0,enroll.stdout+enroll.stderr);
  const mint=await run(['mint','--config',config,'--spec',spec,'--out',out]);assert.equal(mint.code,0,mint.stdout+mint.stderr);
  const token=(await readFile(out,'utf8')).trim();assert.equal((await stat(out)).mode&0o777,0o600);assert.ok(!mint.stdout.includes(token));assert.deepEqual(verifyAgentToken(token,{publicKey:keys.publicKey,issuer:'gateway',audience:'executor',certificateSha256:certificateSha256(certs.a.cert)}),identity);
  const client=new RemoteDecisionProvider({url:`https://127.0.0.1:${address.port}`,ca:certs.ca,...certs.a,token});assert.equal((await client.health()).mode,'mock');
  const tooLong=join(root,'long.json');await writeFile(tooLong,JSON.stringify({identity,certFile:'agent.pem',expiresAt:Date.now()+3700000}),{mode:0o600});assert.equal((await run(['mint','--config',config,'--spec',tooLong,'--out',join(root,'long-token')])).code,1);
  assert.equal((await run(['mint','--config',config,'--spec',spec,'--out',out])).code,1);
  const revokeSpec=join(root,'revoke.json');await writeFile(revokeSpec,JSON.stringify({identity}),{mode:0o600});
  const revoke=await run(['revoke','--config',config,'--spec',revokeSpec]);assert.equal(revoke.code,0,revoke.stdout+revoke.stderr);
  await assert.rejects(client.health(),/FORBIDDEN/);
  const store=new GatewayStore(join(root,'state'));try{assert.throws(()=>store.authorize(identity,certificateSha256(certs.a.cert)),/FORBIDDEN/);}finally{store.close();}
  assert.equal((await run(['mint','--config',config,'--spec',spec,'--out',join(root,'second')])).code,1);
 }finally{await service?.close();certs.close();await rm(root,{recursive:true,force:true});}
});

test('operator import is inert and serve rejects implicit live mode or inappropriate flags',async()=>{
 const root=await mkdtemp('/tmp/jev-operator-'),config=join(root,'invalid.json');
 try{
  await writeFile(config,JSON.stringify({mode:'live',certFile:'cert',keyFile:'key',caFile:'ca',receiptPrivateKeyFile:'receipt',tokenPublicKeyFile:'token',storageDir:'state',issuer:'gateway',audience:'executor'}),{mode:0o600});
  const live=await run(['serve','--config',config]);assert.equal(live.code,1);assert.equal(live.stderr.trim(),'INVALID_GATEWAY_CONFIGURATION');
  const args=await run(['serve','--config',config,'--out','ignored']);assert.equal(args.code,1);assert.equal(args.stderr.trim(),'INVALID_ARGUMENTS');
 }finally{await rm(root,{recursive:true,force:true});}
});
