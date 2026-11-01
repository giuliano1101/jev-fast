import test from 'node:test';
import assert from 'node:assert/strict';
test('network module provides normalized strict business requests',async()=>{
 const path='../../src/network/protocol.js';
 const api=await import(path).catch(()=>({}));
 assert.equal(typeof api.normalizeRequest,'function','network request normalization is not implemented');
 const base={request_id:'request',params:{session_id:'s',goal_id:'g',idempotency_key:'i',goal:{task:'form',seed:4,language:'en'},success:{kind:'task_complete'}}};
 const normalized=api.normalizeRequest('jev.run_goal',base);
 assert.equal(normalized.params.max_steps,undefined);
 assert.equal(normalized.params.time_budget_ms,undefined);
 assert.notDeepEqual(normalized,api.normalizeRequest('jev.run_goal',{...base,params:{...base.params,max_steps:8,time_budget_ms:60000}}));
 assert.throws(()=>api.normalizeRequest('jev.run_goal',{...base,params:{...base.params,goal:{...base.params.goal,values:{name:'real name'}}}}));
 assert.throws(()=>api.normalizeRequest('jev.run_goal',{...base,params:{...base.params,success:{kind:'field',field:'email',value:'real@example.com'}}}));
 assert.throws(()=>api.normalizeRequest('jev.open_session',{request_id:'x',params:{fixture_id:'standard',url:'https://example.com'}}));
});

test('continuation capability is transport context and never changes durable business fingerprints',async()=>{
 const {normalizeRequest}=await import('../../src/network/protocol.js');const args={request_id:'same',params:{fixture_id:'standard'}};assert.deepEqual(normalizeRequest('jev.open_session',{...args,continuation_token:'a'.repeat(64)}),normalizeRequest('jev.open_session',args));
 assert.throws(()=>normalizeRequest('jev.open_session',{...args,continuation_token:'guessed-connection-id'}),/INVALID_ARGUMENTS/);
});
