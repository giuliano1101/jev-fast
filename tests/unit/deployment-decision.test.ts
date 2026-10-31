import test from 'node:test';
import assert from 'node:assert/strict';
import {zstdDecompressSync} from 'node:zlib';
import {DEPLOYMENT_ACTIONS,DeploymentDecisionAdapter,decideDeployment,type DeploymentRequestOptions} from '../../bench/deployment/decision.js';
const actionIds=['verify_uploaded_source','verify_dns','inspect_listeners','prepare_private_relay','verify_private_health','publish_https','verify_public_mcp','inspect_operator_route'] as const;
const fresh=()=>({phase:'preflight',checked:{uploaded_source_verified:false,dns_verified:false,listeners_inspected:false,private_relay_prepared:false,private_health_verified:false,https_published:false,public_mcp_verified:false,operator_route_inspected:false},host_authorized:Object.fromEntries(actionIds.map(id=>[id,true])),candidates:['verify_uploaded_source','verify_dns','inspect_listeners']});
const answer=(choice='verify_dns',extra:Record<string,unknown>={})=>({model:'jev-1.14.0',answers:{action:{type:'choice',choice,confidence:.9,...extra}},usage:{input_tokens:100,output_tokens:1}});
const approval=():DeploymentRequestOptions=>({authorization:{approval_id:'current-deployment-approval',expires_at:Date.now()+10000,real_public_controls_only:true},reserve:()=>{}});
const decode=(init?:RequestInit)=>JSON.parse(typeof init?.body==='string'?init.body:zstdDecompressSync(init?.body as Uint8Array).toString());
function adapter(transport:(url:string,options?:RequestInit)=>Promise<Response>=async()=>new Response(JSON.stringify(answer()))){return new DeploymentDecisionAdapter({key:'test-private-key',transport});}
function errorAccounting(error:unknown){assert.ok(error instanceof Error);assert.doesNotMatch(error.message,/private|secret|account/);return (error as Error&{code:string;accounting:{request_count:number;unknown_usage_requests:number;usage:{input_tokens:number}|null;known_cost_usd:number}}).accounting;}

test('sanitized real deployment choice reserves once and sends only authored catalog data',async()=>{
 const order:string[]=[];const input=fresh();const opts=approval();opts.reserve=()=>{order.push('reserve');};
 const result=await adapter(async(url,init)=>{order.push('request');assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init?.redirect,'error');assert.equal(init?.method,'POST');assert.ok(init?.signal);const json=decode(init);assert.equal(json.model,'jev-1.14.0');assert.equal(json.state.data_classification,'real-public-deployment-controls');assert.equal(json.state.real_public_controls_only,true);assert.equal(json.state.synthetic,undefined);assert.deepEqual(Object.keys(json.questions.action.criteria),input.candidates);assert.doesNotMatch(JSON.stringify(json),/test-private-key|current-deployment-approval|https?:\/\/|account|raw_ax|screenshot/);return new Response(JSON.stringify(answer()));}).decide(input,opts);
 assert.deepEqual(order,['reserve','request']);assert.equal(result.candidate_id,'verify_dns');assert.equal(result.request_count,1);assert.equal(result.known_cost_usd,100*.042/1e6);assert.equal(result.unknown_usage_requests,0);assert.ok(result.selector_elapsed_ms>=0);assert.equal(result.execution_status,'NOT_EXECUTED');assert.equal('elapsed_ms' in result,false);
});
test('strict finite input rejects raw UI, free strings, secrets, unknown or duplicate candidates before reserve',async()=>{
 const cases=[{...fresh(),goal:'private account'},{...fresh(),url:'https://secret.test'},{...fresh(),raw_ax:'secret'},{...fresh(),screenshot:'secret'},{...fresh(),phase:'run private command'},{...fresh(),checked:{...fresh().checked,account:'secret'}},{...fresh(),checked:{...fresh().checked,dns_verified:'unknown'}},{...fresh(),host_authorized:{...fresh().host_authorized,publish_https:'yes'}},{...fresh(),candidates:['verify_dns','verify_dns']},{...fresh(),candidates:['run_shell']},{...fresh(),candidates:[]}];
 for(const input of cases){let calls=0,reserves=0;const opts=approval();opts.reserve=()=>{reserves++;};await assert.rejects(adapter(async()=>{calls++;throw Error('secret');}).decide(input,opts),/INVALID_DEPLOYMENT_INPUT/);assert.equal(calls,0);assert.equal(reserves,0);}
});
test('completed, unauthorized, stale phase and unmet prerequisite candidates reject before reservation',async()=>{
 const cases=[{...fresh(),checked:{...fresh().checked,dns_verified:true}},{...fresh(),host_authorized:{...fresh().host_authorized,verify_dns:false}},{...fresh(),candidates:['publish_https']},{...fresh(),phase:'private_relay',candidates:['prepare_private_relay']},{...fresh(),phase:'https',candidates:['publish_https']}];
 for(const input of cases){let reserves=0;const opts=approval();opts.reserve=()=>{reserves++;};await assert.rejects(adapter().decide(input,opts),/INVALID_DEPLOYMENT_INPUT/);assert.equal(reserves,0);}
});
test('preflight remaining candidates and every later checked phase are accepted',async()=>{
 const input=fresh();input.checked.dns_verified=true;input.candidates=['verify_uploaded_source','inspect_listeners'];await adapter(async()=>new Response(JSON.stringify(answer('inspect_listeners')))).decide(input,approval());
 const prerequisites=['uploaded_source_verified','dns_verified','listeners_inspected','private_relay_prepared','private_health_verified','https_published','public_mcp_verified'] as const;
 for(const [index,phase] of ['private_relay','private_health','https','public_mcp','operator_route'].entries()){const next=fresh();next.phase=phase;next.candidates=[actionIds[index+3]!];for(const key of prerequisites.slice(0,index+3))next.checked[key]=true;const result=await adapter(async()=>new Response(JSON.stringify(answer(next.candidates[0])))).decide(next,approval());assert.equal(result.candidate_id,next.candidates[0]);}
});
test('invalid, expired or wrong-scope authorization prevents reservation and request',async()=>{
 for(const auth of [{...approval().authorization,expires_at:Date.now()-1},{...approval().authorization,real_public_controls_only:false},{...approval().authorization,approval_id:'private account'},{...approval().authorization,extra:'secret'}]){let reserves=0,calls=0;await assert.rejects(adapter(async()=>{calls++;throw Error('secret');}).decide(fresh(),{authorization:auth,reserve:()=>{reserves++;}} as unknown as DeploymentRequestOptions),/LIVE_NOT_AUTHORIZED/);assert.equal(reserves,0);assert.equal(calls,0);}
});
test('reservation rejection prevents network with safe zero-request accounting',async()=>{
 let calls=0;await assert.rejects(adapter(async()=>{calls++;throw Error('secret');}).decide(fresh(),{...approval(),reserve:()=>{throw Error('secret');}}),error=>{assert.match(String(error),/BUDGET_RESERVATION_REJECTED/);assert.equal(errorAccounting(error).request_count,0);return true;});assert.equal(calls,0);
});
test('transport or HTTP failure never retries and preserves unknown usage',async()=>{
 for(const status of [null,429,529]){let calls=0;await assert.rejects(adapter(async()=>{calls++;if(status===null)throw Error('secret');return new Response('secret',{status});}).decide(fresh(),approval()),error=>{assert.equal(errorAccounting(error).request_count,1);assert.equal(errorAccounting(error).unknown_usage_requests,1);return true;});assert.equal(calls,1);}
});
test('malformed answer, stale choice and invalid probabilities preserve known usage',async()=>{
 const invalid=[{...answer(),model:'other'},answer('publish_https'),answer('verify_dns',{confidence:2}),answer('verify_dns',{probabilities:{verify_dns:.2,verify_uploaded_source:.7,inspect_listeners:.1}}),answer('verify_dns',{probabilities:{verify_dns:1}}),answer('verify_dns',{probabilities:{verify_dns:.8,verify_uploaded_source:.1,inspect_listeners:.2}})];
 for(const raw of invalid)await assert.rejects(adapter(async()=>new Response(JSON.stringify(raw))).decide(fresh(),approval()),error=>{assert.equal(errorAccounting(error).usage?.input_tokens,100);assert.equal(errorAccounting(error).unknown_usage_requests,0);return true;});
});
test('valid full probability distribution and low confidence return only selector result',async()=>{
 const result=await adapter(async()=>new Response(JSON.stringify(answer('verify_dns',{confidence:.1,probabilities:{verify_dns:.5,verify_uploaded_source:.3,inspect_listeners:.2}})))).decide(fresh(),approval());assert.equal(result.confidence,.1);assert.equal(result.execution_status,'NOT_EXECUTED');
});
test('oversize, unparseable and missing-usage responses remain accounted',async()=>{
 for(const raw of ['x'.repeat(65537),'private malformed answer',JSON.stringify({...answer(),usage:undefined})]){const call=adapter(async()=>new Response(raw)).decide(fresh(),approval());if(raw.startsWith('{')){const result=await call;assert.equal(result.unknown_usage_requests,1);}else await assert.rejects(call,error=>{assert.equal(errorAccounting(error).unknown_usage_requests,1);return true;});}
});
test('excess reported usage fails closed with known cost',async()=>{
 await assert.rejects(adapter(async()=>new Response(JSON.stringify({...answer(),usage:{input_tokens:1000000,output_tokens:1}}))).decide(fresh(),approval()),error=>{assert.match(String(error),/USAGE_EXCEEDS_RESERVATION/);assert.equal(errorAccounting(error).known_cost_usd,.042);return true;});
});
test('expiry bounds hung reservation, transport and response stream without later dispatch',async()=>{
 for(const hung of ['reservation','transport','stream']){let calls=0;const opts=approval();opts.authorization.expires_at=Date.now()+40;if(hung==='reservation')opts.reserve=()=>new Promise(()=>{});const started=Date.now();await assert.rejects(adapter(async()=>{calls++;if(hung==='transport')return new Promise(()=>{});return new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}));}).decide(fresh(),opts),error=>{assert.match(String(error),/LIVE_NOT_AUTHORIZED|PROVIDER_DEADLINE/);assert.equal(errorAccounting(error).request_count,1);return true;});assert.ok(Date.now()-started<500);assert.equal(calls,hung==='reservation'?0:1);}
});
test('authored catalog cannot be modified and standalone selector function invokes the adapter',async()=>{
 assert.equal(typeof decideDeployment,'function');
 assert.throws(()=>{Object.assign(DEPLOYMENT_ACTIONS,{verify_dns:'private replacement'});},TypeError);
 assert.equal((await decideDeployment(fresh(),adapter(),approval())).candidate_id,'verify_dns');
});
