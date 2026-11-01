import test from 'node:test';
import assert from 'node:assert/strict';
import {networkToolDefinitions} from '../../src/network/protocol.js';
import {chromium} from 'playwright';
import {chromiumExecutable} from '../../src/browser/executable.js';
import {admissionFixture,type ConnectionRow} from '../helpers/admission-fixture.js';
import {until,type NetworkEnvelope} from '../helpers/network-fixture.js';
function completed(row:NetworkEnvelope):Record<string,unknown>{assert.equal(row.delivery_status,'COMPLETED',JSON.stringify(row));assert.equal(row.reply?.ok,true,JSON.stringify(row));return row.reply!.result as Record<string,unknown>;}
function denied(row:unknown){assert.equal(typeof (row as {code?:unknown}).code,'string',JSON.stringify(row));assert.match(String((row as {code:string}).code),/ADMISSION|REQUIRED|DISABLED|REVOKED/);}
test('no-key named MCP/device connections appear disabled in actual console; operator UI alone enables execution and reload keeps console access',{timeout:30000},async()=>{
 const f=await admissionFixture(),browser=await chromium.launch({headless:true,executablePath:chromiumExecutable()});
 try{
  const {client}=await f.client();assert.equal((await client.listTools()).tools.length,networkToolDefinitions.length);const device=await f.row('device','Our Mac mini'),ai=await f.row('ai','Our AI');assert.equal(device.enabled,false);assert.equal(ai.enabled,false);
  denied(await f.submit(client,'jev.open_session','before-approval',{fixture_id:'standard'}));assert.equal(Object.keys(f.engine.ledger.state.sessions).length,0);assert.equal(f.browser.physical,0);
  const page=await browser.newPage({viewport:{width:1100,height:1000}}),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(f.net.admin.url);
  await page.getByText('Our Mac mini',{exact:true}).waitFor();await page.getByText('Our AI',{exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'');
  await page.locator(`[data-id="${device.id}"]`).getByRole('button',{name:'开启',exact:true}).click();await until(async()=>f.rows().find(row=>row.id===device.id)?.enabled,Boolean);await until(async()=>f.net.store.status(),status=>status.local_ready===true);
  await page.locator(`[data-id="${ai.id}"]`).getByRole('button',{name:'开启',exact:true}).click();await until(async()=>f.rows().find(row=>row.id===ai.id)?.enabled,Boolean);await until(()=>f.tool(client,'jev.network_status'),status=>status.enabled===true&&status.local_ready===true);
  const session_id=String(completed(await f.request(client,'jev.open_session','approved-open',{fixture_id:'standard'})).session_id);
  const goal=completed(await f.request(client,'jev.run_goal','approved-goal',{session_id,goal_id:'approved-g',idempotency_key:'approved-k',goal:{task:'select',language:'zh',seed:201},success:{kind:'task_complete'}}));assert.equal(goal.status,'SUCCEEDED');assert.equal(f.browser.physical,1);
  await page.reload();await page.getByText('Our AI',{exact:true}).waitFor();assert.deepEqual(errors,[]);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const response=await fetch(new URL('/api/admission',f.net.admin.url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:ai.id,enabled:false})});assert.equal(response.status,403);
 }finally{await browser.close();await f.close();}
});
test('same-name AI instances require separate approval and have isolated request IDs and core session ownership',{timeout:30000},async()=>{
 const f=await admissionFixture();
 try{
  const first=await f.client('Same AI');const a=await f.row('ai','Same AI');const second=await f.client('Same AI');const b=await until(async()=>f.rows().find(row=>row.type==='ai'&&row.id!==a.id),Boolean) as ConnectionRow;assert.notEqual(a.id,b.id);
  const device=await f.row('device','Our Mac mini');await f.enable(device.id);await until(async()=>f.net.store.status(),status=>status.local_ready===true);await f.enable(a.id);
  const opened=completed(await f.request(first.client,'jev.open_session','same-request',{fixture_id:'standard'})),session_id=String(opened.session_id);
  denied(await f.submit(second.client,'jev.open_session','same-request',{fixture_id:'standard'}));assert.equal(f.rows().find(row=>row.id===b.id)!.enabled,false);
  await f.enable(b.id);
  assert.equal((await f.tool(second.client,'jev.request_status',{request_id:'same-request'})).code,'REQUEST_NOT_FOUND');
  const ownB=completed(await f.request(second.client,'jev.open_session','same-request',{fixture_id:'standard'}));assert.notEqual(ownB.session_id,session_id);assert.deepEqual(completed(await f.status(first.client,'same-request')),opened);
  const forbidden=await f.request(second.client,'jev.status','cross-owner',{session_id});assert.equal(forbidden.delivery_status,'COMPLETED');assert.equal(forbidden.reply?.ok,false);assert.equal(forbidden.reply?.error?.code,'UNAUTHORIZED');
  completed(await f.request(first.client,'jev.close_session','close-a',{session_id}));
  const nextB=completed(await f.request(second.client,'jev.open_session','fresh-b',{fixture_id:'standard'}));assert.notEqual(nextB.session_id,session_id);
  const third=await f.client('Same AI');denied(await f.submit(third.client,'jev.open_session','same-request',{fixture_id:'standard'}));
 }finally{await f.close();}
});
test('per-AI console off cancels and drains only its owner; re-enable creates a fresh owner and never replays old request',{timeout:30000},async()=>{
 const f=await admissionFixture();
 try{
  const {client}=await f.client(),{ai}=await f.approve();const originalGeneration=f.rows().find(row=>row.id===ai.id)!.generation;
  const session_id=String(completed(await f.request(client,'jev.open_session','off-open',{fixture_id:'standard'})).session_id),gate=f.provider.holdNext();
  const params={session_id,goal_id:'off-g',idempotency_key:'off-k',goal:{task:'form',language:'en',seed:211},success:{kind:'task_complete'}};
  await f.submit(client,'jev.run_goal','off-goal',params);await gate.entered;
  assert.equal((await f.admin('admission',{id:ai.id,enabled:false})).status,200);
  denied(await f.submit(client,'jev.run_goal','while-disabled',{...params,goal_id:'new-g',idempotency_key:'new-k'}));
  await until(async()=>Object.values(f.engine.ledger.state.goals),goals=>goals.length===1&&goals[0]!.status==='CANCELLED');assert.equal(f.browser.physical,0);
  await until(async()=>Object.values(f.engine.ledger.state.sessions),sessions=>sessions.every(session=>session.closed));
  await until(async()=>f.rows().find(row=>row.id===ai.id)!,row=>row.state!=='stopping');gate.release();await f.enable(ai.id);assert.ok(f.rows().find(row=>row.id===ai.id)!.generation>originalGeneration);
  const prior=completed(await f.request(client,'jev.run_goal','off-goal',params));assert.equal(prior.status,'CANCELLED');assert.equal(f.browser.physical,0);
  const oldOwner=await f.request(client,'jev.status','old-owner',{session_id});assert.equal(oldOwner.delivery_status,'COMPLETED',JSON.stringify(oldOwner));assert.equal(oldOwner.reply?.error?.code,'UNAUTHORIZED');
  const next=String(completed(await f.request(client,'jev.open_session','after-enable',{fixture_id:'standard'})).session_id);
  assert.equal(completed(await f.request(client,'jev.run_goal','after-enable-goal',{session_id:next,goal_id:'fresh-g',idempotency_key:'fresh-k',goal:{task:'select',language:'en',seed:212},success:{kind:'task_complete'}})).status,'SUCCEEDED');assert.equal(f.browser.physical,1);
 }finally{await f.close();}
});
test('device off revokes AI grants; session deletion/new same-name connection never inherits permission; labels cannot execute HTML',{timeout:30000},async()=>{
 const f=await admissionFixture(),browser=await chromium.launch({headless:true,executablePath:chromiumExecutable()});
 try{
  const first=await f.client(),{device,ai}=await f.approve();completed(await f.request(first.client,'jev.open_session','device-open',{fixture_id:'standard'}));
  await f.enable(device.id,false);assert.equal(f.rows().find(row=>row.id===ai.id)!.enabled,false);denied(await f.submit(first.client,'jev.open_session','device-disabled',{fixture_id:'standard'}));
  await until(async()=>Object.values(f.engine.ledger.state.sessions),sessions=>sessions.every(session=>session.closed));
  await until(async()=>f.rows().find(row=>row.id===ai.id)!,row=>row.state!=='stopping');
  await f.enable(device.id);assert.equal(f.rows().find(row=>row.id===ai.id)!.enabled,false);await f.enable(ai.id);
  await first.transport.terminateSession();await until(async()=>f.rows().find(row=>row.id===ai.id)!,row=>!row.enabled);
  const fresh=await f.client('Our AI');denied(await f.submit(fresh.client,'jev.open_session','new-session',{fixture_id:'standard'}));
  const label='<img data-pwn="1" src=x onerror="window.pwned=1">';await f.client(label);const page=await browser.newPage();await page.goto(f.net.admin.url);await page.getByText(label,{exact:true}).waitFor();assert.equal(await page.locator('[data-pwn]').count(),0);assert.equal(await page.evaluate(()=>Object.hasOwn(window,'pwned')),false);
  const rejected=await f.fetcher(f.net.url+'/api/admission',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:ai.id,enabled:true})});assert.equal(rejected.status,404);
  const malformed=await f.fetcher(f.net.url+'/connector/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Our Mac mini',device_id:'mac-manual',agent_id:'agent-manual',enabled:true})});assert.equal(malformed.status,400);
  const self=await f.tool(fresh.client,'jev.enable_connection',{id:ai.id,enabled:true});assert.match(String(self.code),/UNKNOWN_METHOD|ADMISSION_REQUIRED/);assert.equal(f.rows().find(row=>row.id===ai.id)!.enabled,false);
 }finally{await browser.close();await f.close();}
});

test('manual MCP lost reply recovers within the same connection without reapproval or repeated action',{timeout:25000},async()=>{
 const f=await admissionFixture();
 try{
  let drop=false;const cut:typeof fetch=async(input,init)=>{const response=await f.fetcher(input,init);if(drop&&typeof init?.body==='string'&&init.body.includes('manual-lost-reply')){drop=false;throw new TypeError('test lost response after acceptance');}return response;};
  const {client}=await f.client('Our AI',cut);await f.approve();const session_id=String(completed(await f.request(client,'jev.open_session','reply-open',{fixture_id:'standard'})).session_id);
  const params={session_id,goal_id:'reply-g',idempotency_key:'reply-k',goal:{task:'select',language:'en',seed:221},success:{kind:'task_complete'}};drop=true;await assert.rejects(f.submit(client,'jev.run_goal','manual-lost-reply',params));
  const row=await until(()=>f.status(client,'manual-lost-reply'),row=>row.delivery_status==='COMPLETED');assert.equal(completed(row).status,'SUCCEEDED');assert.equal(f.browser.physical,1);
  assert.deepEqual(completed(await f.request(client,'jev.run_goal','manual-lost-reply',params)),completed(row));assert.equal(f.browser.physical,1);
 }finally{await f.close();}
});
test('manual connector network loss drains original owners before restoring device intent and requires a fresh AI grant',{timeout:30000},async()=>{
 const f=await admissionFixture({proxy:true});
 try{
  const {client}=await f.client(),{device,ai}=await f.approve(),handle=f.connector!.registrationId();const session_id=String(completed(await f.request(client,'jev.open_session','lease-open',{fixture_id:'standard'})).session_id),gate=f.provider.holdNext();
  await f.submit(client,'jev.run_goal','lease-goal',{session_id,goal_id:'lease-g',idempotency_key:'lease-k',goal:{task:'form',language:'en',seed:231},success:{kind:'task_complete'}});await gate.entered;f.proxy.offline=true;
  await until(async()=>Object.values(f.engine.ledger.state.goals),goals=>goals.length===1&&goals[0]!.status==='CANCELLED',10000);assert.equal(f.browser.physical,0);assert.equal(f.rows().find(row=>row.id===ai.id)!.enabled,false);gate.release();
  f.proxy.offline=false;await until(async()=>f.rows().find(row=>row.id===ai.id)!,row=>row.state!=='stopping');assert.equal(f.connector!.registrationId(),handle,'same process keeps its device handle');await until(async()=>f.rows().find(row=>row.id===device.id)!,row=>row.enabled);assert.equal(f.rows().find(row=>row.id===ai.id)!.enabled,false,'device intent never restores the expired AI grant');assert.equal(f.browser.physical,0);
  await f.approve();const next=String(completed(await f.request(client,'jev.open_session','lease-new-open',{fixture_id:'standard'})).session_id);
  assert.equal(completed(await f.request(client,'jev.run_goal','lease-new-goal',{session_id:next,goal_id:'new-g',idempotency_key:'new-k',goal:{task:'select',language:'en',seed:232},success:{kind:'task_complete'}})).status,'SUCCEEDED');assert.equal(f.browser.physical,1);
 }finally{f.proxy.offline=false;await f.close();}
});
