import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {createServer as createHttpsServer,request as httpsRequest} from 'node:https';
import {once} from 'node:events';
import {certificateSha256} from '../../src/remote/credentials.js';
import {MockProvider} from '../../src/providers/mock.js';
import {RemoteDecisionProvider} from '../../src/remote/client.js';
import {verifyDecisionResponse} from '../../src/remote/protocol.js';
import {makeRemoteCertificates,remoteFixture,remoteRequest,type RemoteCertificates} from '../helpers/remote-fixture.js';
let certs:RemoteCertificates;
before(()=>{certs=makeRemoteCertificates();});after(()=>certs.close());
const context=(req=remoteRequest())=>({signal:new AbortController().signal,deadline:Date.now()+2000,remoteRequest:req});
test('two mTLS principals receive separately bound signed decisions and exact duplicate bytes',async()=>{
 const f=await remoteFixture(certs);try{
  const req=remoteRequest(),start=performance.now();const a=await f.client('a').decide(req.input,context(req));
  assert.equal(verifyDecisionResponse(a,{request:req,publicKey:f.keys.publicKey,issuer:'gateway',audience:'executor',identity:f.identities.a,enforcementMode:'test_mock',requestStartedMonotonicMs:start,snapshotDeadlineMonotonicMs:start+2000,goalDeadlineMonotonicMs:start+2000,nowMonotonicMs:performance.now(),nowWallMs:Date.now()}).route,'mock');
  const duplicate=await f.raw(req),again=await f.raw(req);assert.equal(duplicate.text,again.text);assert.deepEqual(JSON.parse(duplicate.text),a);
  const b=await f.client('b').decide(req.input,context(req));assert.notEqual(a.receipt,b.receipt);assert.equal(f.store.stats().decisions,2);
  assert.equal((await f.raw({...req,nonce:'f'.repeat(32)})).body.code,'IDEMPOTENCY_CONFLICT');
 }finally{await f.close();}
});
test('certificate-bound tokens reject device copying, forged identity, expired and revoked credentials',async()=>{
 const f=await remoteFixture(certs);try{
  assert.equal((await f.raw(remoteRequest(),{id:'b',token:f.token('a')})).body.code,'UNAUTHENTICATED');
  assert.equal((await f.raw(remoteRequest(),{token:'not-a-token'})).body.code,'UNAUTHENTICATED');
  assert.equal((await f.raw(remoteRequest(),{token:f.token('a',{...f.identities.a,device_id:'unknown'})})).body.code,'FORBIDDEN');
  const token=f.token('a',f.identities.a,Date.now()+30);await delay(40);assert.equal((await f.raw(remoteRequest(),{token})).body.code,'UNAUTHENTICATED');
  f.store.revoke(f.identities.a);assert.equal((await f.raw()).body.code,'FORBIDDEN');assert.equal(f.store.stats().decisions,0);
 }finally{await f.close();}
});
test('gateway strictly rejects Origin, route, unknown fields and large bodies before dispatch',async()=>{
 const f=await remoteFixture(certs);try{
  for(const result of [await f.raw(remoteRequest(),{headers:{origin:'https://example.com'}}),await f.raw(remoteRequest(),{path:'/v1/execute'}),await f.raw({...remoteRequest(),device_id:'forged'}),await f.raw(' '.repeat(24001))])assert.notEqual(result.status,200);
  assert.equal(f.store.stats().decisions,0);const h=await f.raw('',{method:'GET',path:'/health'});assert.deepEqual(h.body,{mode:'mock',model:'mock-v1',protocol:'decision-v1',policy:'p0-v1',identity:f.identities.a});
 }finally{await f.close();}
});
test('client rejects mismatched input, cancellation, bad TLS and offline without retry',async()=>{
 const f=await remoteFixture(certs);const req=remoteRequest();try{
  await assert.rejects(f.client().decide({...req.input,summary:'changed'},context(req)),/REMOTE_INPUT_MISMATCH/);
  const aborted=new AbortController();aborted.abort();await assert.rejects(f.client().decide(req.input,{...context(req),signal:aborted.signal}),/CANCELLED/);
  const wrong=new RemoteDecisionProvider({url:f.url,...certs.a,ca:certs.a.cert,token:f.token('a')});await assert.rejects(wrong.decide(req.input,context(req)),/PROVIDER_UNAVAILABLE/);
  assert.equal(f.store.stats().decisions,0);
 }finally{await f.close();}
 await assert.rejects(f.client().decide(req.input,context(req)),/PROVIDER_UNAVAILABLE/);
});
test('pending duplicate and aborted provider timeout become unknown and never retrigger',async()=>{
 let calls=0;const f=await remoteFixture(certs,{mockProvider:{decide:async()=>{calls++;return new Promise(()=>{});}}});try{
  const req={...remoteRequest(),deadline_ms:120};const first=f.raw(req);await delay(30);
  assert.equal((await f.raw(req)).body.code,'DECISION_UNKNOWN');assert.equal((await first).body.code,'DECISION_UNKNOWN');
  assert.equal((await f.raw(req)).body.code,'DECISION_UNKNOWN');assert.equal(calls,1);
 }finally{await f.close();}
});
test('revocation while provider is in flight prevents issuing a receipt',async()=>{
 const mock=new MockProvider();let unblock!:()=>void;const blocked=new Promise<void>(resolve=>{unblock=resolve;});let dispatched!:()=>void;const began=new Promise<void>(resolve=>{dispatched=resolve;});
 const f=await remoteFixture(certs,{mockProvider:{decide:async(input,ctx)=>{dispatched();await blocked;return mock.decide(input,ctx);}}});try{const first=f.raw();await began;f.store.revoke(f.identities.a);unblock();assert.equal((await first).body.code,'FORBIDDEN');}finally{unblock();await f.close();}
});
test('low confidence is durably rejected and cannot become a cached authorization',async()=>{
 let calls=0;const mock=new MockProvider();const f=await remoteFixture(certs,{mockProvider:{decide:async(input,ctx)=>{calls++;return {...await mock.decide(input,ctx),confidence:.4};}}});try{assert.equal((await f.raw()).body.code,'INVALID_DECISION');assert.equal((await f.raw()).body.code,'INVALID_DECISION');assert.equal(calls,1);}finally{await f.close();}
});
test('live gateway reserves every provider attempt and shares persisted approval cap',async()=>{
 let calls=0;const approval={approval_id:'approved',expires_at:Date.now()+60000,max_requests:2,max_cost_usd:.01,reservation_usd:.0014};
 const f=await remoteFixture(certs,{live:{key:'synthetic-test-key',approval,authorization:{approval_id:approval.approval_id,expires_at:approval.expires_at,max_requests:approval.max_requests,max_cost_usd:approval.max_cost_usd,synthetic_only:true},transport:async()=>{calls++;if(calls===1)return new Response('',{status:429,headers:{'retry-after':'0'}});return new Response(JSON.stringify({model:'jev-1.14.0',answers:{action:{type:'choice',choice:'c',confidence:.99}},usage:{input_tokens:10,output_tokens:0}}));}}});try{
  const first=await f.raw();assert.equal(first.status,200);assert.equal(first.body.route,'jev');assert.equal(calls,2);assert.equal(f.store.budget('approved').requests,2);
  assert.equal((await f.raw(remoteRequest('other'),{id:'b'})).body.code,'BUDGET_EXHAUSTED');assert.equal(calls,2);
 }finally{await f.close();}
});

test('per-principal and global admission stay bounded with four pending decision calls',async()=>{
 const mock=new MockProvider();let calls=0;const releases:(()=>void)[]=[];
 const f=await remoteFixture(certs,{mockProvider:{decide:async(input,ctx)=>{calls++;await new Promise<void>(r=>releases.push(r));return mock.decide(input,ctx);}}});
 try{
  const pending:Promise<Awaited<ReturnType<typeof f.raw>>>[]=[];
  for(let i=0;i<4;i++){
   const identity={...f.identities.a,agent_id:'agent-'+i};
   f.store.enroll({...identity,certificate_sha256:certificateSha256(certs.a.cert),expires_at:Date.now()+60000});
   pending.push(f.raw(remoteRequest(String(i)),{token:f.token('a',identity)}));
   for(let n=0;calls<=i&&n<100;n++)await delay(5);
  }
  assert.equal(calls,4);assert.equal((await f.raw(remoteRequest('fifth'),{id:'b'})).body.code,'RATE_LIMITED');
  releases.forEach(release=>release());assert.ok((await Promise.all(pending)).every(r=>r.status===200));
  const first=f.raw(remoteRequest('held'));for(let n=0;calls<5&&n<100;n++)await delay(5);
  assert.equal((await f.raw(remoteRequest('samePrincipal'))).body.code,'RATE_LIMITED');assert.equal(calls,5);releases.at(-1)!();assert.equal((await first).status,200);
 }finally{releases.forEach(release=>release());await f.close();}
});

test('bounded rate limiter includes authenticated health traffic',async()=>{
 const f=await remoteFixture(certs);try{for(let n=0;n<60;n++)assert.equal((await f.raw('',{method:'GET',path:'/health'})).status,200);assert.equal((await f.raw('',{method:'GET',path:'/health'})).body.code,'RATE_LIMITED');}finally{await f.close();}
});

test('missing or untrusted client certificate fails the TLS handshake',async()=>{
 const f=await remoteFixture(certs);try{
  for(const tls of [{},{cert:certs.server.cert,key:certs.server.key}])await assert.rejects(new Promise<void>((resolve,reject)=>{
   const req=httpsRequest(f.url+'/health',{ca:certs.ca,...tls,agent:false,headers:{authorization:'Bearer '+f.token('a')}},res=>{res.resume();resolve();});req.on('error',reject);req.end();
  }));assert.equal(f.store.stats().decisions,0);
 }finally{await f.close();}
});

test('client never follows redirects and caps response bytes and absolute waiting time',async()=>{
 let requests=0;let mode:'redirect'|'large'|'stall'='redirect';
 const server=createHttpsServer({...certs.server,ca:certs.ca,requestCert:true,rejectUnauthorized:true},(_req,res)=>{requests++;if(mode==='redirect'){res.writeHead(307,{location:'https://example.com'});res.end('{}');}else if(mode==='large'){res.writeHead(200);res.end('x'.repeat(64001));}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 try{
  const client=new RemoteDecisionProvider({url:`https://127.0.0.1:${address.port}`,...certs.a,ca:certs.ca,token:'synthetic-token'}),req=remoteRequest();
  await assert.rejects(client.decide(req.input,context(req)),/PROVIDER_UNAVAILABLE/);assert.equal(requests,1);
  mode='large';await assert.rejects(client.decide(req.input,context(req)),/RESPONSE_LIMIT/);assert.equal(requests,2);
  mode='stall';const start=performance.now();await assert.rejects(client.decide(req.input,{...context(req),deadline:Date.now()+80}),/PROVIDER_DEADLINE/);assert.ok(performance.now()-start<600);assert.equal(requests,3);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('client health uses authenticated TLS and reports only bounded capability metadata',async()=>{
 const f=await remoteFixture(certs);try{assert.deepEqual(await f.client().health(),{mode:'mock',model:'mock-v1',protocol:'decision-v1',policy:'p0-v1',identity:f.identities.a});f.store.revoke(f.identities.a);await assert.rejects(f.client().health(),/FORBIDDEN/);assert.equal(f.store.stats().decisions,0);}finally{await f.close();}
});

test('revocation during request upload denies cached receipt delivery',async()=>{
 const f=await remoteFixture(certs);try{
  assert.equal((await f.raw()).status,200);const body=JSON.stringify(remoteRequest());
  const result=new Promise<Record<string,unknown>>((resolve,reject)=>{
   const req=httpsRequest(f.url+'/v1/decisions',{...certs.a,ca:certs.ca,agent:false,method:'POST',headers:{authorization:'Bearer '+f.token('a'),'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{const chunks:Buffer[]=[];res.on('data',(c:Buffer)=>chunks.push(c));res.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks).toString())));});req.on('error',reject);req.write(body.slice(0,20));setTimeout(()=>{f.store.revoke(f.identities.a);req.end(body.slice(20));},30);
  });assert.equal((await result).code,'FORBIDDEN');
 }finally{await f.close();}
});

test('synchronous durable-store delay cannot permit dispatch after the snapshot deadline',async()=>{
 let calls=0;const mock=new MockProvider();const f=await remoteFixture(certs,{mockProvider:{decide:async(input,ctx)=>{calls++;return mock.decide(input,ctx);}}});
 try{
  const begin=f.store.begin.bind(f.store);f.store.begin=(...args)=>{const result=begin(...args);const until=performance.now()+80;while(performance.now()<until){/* Simulate a synchronous durable storage stall. */}return result;};
  const result=await f.raw({...remoteRequest(),deadline_ms:40});assert.notEqual(result.status,200);assert.equal(calls,0);
 }finally{await f.close();}
});
test('revocation during store begin prevents cached receipt delivery',async t=>{const f=await remoteFixture(certs);try{const req=remoteRequest();assert.equal((await f.raw(req)).status,200);const begin=f.store.begin.bind(f.store);t.mock.method(f.store,'begin',(...args:Parameters<typeof begin>)=>{const result=begin(...args);f.store.revoke(f.identities.a);return result;});assert.equal((await f.raw(req)).body.code,'FORBIDDEN');}finally{await f.close();}});
test('revocation during reservation prevents hosted dispatch',async t=>{let calls=0;const approval={approval_id:'approved',expires_at:Date.now()+60000,max_requests:2,max_cost_usd:.01,reservation_usd:.0014};const f=await remoteFixture(certs,{live:{key:'synthetic-test-key',approval,authorization:{approval_id:approval.approval_id,expires_at:approval.expires_at,max_requests:approval.max_requests,max_cost_usd:approval.max_cost_usd,synthetic_only:true},transport:async()=>{calls++;return new Response(JSON.stringify({model:'jev-1.14.0',answers:{action:{type:'choice',choice:'c',confidence:.99}}}));}}});try{const reserve=f.store.reserve.bind(f.store);t.mock.method(f.store,'reserve',(...args:Parameters<typeof reserve>)=>{const result=reserve(...args);f.store.revoke(f.identities.a);return result;});await f.raw(remoteRequest());assert.equal(calls,0);}finally{await f.close();}});
test('revocation during receipt persistence prevents delivery',async t=>{const f=await remoteFixture(certs);try{const complete=f.store.complete.bind(f.store);t.mock.method(f.store,'complete',(...args:Parameters<typeof complete>)=>{complete(...args);f.store.revoke(f.identities.a);});assert.equal((await f.raw(remoteRequest())).body.code,'FORBIDDEN');}finally{await f.close();}});
