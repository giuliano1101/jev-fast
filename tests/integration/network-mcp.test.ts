import test from 'node:test';
import assert from 'node:assert/strict';
import {networkToolDefinitions,MAX_BODY} from '../../src/network/protocol.js';
import {toolDefinitions} from '../../src/service/contracts.js';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {networkFixture,runLocalCli,until,type NetworkEnvelope} from '../helpers/network-fixture.js';
function result(row:NetworkEnvelope):Record<string,unknown>{assert.equal(row.delivery_status,'COMPLETED',JSON.stringify(row));assert.equal(row.reply?.ok,true,JSON.stringify(row));return row.reply!.result as Record<string,unknown>;}
test('actual HTTPS SDK MCP and outbound connector execute one browser goal and recover same IDs across client reconnect without replay',{timeout:35000},async()=>{
 const f=await networkFixture();let local:Client|undefined;
 try{
  const client=await f.client();await f.ready(client);const listed=(await client.listTools()).tools;
  assert.deepEqual(listed.map(t=>t.name).sort(),networkToolDefinitions.map(t=>t.name).sort());
  assert.equal((await f.tool(client,'jev.open_session',{fixture_id:'standard'})).code,'INVALID_ARGUMENTS');
  const open=result(await f.request(client,'jev.open_session','open-one',{fixture_id:'standard'})),session_id=String(open.session_id);assert.ok(session_id&&session_id!=='undefined');
  const goal={session_id,goal_id:'network-goal',idempotency_key:'network-key',goal:{task:'form',language:'zh',seed:121},success:{kind:'task_complete'}};
  const goalResult=result(await f.request(client,'jev.run_goal','goal-one',goal));assert.equal(goalResult.status,'SUCCEEDED');
  const before=await f.ledger(),physical=f.browser.physical;assert.ok(physical>=3);assert.equal(Object.keys(before.actions).length,physical);
  await client.close();const reconnected=await f.client();
  const duplicate=result(await f.request(reconnected,'jev.run_goal','goal-one',goal));assert.deepEqual(duplicate,goalResult);assert.equal(f.browser.physical,physical);assert.equal(Object.keys((await f.ledger()).actions).length,Object.keys(before.actions).length);
  const conflict=await f.tool(reconnected,'jev.run_goal',{request_id:'goal-one',params:{...goal,goal:{task:'form',language:'zh',seed:122}}});assert.equal(conflict.code,'IDEMPOTENCY_CONFLICT');
  const inspected=result(await f.request(reconnected,'jev.status','read-one',{session_id,goal_id:'network-goal'}));assert.equal(inspected.status,'SUCCEEDED');
  const cli=await runLocalCli(f.runtime,['service','health']);assert.equal(cli.code,0);assert.equal(JSON.parse(cli.stdout).ready,true);
  local=new Client({name:'local-compatibility',version:'1.0.0'});await local.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/src/mcp/index.js'),'--credential',join(f.runtime,'client-a.json')],stderr:'pipe'}));assert.equal((await local.listTools()).tools.length,toolDefinitions.length);
  assert.equal(result(await f.request(reconnected,'jev.close_session','close-one',{session_id})).closed,true);
  const credential=JSON.parse(await readFile(join(f.runtime,'client-a.json'),'utf8')) as {token:string};assert.ok(!JSON.stringify([listed,open,goalResult,duplicate,inspected]).includes(credential.token));
 }finally{await local?.close().catch(()=>{});await f.close();}
});
test('network endpoint rejects unauthenticated/wrong-role/origin/oversize and noncanonical input before any local work',{timeout:20000},async()=>{
 const f=await networkFixture({connector:false,local:false});
 try{
  const rpc=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'security',version:'1'}}});
  const headers={authorization:'Bearer '+f.tokens.mcp,'content-type':'application/json',accept:'application/json, text/event-stream'};
  const raw=(path:string,body=rpc,extra:Record<string,string>={})=>f.fetcher(f.net.url+path,{method:'POST',headers:{...headers,...extra},body});
  assert.equal((await raw('/mcp',rpc,{authorization:'Bearer '+'0'.repeat(64)})).status,401);
  assert.equal((await raw('/mcp',rpc,{authorization:'Bearer '+f.tokens.connector})).status,401);
  assert.equal((await raw('/connector/sync',JSON.stringify({}),{authorization:'Bearer '+f.tokens.mcp})).status,401);
  assert.equal((await raw('/mcp',rpc,{origin:'https://evil.example'})).status,403);
  assert.equal((await raw('/mcp',rpc,{host:'evil.example'})).status,403);
  assert.equal((await raw('/mcp','x'.repeat(MAX_BODY+1))).status,413);
  const client=await f.client();assert.equal((await f.tool(client,'jev.network_status')).connector_online,false);
  const goal={session_id:'synthetic-session',goal_id:'g',idempotency_key:'k',goal:{task:'form',language:'en',seed:2,values:{email:'real@example.com'}},success:{kind:'task_complete'}};
  const denied=await f.tool(client,'jev.run_goal',{request_id:'unsafe-value',params:goal});assert.equal(denied.code,'NONCANONICAL_SYNTHETIC_VALUE');
  const deniedPredicate=await f.tool(client,'jev.run_goal',{request_id:'unsafe-predicate',params:{...goal,goal:{task:'form',language:'en',seed:2},success:{kind:'field',field:'email',value:'real@example.com'}}});assert.equal(deniedPredicate.code,'NONCANONICAL_SYNTHETIC_VALUE');
  assert.equal((await f.tool(client,'jev.request_status',{request_id:'unsafe-value'})).code,'REQUEST_NOT_FOUND');
  const offline=await f.submit(client,'jev.open_session','off-open',{fixture_id:'standard'});assert.equal(offline.delivery_status,'REJECTED');
  await f.startLocal();await f.startConnection();await f.ready(client);
  assert.equal((await f.submit(client,'jev.open_session','off-open',{fixture_id:'standard'})).delivery_status,'REJECTED','offline request must not become backlog after reconnect');
  const fresh=result(await f.request(client,'jev.open_session','fresh-open',{fixture_id:'standard'}));assert.ok(fresh.session_id);
 }finally{await f.close();}
});
test('real core UNKNOWN remains quarantined through network retry and fresh delivery IDs',{timeout:25000},async()=>{
 const f=await networkFixture();
 try{
  const client=await f.client();await f.ready(client);const session_id=String(result(await f.request(client,'jev.open_session','unknown-open',{fixture_id:'standard'})).session_id);f.browser.loseNextResponse=true;
  const params={session_id,goal_id:'unknown-goal',idempotency_key:'unknown-key',goal:{task:'form',language:'en',seed:131},success:{kind:'task_complete'}};
  const first=result(await f.request(client,'jev.run_goal','unknown-delivery',params));assert.equal(first.status,'UNKNOWN');assert.equal(f.browser.physical,1);
  assert.deepEqual(result(await f.request(client,'jev.run_goal','unknown-delivery',params)),first);assert.equal(f.browser.physical,1);
  assert.deepEqual(result(await f.request(client,'jev.run_goal','same-goal-new-delivery',params)),first);assert.equal(f.browser.physical,1);
  const quarantined=await f.request(client,'jev.run_goal','new-goal-delivery',{...params,goal_id:'new-goal',idempotency_key:'new-key'});assert.equal(quarantined.delivery_status,'COMPLETED');assert.equal(quarantined.reply?.ok,false);assert.equal(quarantined.reply?.error?.code,'QUARANTINED');assert.equal(f.browser.physical,1);
  const ledger=await f.ledger();assert.equal(Object.keys(ledger.actions).length,1);assert.equal(Object.values(ledger.actions)[0]!.status,'UNKNOWN');
 }finally{await f.close();}
});
test('outbound connector stays live for cancellation and status while an actual browser goal is pending',{timeout:25000},async()=>{
 const f=await networkFixture();
 try{
  const client=await f.client();await f.ready(client);const session_id=String(result(await f.request(client,'jev.open_session','cancel-open',{fixture_id:'standard'})).session_id),gate=f.provider.holdNext();
  await f.submit(client,'jev.run_goal','cancel-goal',{session_id,goal_id:'cancel-g',idempotency_key:'cancel-k',goal:{task:'form',language:'en',seed:141},success:{kind:'task_complete'}});await gate.entered;
  const live=await f.tool(client,'jev.network_status');assert.equal(live.connector_online,true);
  const cancelled=result(await f.request(client,'jev.cancel','cancel-request',{session_id,goal_id:'cancel-g'}));assert.equal(cancelled.status,'CANCELLED');
  const done=result(await f.terminal(client,'cancel-goal'));assert.equal(done.status,'CANCELLED');assert.equal(f.browser.physical,0);gate.release();
  await until(()=>f.tool(client,'jev.network_status'),value=>value.local_ready===true);
 }finally{await f.close();}
});
