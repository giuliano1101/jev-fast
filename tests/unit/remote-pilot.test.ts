import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validatePilotApproval,createAttemptObserver,validateUnstartedContinuation,runPilot} from '../../bench/remote/pilot.js';

function approval(){const now=Date.now();return {authorization:{approval_id:'pilot-test',expires_at:now+3600000,max_requests:30,max_cost_usd:.1,synthetic_only:true},approval:{approval_id:'pilot-test',expires_at:now+3600000,max_requests:30,max_cost_usd:.1,reservation_usd:.003},authorized_at:new Date(now).toISOString(),scope:'local Mac loopback TLS synthetic pilot only; no physical second device or production app'};}
test('pilot accepts explicit bounded approval but rejects changed ceilings, stale authorization and mismatched durable budget',()=>{
 const value=approval();assert.deepEqual(validatePilotApproval(value),value);
 for(const invalid of [{...value,authorization:{...value.authorization,max_requests:31}},{...value,approval:{...value.approval,reservation_usd:.0014}},{...value,authorized_at:new Date(Date.now()-25*3600000).toISOString()},{...value,approval:{...value.approval,approval_id:'other'}},{...value,authorization:{...value.authorization,synthetic_only:false}}])assert.throws(()=>validatePilotApproval(invalid));
});
function continuationFixture(){
 const approved=approval(),result={session_id:'session',goal_id:'warmup',idempotency_key:'idem-warmup',request_hash:'test-hash',status:'FALLBACK',steps:0,elapsed_ms:1932,reason:'PROVIDER_DEADLINE',evidence:[],action_ids:[]};
 const tasks=['form','cancel','correction','correction','form','cancel','cancel','correction','form'];
 const frontends=['cli','mcp','cli','mcp','mcp','cli','mcp','cli','cli'];
 return {approval:approved,mode:'mock',marker:{started_at:new Date().toISOString(),approval_id:approved.approval.approval_id,approval_sha256:createHash('sha256').update(JSON.stringify(approved)).digest('hex'),mode:'mock',output:'/private/old-output'},summary:{mode:'mock',approval_id:approved.approval.approval_id,formal_planned:9,formal_attempted:0,formal_succeeded:0,formal_success_denominator:9,warmup_status:'FALLBACK',budget_before:{approval:approved.approval,requests:0,reserved_usd:0},budget_after:{approval:approved.approval,requests:1,reserved_usd:.003}},rows:tasks.map((task,index)=>({id:'trial-'+String(index+1).padStart(2,'0'),task,frontend:frontends[index],max_steps:task==='form'?4:task==='correction'?3:1,seed:101+index,status:'NOT_RUN'})),warmup:{status:'FALLBACK',result,actions:[]},ledger:{version:2,sessions:{session:{owner:'a',fixture_id:'standard',allowed_origin:'http://127.0.0.1:1234',epoch:1,quarantined:false,closed:true}},goals:{'session:warmup':result},actions:{}},budget:{approval:approved.approval,requests:2,reserved_usd:.006}};
}
test('continuation accepts only nine untouched formal trials and a closed zero-action failed warmup with the original budget',()=>{
 const fixture=continuationFixture();assert.equal(validateUnstartedContinuation(fixture),'old-output/summary.json');
 for(const mutate of [(v:ReturnType<typeof continuationFixture>)=>{v.rows[0]!.status='SUCCEEDED';},(v:ReturnType<typeof continuationFixture>)=>{v.summary.formal_attempted=1;},(v:ReturnType<typeof continuationFixture>)=>{v.ledger.goals['session:warmup'].status='UNKNOWN';},(v:ReturnType<typeof continuationFixture>)=>{v.marker.approval_sha256='0'.repeat(64);},(v:ReturnType<typeof continuationFixture>)=>{v.budget.requests=0;v.budget.reserved_usd=0;},(v:ReturnType<typeof continuationFixture>)=>{v.ledger.sessions.session.quarantined=true;},(v:ReturnType<typeof continuationFixture>)=>{v.ledger.sessions.session.closed=false;},(v:ReturnType<typeof continuationFixture>)=>{v.warmup.result.steps=1;}]){const value=continuationFixture();mutate(value);assert.throws(()=>validateUnstartedContinuation(value));}
});
test('a second continuation is refused without deleting original or continuation markers or the budget database',async()=>{
 const state=mkdtempSync(join(tmpdir(),'jev-pilot-continuation-guard-'));
 try{
  writeFileSync(join(state,'approval.json'),JSON.stringify(approval()),{mode:0o600});
  for(const name of ['pilot-started.json','continuation-started.json','gateway.sqlite'])writeFileSync(join(state,name),'KEEP_'+name,{mode:0o600});
  await assert.rejects(runPilot(['--approval',join(state,'approval.json'),'--state',state,'--out',join(state,'second-output'),'--mock','--continue-unstarted']),/CONTINUATION_NOT_ALLOWED/);
  for(const name of ['pilot-started.json','continuation-started.json','gateway.sqlite'])assert.equal(readFileSync(join(state,name),'utf8'),'KEEP_'+name);
  assert.equal(existsSync(join(state,'second-output')),false);assert.equal(existsSync(join(state,'pilot.lock')),false);
 }finally{rmSync(state,{recursive:true,force:true});}
});
test('metadata observer returns original response before body completes and retains only safe usage/confidence',async()=>{
 let release!:(bytes:Uint8Array)=>void;
 const response=new Response(new ReadableStream<Uint8Array>({start(controller){release=bytes=>{controller.enqueue(bytes);controller.close();};}}));
 const observer=createAttemptObserver(async()=>response,()=>{},()=> 'test-trial',()=>assert.fail('unexpected fatal'));
 assert.equal(await observer.transport('https://example.invalid'),response);
 release(new TextEncoder().encode(JSON.stringify({secret:'NEVER_EXPORT',usage:{input_tokens:25,output_tokens:0},answers:{action:{confidence:.2}},other:'NO_RAW_BODY'})));
 await observer.settle();assert.deepEqual(observer.attempts[0]?.usage,{input_tokens:25,output_tokens:0});assert.equal(observer.attempts[0]?.confidence,.2);
 assert.ok(!JSON.stringify(observer.attempts).includes('NEVER_EXPORT'));assert.ok(!JSON.stringify(observer.attempts).includes('NO_RAW_BODY'));
});
test('metadata observer bounds response bytes and surfaces actual authorization rejection',async()=>{
 const fatal:string[]=[];const observer=createAttemptObserver(async()=>new Response('x'.repeat(65537),{status:403}),()=>{},()=> 'test-trial',code=>fatal.push(code));
 const response=await observer.transport('https://example.invalid');assert.equal(response.status,403);await observer.settle();
 assert.deepEqual(fatal,['UPSTREAM_HTTP_403']);assert.equal(observer.attempts[0]?.observation,'UNAVAILABLE_OR_LIMITED');assert.equal(observer.attempts[0]?.usage,undefined);
});
test('metadata persistence failure is handled and stops the pilot without an unhandled rejection',async()=>{
 let writes=0;const fatal:string[]=[];
 const observer=createAttemptObserver(async()=>new Response('{}'),()=>{if(++writes===3)throw new Error('disk failure');},()=> 'test-trial',code=>fatal.push(code));
 await observer.transport('https://example.invalid');await observer.settle();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(fatal,['OBSERVATION_PERSISTENCE_FAILED']);
});
