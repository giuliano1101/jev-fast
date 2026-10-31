import test from 'node:test';
import assert from 'node:assert/strict';
test('network module provides normalized strict business requests',async()=>{
 const path='../../src/network/protocol.js';
 const api=await import(path).catch(()=>({}));
 assert.equal(typeof api.normalizeRequest,'function','network request normalization is not implemented');
 const base={request_id:'request',params:{session_id:'s',goal_id:'g',idempotency_key:'i',goal:{task:'form',seed:4,language:'en'},success:{kind:'task_complete'}}};
 const normalized=api.normalizeRequest('jev.run_goal',base);
 assert.equal(normalized.params.max_steps,8);
 assert.deepEqual(normalized,api.normalizeRequest('jev.run_goal',{...base,params:{...base.params,max_steps:8,time_budget_ms:60000}}));
 assert.throws(()=>api.normalizeRequest('jev.run_goal',{...base,params:{...base.params,goal:{...base.params.goal,values:{name:'real name'}}}}));
 assert.throws(()=>api.normalizeRequest('jev.run_goal',{...base,params:{...base.params,success:{kind:'field',field:'email',value:'real@example.com'}}}));
 assert.throws(()=>api.normalizeRequest('jev.open_session',{request_id:'x',params:{fixture_id:'standard',url:'https://example.com'}}));
});
