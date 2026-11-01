import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Engine} from '../../src/core/engine.js';
import {MockProvider} from '../../src/providers/mock.js';
import {BrowserAdapter} from '../../src/browser/adapter.js';
import {FixtureServer} from '../../fixtures/server.js';
import type {DecisionProvider,DecisionInput,DecisionContext,Goal,Candidate} from '../../src/core/contracts.js';
import {Coordinator} from '../../src/service/coordinator.js';

const req=(session_id:string)=>({session_id,goal_id:'goal',idempotency_key:'key',goal:{task:'form',language:'en',seed:1},success:{kind:'task_complete'},time_budget_ms:10000});
async function call(client:Client,name:string,args:Record<string,unknown>){const response=await client.callTool({name,arguments:args},undefined,{timeout:15000});const content=response.content as {type:string;text?:string}[];assert.equal(content[0]?.type,'text');return {error:response.isError===true,data:JSON.parse(content[0]!.text!) as Record<string,unknown>};}
async function setup(options:{shared?:boolean;provider?:DecisionProvider;fault?:boolean}={}){
 const dir=await mkdtemp('/tmp/jev-mcp-');const fixture=await FixtureServer.start();
 class FaultAdapter extends BrowserAdapter {executions=0;override async execute(id:string,candidate:Candidate,goal:Goal,signal:AbortSignal){this.executions++;await super.execute(id,candidate,goal,signal);throw new Error('response lost after physical action');}}
 const browser=options.fault?new FaultAdapter(fixture.origin):new BrowserAdapter(fixture.origin);
 const engine=await Engine.create({storageDir:join(dir,'ledger'),browser,provider:options.provider??new MockProvider(),clients:['a','b'],sharedAccess:options.shared?{a:['b']}:undefined});
 const service=await Coordinator.start({runtimeDir:join(dir,'run'),engine,clients:['a','b']});const clients:Client[]=[];
 try{
  for(const identity of ['a','b']){
   const client=new Client({name:`client-${identity}`,version:'1.0.0'});clients.push(client);
   const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/src/mcp/index.js'),'--credential',join(dir,`run/client-${identity}.json`)],stderr:'pipe'});
   await assert.doesNotReject(client.connect(transport),'actual SDK stdio client must connect');
  }
 }catch(error){await Promise.all(clients.map(c=>c.close()));await service.close();await browser.shutdown();await fixture.close();await rm(dir,{recursive:true,force:true});throw error;}
 return {a:clients[0]!,b:clients[1]!,browser,async cleanup(){await Promise.all(clients.map(c=>c.close()));await service.close();await browser.shutdown();await fixture.close();await rm(dir,{recursive:true,force:true});}};
}
test('two real MCP stdio clients share one local coordinator while keeping default identities isolated',{timeout:30000},async()=>{
 const f=await setup();try{
  const listed=await f.a.listTools();assert.equal(listed.tools.length,13);for(const tool of listed.tools)assert.equal(tool.inputSchema.additionalProperties,false);
  const opened=await call(f.a,'jev.open_session',{fixture_id:'standard'});assert.equal(opened.error,false);const session_id=String(opened.data.session_id);
  const second=await call(f.b,'jev.open_session',{fixture_id:'standard'});assert.equal(second.error,false);assert.notEqual(second.data.session_id,session_id);await call(f.b,'jev.close_session',{session_id:second.data.session_id});
  for(const name of ['jev.observe','jev.status','jev.close_session'])assert.equal((await call(f.b,name,{session_id})).data.code,'UNAUTHORIZED');
  assert.equal((await call(f.b,'jev.cancel',{session_id,goal_id:'goal'})).data.code,'UNAUTHORIZED');
  assert.equal((await call(f.a,'jev.observe',{session_id,client_id:'b'})).data.code,'INVALID_ARGUMENTS');
  assert.equal((await call(f.a,'jev.open_session',{fixture_id:'standard',url:'https://external.invalid'})).data.code,'INVALID_ARGUMENTS');
  assert.equal((await call(f.a,'jev.shell',{shell:'whoami'})).data.code,'UNKNOWN_METHOD');
  const observed=await call(f.a,'jev.observe',{session_id});assert.ok(observed.data.snapshot_id);
  const result=await call(f.a,'jev.run_goal',req(session_id));assert.equal(result.data.status,'SUCCEEDED');
  const repeat=await call(f.a,'jev.run_goal',req(session_id));assert.deepEqual(repeat.data,result.data);
  const action_id=(result.data.action_ids as string[])[0];assert.ok(action_id);assert.equal((await call(f.a,'jev.status',{session_id,action_id})).data.status,'SUCCEEDED');
  assert.equal((await call(f.a,'jev.close_session',{session_id})).data.closed,true);
 }finally{await f.cleanup();}
});
test('server ACL permits deliberate two-client BUSY and cancellation without overlapping actions',{timeout:30000},async()=>{
 let entered!:()=>void;const deciding=new Promise<void>(resolve=>{entered=resolve;});
 const provider:DecisionProvider={async decide(_input:DecisionInput,context:DecisionContext){entered();await new Promise<void>((_resolve,reject)=>{context.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});throw new Error('unreachable');}};
 const f=await setup({shared:true,provider});try{
  const opened=await call(f.a,'jev.open_session',{fixture_id:'standard'});const session_id=String(opened.data.session_id);
  const first=call(f.a,'jev.run_goal',req(session_id));await deciding;
  assert.equal((await call(f.b,'jev.run_goal',{...req(session_id),goal_id:'other',idempotency_key:'other'})).data.code,'BUSY');
  assert.equal((await call(f.b,'jev.observe',{session_id})).data.code,'BUSY');
  const cancelled=await call(f.b,'jev.cancel',{session_id,goal_id:'goal'});assert.equal(cancelled.data.status,'CANCELLED');assert.equal(cancelled.data.unknown_action,false);
  assert.equal((await first).data.status,'CANCELLED');assert.equal((await call(f.a,'jev.status',{session_id})).data.busy,false);
  await call(f.a,'jev.close_session',{session_id});
 }finally{await f.cleanup();}
});
test('MCP queries UNKNOWN physical-action outcome and idempotent retry never replays',{timeout:30000},async()=>{
 const f=await setup({fault:true});try{
  const opened=await call(f.a,'jev.open_session',{fixture_id:'standard'});const session_id=String(opened.data.session_id);
  const result=await call(f.a,'jev.run_goal',req(session_id));assert.equal(result.data.status,'UNKNOWN');
  const action_id=(result.data.action_ids as string[])[0];assert.equal((await call(f.a,'jev.status',{session_id,action_id})).data.status,'UNKNOWN');
  assert.deepEqual((await call(f.a,'jev.run_goal',req(session_id))).data,result.data);
  assert.equal((f.browser as BrowserAdapter&{executions:number}).executions,1);
  assert.equal((await call(f.a,'jev.run_goal',{...req(session_id),goal_id:'new',idempotency_key:'new'})).data.code,'QUARANTINED');
  assert.equal((await call(f.a,'jev.close_session',{session_id})).data.quarantined,true);
 }finally{await f.cleanup();}
});
