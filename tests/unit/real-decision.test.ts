import test from 'node:test';
import assert from 'node:assert/strict';
import {zstdDecompressSync} from 'node:zlib';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {decidePublic} from '../../bench/real/decision.js';
import {parsePublicInput,PUBLIC_TASKS} from '../../bench/real/catalog.js';

interface Accounting {usage:{input_tokens:number;output_tokens:number}|null;request_count:number;known_cost_usd:number;unknown_usage_requests:number}
interface Result extends Accounting {candidate_id:string;confidence:number;elapsed_ms:number}
interface Options {key:string;authorization:{approval_id:string;expires_at:number;public_controls_only:true};reserve:()=>unknown;transport:(url:string,options?:RequestInit)=>Promise<Response>}
async function decide(input:unknown,options:Options):Promise<Result>{
 return decidePublic(input,options);
}
const input=()=>({task_id:'W1',variant:'baseline',trial_id:'test-1',completed:[],candidates:['open_english','open_chinese']});
const body=(choice='open_english',confidence=0.9,usage:unknown={input_tokens:100,output_tokens:1})=>({model:'jev-1.14.0',answers:{action:{type:'choice',choice,confidence}},...(usage===undefined?{}:{usage})});
const options=(transport:Options['transport']=async()=>new Response(JSON.stringify(body()))):Options=>({key:'test-only-injected-key',authorization:{approval_id:'user-20261030-usd3',expires_at:Date.now()+30000,public_controls_only:true},reserve:()=>({request:1}),transport});
function accounting(error:unknown):Accounting {assert.ok(error instanceof Error);assert.doesNotMatch(error.message,/secret|private text/);return (error as Error&{accounting:Accounting}).accounting;}

test('public request uses catalog controls, explicit real label, fixed endpoint, and reserves before fetch',async()=>{
 const order:string[]=[];const opts=options(async(url,init)=>{order.push('fetch');assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init?.redirect,'error');assert.equal(init?.method,'POST');assert.ok(init?.signal);
 const json=JSON.parse(typeof init.body==='string'?init.body:zstdDecompressSync(init.body as Uint8Array).toString());
 assert.equal(json.state.data_classification,'real-public-controls');assert.equal(json.state.public_controls_only,true);assert.equal(json.state.synthetic,undefined);assert.equal(json.model,'jev-1.14.0');assert.deepEqual(Object.keys(json.questions.action.criteria),input().candidates);return new Response(JSON.stringify(body()));});opts.reserve=async()=>{await Promise.resolve();order.push('reserve');};
 const result=await decide(input(),opts);assert.deepEqual(order,['reserve','fetch']);assert.equal(result.candidate_id,'open_english');assert.equal(result.request_count,1);assert.equal(result.unknown_usage_requests,0);assert.equal(result.known_cost_usd,100*0.042/1e6);
});
test('raw/private data, unlisted IDs, duplicates, excess values and cross-surface actions reject before reservation',async()=>{
 const invalid=[{...input(),raw:'private text'},{...input(),summary:'private text'},{...input(),completed:['private text']},{...input(),candidates:['open_english','open_english']},{...input(),completed:['open_english','open_english']},{...input(),candidates:['open_audit']},{...input(),trial_id:'private text'},{...input(),candidates:Array(65).fill('open_english')},{...input(),candidates:[]},{...input(),task_id:'W9'}];
 for(const value of invalid){let reserves=0,calls=0;const opts=options(async()=>{calls++;throw Error('unexpected');});opts.reserve=()=>{reserves++;};await assert.rejects(decide(value,opts),/INVALID_PUBLIC_INPUT/);assert.equal(reserves,0);assert.equal(calls,0);}
});
test('verified completed controls may overlap baseline candidates and baseline stays unchanged',async()=>{
 const bodies:string[]=[];for(const variant of ['baseline','baseline'])await decide({...input(),variant,completed:['open_english']},options(async(_url,init)=>{bodies.push(typeof init?.body==='string'?init.body:zstdDecompressSync(init?.body as Uint8Array).toString());return new Response(JSON.stringify(body()));}));assert.equal(bodies[0],bodies[1]);assert.deepEqual(Object.keys(JSON.parse(bodies[0]!).questions.action.criteria),input().candidates);
});
test('expired or incorrectly scoped approval rejects without reserving',async()=>{
 for(const authorization of [{...options().authorization,expires_at:Date.now()-1},{...options().authorization,public_controls_only:false}]){let reserves=0;const opts={...options(),authorization,reserve:()=>{reserves++;}};await assert.rejects(decide(input(),opts as Options),/LIVE_NOT_AUTHORIZED/);assert.equal(reserves,0);}
});
test('reservation failure prevents fetch and emits safe zero-request accounting',async()=>{
 let calls=0;const opts=options(async()=>{calls++;throw Error('unexpected');});opts.reserve=()=>{throw Error('secret');};await assert.rejects(decide(input(),opts),error=>{assert.match(String(error),/BUDGET_RESERVATION_REJECTED/);assert.equal(accounting(error).request_count,0);return true;});assert.equal(calls,0);
});
test('single transport attempt never retries and accounts unknown usage on injected failure or HTTP overload',async()=>{
 for(const response of [null,429,529]){let calls=0;await assert.rejects(decide(input(),options(async()=>{calls++;if(response===null)throw Error('secret');return new Response('private text',{status:response});})),error=>{assert.deepEqual(accounting(error),{usage:null,request_count:1,known_cost_usd:0,unknown_usage_requests:1});return true;});assert.equal(calls,1);}
});
test('response byte limit, invalid choice, confidence, usage and probabilities fail closed with known usage preserved',async()=>{
 const cases=[{raw:'x'.repeat(65537),known:false},{raw:JSON.stringify(body('select_published')),known:true},{raw:JSON.stringify(body('open_english',2)),known:true},{raw:JSON.stringify(body('open_english',0.9,{input_tokens:-1,output_tokens:0})),known:false},{raw:JSON.stringify({...body(),answers:{action:{type:'choice',choice:'open_english',confidence:.9,probabilities:{open_english:.2,open_chinese:.8}}}}),known:true},{raw:JSON.stringify({...body(),answers:{action:{type:'choice',choice:'open_english',confidence:.9,probabilities:{open_english:1}}}}),known:true}];
 for(const c of cases)await assert.rejects(decide(input(),options(async()=>new Response(c.raw))),error=>{const a=accounting(error);assert.equal(a.request_count,1);assert.equal(a.unknown_usage_requests,c.known?0:1);assert.equal(a.usage?.input_tokens,c.known?100:undefined);return true;});
});
test('low confidence is returned for caller stop gate and absent usage remains unknown',async()=>{const raw=body('open_english',.1);delete (raw as {usage?:unknown}).usage;const result=await decide(input(),options(async()=>new Response(JSON.stringify(raw))));assert.equal(result.confidence,.1);assert.equal(result.usage,null);assert.equal(result.unknown_usage_requests,1);});
test('expiry while reserving prevents fetch; reservation remains conservatively accounted',async()=>{const opts=options();opts.authorization.expires_at=Date.now()+30;opts.reserve=()=>new Promise(resolve=>setTimeout(resolve,50));await assert.rejects(decide(input(),opts),error=>{assert.match(String(error),/LIVE_NOT_AUTHORIZED/);assert.equal(accounting(error).request_count,1);return true;});});
test('six catalog tasks accept their public controls and reject unrelated controls',()=>{
 assert.deepEqual(Object.keys(PUBLIC_TASKS),['W1','W2','W3','D1','D2','D3']);
 for(const [task_id,task] of Object.entries(PUBLIC_TASKS)){assert.doesNotThrow(()=>parsePublicInput({...input(),task_id,candidates:task.controls}));assert.throws(()=>parsePublicInput({...input(),task_id,candidates:['send_message']}),/INVALID_PUBLIC_INPUT/);}
});
test('W3 uses the observed calculator.net controls and verified initial years without unseen navigation',async()=>{
 assert.match(PUBLIC_TASKS.W3.goal,/calculator\.net/);
 for(const candidate of ['add_days','workdays'])assert.throws(()=>parsePublicInput({...input(),task_id:'W3',candidates:[candidate]}),/INVALID_PUBLIC_INPUT/);
 const value={...input(),task_id:'W3',completed:['fill_y1','fill_y2'],candidates:['fill_m1','fill_d1','fill_y1','fill_m2','fill_d2','fill_y2','include_end','calculate_duration']};
 await decide(value,options(async(_url,init)=>{const json=JSON.parse(typeof init?.body==='string'?init.body:zstdDecompressSync(init?.body as Uint8Array).toString());assert.equal(json.questions.action.criteria.fill_m1,'Set start month to November');assert.equal(json.questions.action.criteria.fill_m2,'Set end month to November');assert.equal(json.state.completed.length,2);return new Response(JSON.stringify(body('fill_m1')));}));
});
test('hung transport or response stream is aborted at approval expiry even if cancellation stalls',async()=>{
 for(const stream of [false,true]){let signal:AbortSignal|undefined;const opts=options(async(_url,init)=>{signal=init?.signal??undefined;if(!stream)return new Promise(()=>{});return new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}));});opts.authorization.expires_at=Date.now()+35;const started=Date.now();await assert.rejects(decide(input(),opts),error=>{assert.match(String(error),/PROVIDER_DEADLINE/);assert.equal(accounting(error).unknown_usage_requests,1);return true;});assert.ok(signal?.aborted);assert.ok(Date.now()-started<500);}
});
test('CLI refuses a missing original budget, records sanitized failure, and never creates a new ledger',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jev-public-test-'));try{
  const inputPath=join(root,'input.json');await writeFile(inputPath,JSON.stringify(input()));
  const cli=new URL('../../bench/real/decision.js',import.meta.url).pathname;
  const result=await promisify(execFile)(process.execPath,[cli,'/no-key-is-read',inputPath],{cwd:root}).then(()=>assert.fail('CLI must reject missing budget'),error=>error as {stdout:string;stderr:string});
  assert.equal(result.stderr,'');const output=JSON.parse(result.stdout);assert.equal(output.status,'failed');assert.equal(output.error.accounting.request_count,0);assert.equal(output.budget,null);assert.equal(JSON.parse(await readFile(output.path,'utf8')).status,'failed');await assert.rejects(access(join(root,'.runtime/live-budget/budget.json')));
  await writeFile(inputPath,JSON.stringify({...input(),raw:'private text'}));
  const rejected=await promisify(execFile)(process.execPath,[cli,'/no-key-is-read',inputPath],{cwd:root}).then(()=>assert.fail('CLI must reject raw data'),error=>error as {stdout:string;stderr:string});const rejectedOutput=JSON.parse(rejected.stdout);assert.doesNotMatch(await readFile(rejectedOutput.path,'utf8'),/private text|raw|no-key-is-read/);assert.notEqual(output.path,rejectedOutput.path);
 }finally{await rm(root,{recursive:true,force:true});}
});
