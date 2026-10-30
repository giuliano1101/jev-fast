import test from 'node:test';
import assert from 'node:assert/strict';
import {zstdDecompressSync} from 'node:zlib';
import {MOBILE_TASKS,MOBILE_ACTION_LABELS} from '../../bench/mobile/catalog.js';
import {decideMobile} from '../../bench/mobile/decision.js';

interface Accounting {usage:{input_tokens:number;output_tokens:number}|null;request_count:number;known_cost_usd:number;unknown_usage_requests:number}
interface Result extends Accounting {actionId:string;confidence:number;elapsed_ms:number}
interface Options {key:string;authorization:{approval_id:string;expires_at:number;public_controls_only:true};reserve:()=>unknown;transport:(url:string,options?:RequestInit)=>Promise<Response>;signal?:AbortSignal}
async function decide(input:unknown,options:Options):Promise<Result>{
 return decideMobile(input,options);
}
const input=()=>({task_id:'M3',trial_id:'test-private-local-id',predicates:{page_home:true,page_search_empty:false,visited_font:'unknown'},candidates:['open_search','open_bluetooth']});
const body=(choice='open_search',confidence=.95,usage:unknown={input_tokens:100,output_tokens:1})=>({model:'jev-1.14.0',answers:{action:{type:'choice',choice,confidence}},usage});
const options=(transport:Options['transport']=async()=>new Response(JSON.stringify(body()))):Options=>({key:'test-only-injected-key',authorization:{approval_id:'offline-test',expires_at:Date.now()+30000,public_controls_only:true},reserve:()=>{},transport});
function accounting(error:unknown):Accounting {assert.ok(error instanceof Error);assert.doesNotMatch(error.message,/secret|private text/);return (error as Error&{accounting:Accounting}).accounting;}
function decoded(init:RequestInit|undefined){assert.ok(init);return JSON.parse(typeof init.body==='string'?init.body:zstdDecompressSync(init.body as Uint8Array).toString());}

test('mobile provider sends only fixed public goal, predicate states and catalog choice labels after reservation',async()=>{
 const order:string[]=[];const opts=options(async(url,init)=>{
  order.push('fetch');assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init?.redirect,'error');assert.equal(init?.method,'POST');assert.ok(init?.signal);
  const json=decoded(init);assert.equal(json.model,'jev-1.14.0');assert.equal(json.state.data_classification,'real-public-mobile-controls');assert.equal(json.state.public_controls_only,true);assert.equal(json.state.goal,MOBILE_TASKS.find(t=>t.id==='M3')!.goal);
  assert.deepEqual(json.state.predicates,input().predicates);assert.deepEqual(json.questions.action.criteria,{open_search:MOBILE_ACTION_LABELS.open_search,open_bluetooth:MOBILE_ACTION_LABELS.open_bluetooth});assert.equal(json.questions.action.type,'choice');assert.doesNotMatch(JSON.stringify(json),/test-private-local-id|offline-test|test-only-injected-key/);
  return new Response(JSON.stringify(body()));
 });opts.reserve=async()=>{await Promise.resolve();order.push('reserve');};
 const result=await decide(input(),opts);assert.deepEqual(order,['reserve','fetch']);assert.equal(result.actionId,'open_search');assert.equal(result.confidence,.95);assert.ok(result.elapsed_ms>=0);assert.deepEqual({usage:result.usage,request_count:result.request_count,known_cost_usd:result.known_cost_usd,unknown_usage_requests:result.unknown_usage_requests},{usage:{input_tokens:100,output_tokens:1},request_count:1,known_cost_usd:100*.042/1e6,unknown_usage_requests:0});
});
test('private data, extra fields, unknown predicates, invalid truths and out-of-task candidates reject before reserve or network',async()=>{
 const invalid=[null,{...input(),goal:'private text'},{...input(),rawUI:'private text'},{...input(),summary:'private text'},{...input(),task_id:'M7'},{...input(),trial_id:'private text'},{...input(),trial_id:'x'.repeat(101)},{...input(),predicates:{private_text:true}},{...input(),predicates:{page_home:'true'}},{...input(),predicates:{page_home:{text:'private text'}}},{...input(),predicates:{page_home:null}},{...input(),predicates:{page_home:undefined}},{...input(),candidates:[]},{...input(),candidates:['open_search','open_search']},{...input(),candidates:['private text']},{...input(),candidates:['open_example']},{...input(),candidates:[{actionId:'open_search',label:'private text'}]}];
 for(const value of invalid){let reserves=0,calls=0;const opts=options(async()=>{calls++;throw Error('unexpected');});opts.reserve=()=>{reserves++;};await assert.rejects(decide(value,opts),error=>{assert.match(String(error),/INVALID_MOBILE_INPUT/);assert.equal(accounting(error).request_count,0);return true;});assert.equal(reserves,0);assert.equal(calls,0);}
});
test('all six fixed task catalogs accept their actions',async()=>{
 for(const task of MOBILE_TASKS){const candidates=task.catalog.actions.map(a=>a.actionId);const result=await decide({...input(),task_id:task.id,candidates},options(async()=>new Response(JSON.stringify(body(candidates[0])))));assert.equal(result.actionId,candidates[0]);}
});
test('authorization, scope, key and reserve are explicit and expiration is checked before reserve',async()=>{
 const invalid=[{authorization:{...options().authorization,expires_at:Date.now()-1}},{authorization:{...options().authorization,public_controls_only:false}},{authorization:undefined},{authorization:{...options().authorization,raw:'private text'}},{key:''},{key:'secret\nkey'},{reserve:undefined}];
 for(const patch of invalid){let reserves=0,calls=0;const opts={...options(async()=>{calls++;throw Error('unexpected');}),reserve:()=>{reserves++;},...patch} as Options;await assert.rejects(decide(input(),opts),/LIVE_NOT_AUTHORIZED/);assert.equal(reserves,0);assert.equal(calls,0);}
});
test('reservation failure never calls network and has zero-request accounting',async()=>{
 let calls=0;const opts=options(async()=>{calls++;throw Error('unexpected');});opts.reserve=()=>{throw Error('secret');};await assert.rejects(decide(input(),opts),error=>{assert.match(String(error),/BUDGET_RESERVATION_REJECTED/);assert.deepEqual(accounting(error),{usage:null,request_count:0,known_cost_usd:0,unknown_usage_requests:0});return true;});assert.equal(calls,0);
});
test('expiration while reserving prevents network and preserves conservative reservation accounting',async()=>{
 let calls=0;const opts=options(async()=>{calls++;throw Error('unexpected');});opts.authorization.expires_at=Date.now()+20;opts.reserve=()=>new Promise(resolve=>setTimeout(resolve,40));await assert.rejects(decide(input(),opts),error=>{assert.match(String(error),/LIVE_NOT_AUTHORIZED/);assert.equal(accounting(error).request_count,1);assert.equal(accounting(error).unknown_usage_requests,1);return true;});assert.equal(calls,0);
});
test('single transport failure or HTTP error never retries or leaks response data',async()=>{
 for(const status of [null,429,529]){let calls=0;await assert.rejects(decide(input(),options(async()=>{calls++;if(status===null)throw Error('secret');return new Response('private text',{status});})),error=>{assert.deepEqual(accounting(error),{usage:null,request_count:1,known_cost_usd:0,unknown_usage_requests:1});return true;});assert.equal(calls,1);}
});
test('invalid choices, confidence, model, probabilities and extra response fields preserve valid usage',async()=>{
 const base=body();const probabilities=[{open_search:.1,open_bluetooth:.9},{open_search:1},{open_search:.5,open_bluetooth:.2},{open_search:.9,private_text:.1},{open_search:1.1,open_bluetooth:-.1}];
 const invalid=[body('open_example'),body('open_search',2),body('open_search',-.1),{...base,model:'another-model'},{...base,raw:'private text'},...probabilities.map(p=>({...base,answers:{action:{...base.answers.action,probabilities:p}}}))];
 for(const raw of invalid)await assert.rejects(decide(input(),options(async()=>new Response(JSON.stringify(raw)))),error=>{const a=accounting(error);assert.equal(a.request_count,1);assert.equal(a.known_cost_usd,100*.042/1e6);assert.equal(a.unknown_usage_requests,0);return true;});
});
test('valid complete probability distribution is accepted and low confidence remains available to caller gate',async()=>{
 const raw=body('open_search',.1);const result=await decide(input(),options(async()=>new Response(JSON.stringify({...raw,answers:{action:{...raw.answers.action,probabilities:{open_search:.8,open_bluetooth:.2}}}}))));assert.equal(result.confidence,.1);
});
test('missing usage stays unknown, malformed usage rejects, and spend exceeding one cent rejects with known cost',async()=>{
 const missing=body();delete (missing as {usage?:unknown}).usage;assert.equal((await decide(input(),options(async()=>new Response(JSON.stringify(missing))))).unknown_usage_requests,1);
 for(const usage of [{input_tokens:-1,output_tokens:1},{input_tokens:1,output_tokens:1,private:'text'},{input_tokens:1e9,output_tokens:1}])await assert.rejects(decide(input(),options(async()=>new Response(JSON.stringify(body('open_search',.95,usage))))),error=>{const a=accounting(error);assert.equal(a.unknown_usage_requests,usage.input_tokens===1e9?0:1);assert.ok(Math.abs(a.known_cost_usd-(usage.input_tokens===1e9?42:0))<1e-12);return true;});
});
test('malformed or oversized response rejects with unknown usage and cancels stream',async()=>{
 for(const text of ['private text','x'.repeat(65537)]){let cancelled=false;const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(text));},cancel(){cancelled=true;}});const opts=options(async()=>new Response(stream));opts.authorization.expires_at=Date.now()+40;if(text==='private text') {const response=new Response(text);opts.transport=async()=>response;}
  await assert.rejects(decide(input(),opts),error=>{assert.equal(accounting(error).unknown_usage_requests,1);return true;});if(text.length>65536)assert.equal(cancelled,true);
 }
});
test('hung transport or stream is bounded by approval expiry even when cancellation hangs',async()=>{
 for(const streaming of [false,true]){let signal:AbortSignal|undefined;let cancelled=false;const opts=options(async(_url,init)=>{signal=init?.signal??undefined;if(!streaming)return new Promise(()=>{});return new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}}));});opts.authorization.expires_at=Date.now()+35;const start=Date.now();await assert.rejects(decide(input(),opts),/PROVIDER_DEADLINE/);assert.ok(signal?.aborted);assert.ok(Date.now()-start<500);if(streaming)assert.ok(cancelled);}
});
test('caller cancellation rejects before reserve and aborts an in-flight request without retry',async()=>{
 const pre=new AbortController();pre.abort();let reserves=0,calls=0;const opts=options(async()=>{calls++;return new Promise(()=>{});});opts.signal=pre.signal;opts.reserve=()=>{reserves++;};await assert.rejects(decide(input(),opts),/PROVIDER_CANCELLED/);assert.equal(reserves,0);assert.equal(calls,0);
 const active=new AbortController();let networkSignal:AbortSignal|undefined;const live=options(async(_url,init)=>{networkSignal=init?.signal??undefined;active.abort();return new Promise(()=>{});});live.signal=active.signal;await assert.rejects(decide(input(),live),error=>{assert.match(String(error),/PROVIDER_CANCELLED/);assert.equal(accounting(error).unknown_usage_requests,1);return true;});assert.ok(networkSignal?.aborted);
});
test('hanging reservation is bounded by authorization expiry and late completion never dispatches',async()=>{
 let finish:()=>void=()=>{};let calls=0;
 const opts=options(async()=>{calls++;throw Error('unexpected');});
 opts.authorization.expires_at=Date.now()+30;
 opts.reserve=()=>new Promise<void>(resolve=>{finish=resolve;});
 const pending=decide(input(),opts);
 const outcome=await Promise.race([pending.then(()=> 'resolved',error=>error),new Promise(resolve=>setTimeout(()=>resolve('unbounded-reservation'),200))]);
 assert.ok(outcome instanceof Error,'reservation must settle by authorization expiry');
 assert.match(outcome.message,/LIVE_NOT_AUTHORIZED/);assert.equal(accounting(outcome).request_count,1);assert.equal(accounting(outcome).unknown_usage_requests,1);
 finish();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,0);
});
test('caller abort bounds a hanging reservation and late rejection does not call network',async()=>{
 const controller=new AbortController();let rejectReservation:(reason:Error)=>void=()=>{};let calls=0;
 const opts=options(async()=>{calls++;throw Error('unexpected');});opts.signal=controller.signal;
 opts.reserve=()=>new Promise<void>((_resolve,reject)=>{rejectReservation=reject;controller.abort();});
 const pending=decide(input(),opts);
 const outcome=await Promise.race([pending.then(()=> 'resolved',error=>error),new Promise(resolve=>setTimeout(()=>resolve('unbounded-reservation'),200))]);
 assert.ok(outcome instanceof Error,'reservation must settle on cancellation');assert.match(outcome.message,/PROVIDER_CANCELLED/);assert.equal(accounting(outcome).unknown_usage_requests,1);
 rejectReservation(Error('secret'));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,0);
});
test('reservation and response share one fifteen-second deadline',async context=>{
 context.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 let finish:()=>void=()=>{};let calls=0;let outcome:unknown;
 const opts=options(async()=>{calls++;return new Promise(()=>{});});
 opts.authorization.expires_at=Date.now()+60000;opts.reserve=()=>new Promise<void>(resolve=>{finish=resolve;});
 void decide(input(),opts).then(value=>{outcome=value;},error=>{outcome=error;});
 await new Promise(resolve=>setImmediate(resolve));context.mock.timers.tick(14900);finish();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);context.mock.timers.tick(100);
 await new Promise(resolve=>setImmediate(resolve));assert.ok(outcome instanceof Error,'reservation must not reset the request deadline');assert.match(outcome.message,/PROVIDER_DEADLINE/);assert.equal(accounting(outcome).unknown_usage_requests,1);
});
