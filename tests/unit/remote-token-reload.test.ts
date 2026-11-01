import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,unlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {RemoteDecisionProvider,type RemoteDecisionOptions} from '../../src/remote/client.js';
import {loadServiceProfile} from '../../src/service/config.js';
import {canonicalDigest,verifyDecisionResponse} from '../../src/remote/protocol.js';
import {makeRemoteCertificates,remoteFixture,remoteRequest,type RemoteCertificates} from '../helpers/remote-fixture.js';
let certs:RemoteCertificates;
before(()=>{certs=makeRemoteCertificates();});after(()=>certs.close());
async function setup(tokenReload?:boolean){
 const f=await remoteFixture(certs),dir=await mkdtemp(join(tmpdir(),'jev-reload-'));
 const config={mode:'remote',endpoint:f.url,caFile:'ca.pem',certFile:'cert.pem',keyFile:'key.pem',tokenFile:'token',receiptPublicKeyFile:'receipt.pem',issuer:'gateway',audience:'executor',identity:f.identities.a,enforcementMode:'test_mock',...(tokenReload===undefined?{}:{tokenReload})};
 const token=f.token('a');
 const material=[certs.ca,certs.a.cert,certs.a.key,Buffer.from(token),Buffer.from(f.keys.publicKey.export({type:'spki',format:'pem'}))];
 for(const [index,name] of ['ca.pem','cert.pem','key.pem','token','receipt.pem'].entries())await writeFile(join(dir,name),material[index]!,{mode:0o600});
 const path=join(dir,'profile.json');
 await writeFile(path,JSON.stringify(config),{mode:0o600});
 return {f,dir,path,config,material,token,replace:(value:string)=>writeFile(join(dir,'token'),value,{mode:0o600}),close:async()=>{await f.close();await rm(dir,{recursive:true,force:true});}};
}
const context=(request=remoteRequest())=>({signal:new AbortController().signal,deadline:Date.now()+2000,remoteRequest:request});
test('operator profile reloads renewed certificate-bound tokens for health and signed decisions without restart',async()=>{
 const s=await setup(true);try{
  const old=s.f.token('a',s.f.identities.a,Date.now()+500);await s.replace(old);
  const profile=await loadServiceProfile(s.path);assert.equal((await profile.health()).remoteReachable,true);
  const staticClient=s.f.client('a',old);await delay(520);await assert.rejects(staticClient.health(),/UNAUTHENTICATED/);
  assert.equal((await profile.health()).remoteReachable,false);
  await s.replace(s.f.token('a',s.f.identities.a,Date.now()+120000)+'\n');
  assert.equal((await profile.health()).remoteReachable,true);
  const request=remoteRequest('renewed'),start=performance.now();
  const response=await profile.provider.decide(request.input,context(request));
  assert.equal(verifyDecisionResponse(response,{...profile.remotePolicy!,request,requestStartedMonotonicMs:start,snapshotDeadlineMonotonicMs:start+2000,goalDeadlineMonotonicMs:start+2000,nowMonotonicMs:performance.now(),nowWallMs:Date.now()}).route,'mock');
 }finally{await s.close();}
});
test('reload rejects malformed or unreadable replacements without sending the stale token',async()=>{
 const s=await setup(true);try{
  const profile=await loadServiceProfile(s.path);assert.equal((await profile.health()).remoteReachable,true);
  let exchanges=0;s.f.server.on('request',()=>{exchanges++;});
  for(const value of ['', '   ',s.token+'\n'+s.token,'a'.repeat(8193),'é',s.token+'\n\n']){
   await s.replace(value);assert.equal((await profile.health()).remoteReachable,false);
   const request=remoteRequest('invalid');await assert.rejects(profile.provider.decide(request.input,context(request)));assert.equal(exchanges,0);
  }
  await s.replace(s.token);await chmod(join(s.dir,'token'),0o644);assert.equal((await profile.health()).remoteReachable,false);
  await unlink(join(s.dir,'token'));assert.equal((await profile.health()).remoteReachable,false);assert.equal(exchanges,0);
  await s.replace(s.token);assert.equal((await profile.health()).remoteReachable,true);assert.equal(exchanges,1);
 }finally{await s.close();}
});
test('reload fingerprint tolerates token renewal but binds paths, identity, and fixed material',async()=>{
 const s=await setup(true);try{
  const initial=(await loadServiceProfile(s.path)).fingerprint;
  await s.replace(s.f.token('a',s.f.identities.a,Date.now()+120000));assert.equal((await loadServiceProfile(s.path)).fingerprint,initial);
  const otherProfile=join(s.dir,'other-profile.json');await writeFile(otherProfile,JSON.stringify(s.config),{mode:0o600});assert.notEqual((await loadServiceProfile(otherProfile)).fingerprint,initial);
  for(const name of ['ca.pem','cert.pem','key.pem','receipt.pem']){
   const index=['ca.pem','cert.pem','key.pem','receipt.pem'].indexOf(name),bytes=s.material[[0,1,2,4][index]!]!;
   await writeFile(join(s.dir,name),Buffer.concat([bytes,Buffer.from('\n')]));assert.notEqual((await loadServiceProfile(s.path)).fingerprint,initial);await writeFile(join(s.dir,name),bytes);
  }
  await writeFile(join(s.dir,'other-token'),s.token,{mode:0o600});
  for(const change of [{tokenFile:'other-token'},{identity:{...s.config.identity,agent_id:'different'}},{audience:'other'}]){
   await writeFile(s.path,JSON.stringify({...s.config,...change}));assert.notEqual((await loadServiceProfile(s.path)).fingerprint,initial);
  }
 }finally{await s.close();}
});
test('default static profile keeps old token bytes and fingerprint semantics',async()=>{
 const s=await setup();try{
  const profile=await loadServiceProfile(s.path);
  assert.equal(profile.fingerprint,canonicalDigest({config:s.config,shared:false,material:s.material.map(bytes=>createHash('sha256').update(bytes).digest('hex'))}));
  await s.replace('invalid-token');assert.equal((await profile.health()).remoteReachable,true);assert.notEqual((await loadServiceProfile(s.path)).fingerprint,profile.fingerprint);
 }finally{await s.close();}
});
function loadedClient(url:string,token:string,tokenLoader:NonNullable<RemoteDecisionOptions['tokenLoader']>){
 return new RemoteDecisionProvider({url,...certs.a,ca:certs.ca,token,tokenLoader});
}
test('hanging token reload is bounded by original health and decision deadlines and never dispatches after timeout',async()=>{
 const f=await remoteFixture(certs);try{
  let requests=0;f.server.on('request',()=>{requests++;});let release!:(token:string)=>void;
  const client=loadedClient(f.url,f.token('a'),()=>new Promise(resolve=>{release=resolve;}));
  const start=performance.now();await assert.rejects(client.health({deadline:Date.now()+50}),/PROVIDER_DEADLINE/);assert.ok(performance.now()-start<500);
  release(f.token('a'));await delay(40);assert.equal(requests,0);
  const request=remoteRequest('hanging');await assert.rejects(client.decide(request.input,{...context(request),deadline:Date.now()+50}),/PROVIDER_DEADLINE/);
  release(f.token('a'));await delay(40);assert.equal(requests,0);
 }finally{await f.close();}
});
test('decision cancellation and exhausted token reload lifetime prevent transport',async()=>{
 const f=await remoteFixture(certs);try{
  let requests=0;f.server.on('request',()=>{requests++;});const request=remoteRequest('deadline');
  const slow=loadedClient(f.url,f.token('a'),async()=>{const until=performance.now()+80;while(performance.now()<until){/* Synchronous loader stall. */}return f.token('a');});
  await assert.rejects(slow.decide(request.input,{...context(request),deadline:Date.now()+40}),/PROVIDER_DEADLINE/);
  const abort=new AbortController(),pending=loadedClient(f.url,f.token('a'),()=>new Promise(()=>{})).decide(request.input,{...context(request),signal:abort.signal});
  abort.abort();await assert.rejects(pending,/CANCELLED/);await delay(30);assert.equal(requests,0);
 }finally{await f.close();}
});
