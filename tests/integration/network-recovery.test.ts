import test from 'node:test';
import assert from 'node:assert/strict';
import {startControlPanel} from '../../src/control/server.js';
import {networkFixture,until,type NetworkEnvelope} from '../helpers/network-fixture.js';
function result(row:NetworkEnvelope):Record<string,unknown>{assert.equal(row.delivery_status,'COMPLETED',JSON.stringify(row));assert.equal(row.reply?.ok,true,JSON.stringify(row));return row.reply!.result as Record<string,unknown>;}
test('lost connector result uploads survive connector restart and reconcile the exact cached browser outcome without IPC replay',{timeout:30000},async()=>{
 const f=await networkFixture({proxy:true});
 try{
  const client=await f.client();await f.ready(client);const session_id=String(result(await f.request(client,'jev.open_session','receipt-open',{fixture_id:'standard'})).session_id);
  f.proxy.dropUploads=true;
  const params={session_id,goal_id:'receipt-g',idempotency_key:'receipt-k',goal:{task:'form',language:'en',seed:151},success:{kind:'task_complete'}};
  await f.submit(client,'jev.run_goal','receipt-goal',params);
  await until(()=>f.ledger(),ledger=>Object.values(ledger.goals).some(goal=>goal.status==='SUCCEEDED'));await until(async()=>f.proxy.blockedUploads,n=>n>0);
  const physical=f.browser.physical,actions=Object.keys((await f.ledger()).actions).length;assert.ok(physical>=3);assert.equal(actions,physical);
  await f.stopConnection();await until(()=>f.tool(client,'jev.network_status'),status=>status.connector_online===false);
  f.proxy.dropUploads=false;await f.startConnection();await f.ready(client);
  const recovered=result(await f.terminal(client,'receipt-goal'));assert.equal(recovered.status,'SUCCEEDED');assert.equal(f.browser.physical,physical);
  assert.deepEqual(result(await f.request(client,'jev.run_goal','receipt-goal',params)),recovered);assert.equal(Object.keys((await f.ledger()).actions).length,actions);assert.ok(f.proxy.receiptBodies>=2);
 }finally{await f.close();}
});
test('lost delivery response is never delivered twice and relay restart preserves network UNKNOWN instead of executing it',{timeout:25000},async()=>{
 const f=await networkFixture({proxy:true});
 try{
  const client=await f.client();await f.ready(client);f.proxy.dropDeliveries=true;
  const ack=await f.submit(client,'jev.open_session','lost-delivery',{fixture_id:'standard'});assert.equal(ack.delivery_status,'QUEUED');
  await until(async()=>f.proxy.droppedDeliveries,n=>n===1);assert.equal((await f.status(client,'lost-delivery')).delivery_status,'DISPATCHED');
  assert.equal(Object.keys(f.engine.ledger.state.sessions).length,0,'response was cut before connector claimed delivery');
  await f.restartRelay();await f.ready(client);
  assert.equal((await f.status(client,'lost-delivery')).delivery_status,'UNKNOWN');
  assert.equal((await f.submit(client,'jev.open_session','lost-delivery',{fixture_id:'standard'})).delivery_status,'UNKNOWN');
  assert.equal(Object.keys(f.engine.ledger.state.sessions).length,0,'UNKNOWN must not be redelivered after restart');
  const fresh=result(await f.request(client,'jev.open_session','fresh-after-loss',{fixture_id:'standard'}));assert.ok(fresh.session_id);assert.equal(Object.keys(f.engine.ledger.state.sessions).length,1);
 }finally{await f.close();}
});
test('lost MCP response recovers by caller request_id through a new actual HTTP client without repeating browser actions',{timeout:25000},async()=>{
 const f=await networkFixture();
 try{
  const client=await f.client();await f.ready(client);const session_id=String(result(await f.request(client,'jev.open_session','rpc-open',{fixture_id:'standard'})).session_id);
  let lost=false;
  const interrupted:typeof fetch=async(input,init)=>{const response=await f.fetcher(input,init);if(!lost&&typeof init?.body==='string'&&init.body.includes('rpc-lost-goal')){lost=true;throw new TypeError('test link lost after relay accepted request');}return response;};
  const cut=await f.client(f.tokens.mcp,interrupted),params={session_id,goal_id:'rpc-g',idempotency_key:'rpc-k',goal:{task:'select',language:'zh',seed:161},success:{kind:'task_complete'}};
  await assert.rejects(f.submit(cut,'jev.run_goal','rpc-lost-goal',params));assert.equal(lost,true);await cut.close();
  const replacement=await f.client(),done=result(await f.terminal(replacement,'rpc-lost-goal'));assert.equal(done.status,'SUCCEEDED');const physical=f.browser.physical;assert.equal(physical,1);
  assert.deepEqual(result(await f.request(replacement,'jev.run_goal','rpc-lost-goal',params)),done);assert.equal(f.browser.physical,physical);
 }finally{await f.close();}
});
test('actual local panel stops an active remote goal while cloud link is down; off/on rejects stale work and fresh work succeeds',{timeout:40000},async()=>{
 const f=await networkFixture({proxy:true}),panel=await startControlPanel({runtime:f.runtime,port:0});
 const url=new URL(panel.url),headers={origin:url.origin,'x-jev-control-token':url.hash.slice(1)};
 const panelAction=async(action:'start'|'stop')=>{const response=await fetch(url.origin+'/api/'+action,{method:'POST',headers});assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});};
 try{
  const client=await f.client();const firstReady=await f.ready(client),oldInstance=firstReady.local_instance_id;
  const session_id=String(result(await f.request(client,'jev.open_session','switch-open',{fixture_id:'standard'})).session_id),gate=f.provider.holdNext();
  await f.submit(client,'jev.run_goal','switch-active',{session_id,goal_id:'switch-g',idempotency_key:'switch-k',goal:{task:'form',language:'en',seed:171},success:{kind:'task_complete'}});await gate.entered;
  f.proxy.offline=true;
  const stale=await f.submit(client,'jev.open_session','queued-before-off',{fixture_id:'standard'});assert.equal(stale.delivery_status,'QUEUED');
  await panelAction('stop');const stopped=await f.ledger();assert.ok(Object.values(stopped.goals).every(goal=>goal.status!=='RUNNING'));assert.equal(f.browser.physical,0,'local switch worked without cloud connectivity');gate.release();
  await panelAction('start');f.proxy.offline=false;const newReady=await until(()=>f.tool(client,'jev.network_status'),row=>row.local_ready===true&&row.local_instance_id!==oldInstance);assert.notEqual(newReady.local_instance_id,oldInstance,'off/on rotates local execution instance');
  assert.equal((await f.terminal(client,'queued-before-off')).delivery_status,'REJECTED');
  const preserved=await f.ledger();assert.equal(Object.keys(preserved.actions).length,0,'queued and interrupted work did not execute after restart');
  const newSession=String(result(await f.request(client,'jev.open_session','switch-fresh-open',{fixture_id:'standard'})).session_id);
  const newGoal=result(await f.request(client,'jev.run_goal','switch-fresh-goal',{session_id:newSession,goal_id:'fresh-g',idempotency_key:'fresh-k',goal:{task:'select',language:'en',seed:172},success:{kind:'task_complete'}}));assert.equal(newGoal.status,'SUCCEEDED');assert.equal(Object.keys((await f.ledger()).actions).length,1);
  await panelAction('stop');await until(()=>f.tool(client,'jev.network_status'),row=>row.local_ready===false);
  const denied=await f.submit(client,'jev.open_session','while-off',{fixture_id:'standard'});assert.equal(denied.delivery_status,'REJECTED');
 }finally{await panel.close();await f.close();}
});
