import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {FixtureServer} from '../../fixtures/server.js';
import {BrowserAdapter} from '../../src/browser/adapter.js';
import {Engine} from '../../src/core/engine.js';
import {Coordinator} from '../../src/service/coordinator.js';
import {readCredential,ipcCall} from '../../src/service/ipc.js';
import {makeRemoteCertificates,remoteFixture} from '../helpers/remote-fixture.js';

test('two logical devices execute separate browsers through one TLS gateway and preserve independent local coordinator semantics',{timeout:40000},async()=>{
 const certs=makeRemoteCertificates(),gateway=await remoteFixture(certs),root=await mkdtemp('/tmp/jev-devices-');
 const resources:Array<{fixture:FixtureServer;browser:BrowserAdapter;engine:Engine;service:Coordinator;runtime:string}>=[];let gatewayClosed=false;
 try{
  for(const id of ['a','b'] as const){
   const fixture=await FixtureServer.start(),browser=new BrowserAdapter(fixture.origin),runtime=join(root,id);
   const engine=await Engine.create({storageDir:join(runtime,'ledger'),browser,provider:gateway.client(id),clients:['a'],remotePolicy:{publicKey:gateway.keys.publicKey,issuer:'gateway',audience:'executor',identity:gateway.identities[id],enforcementMode:'test_mock'}});
   const service=await Coordinator.start({runtimeDir:runtime,engine,clients:['a']});
   resources.push({fixture,browser,engine,service,runtime});
  }
  const [a,b]=resources;
  const call=async(i:number,name:string,args:Record<string,unknown>)=>{try{return {error:undefined,data:await ipcCall(await readCredential(join(resources[i]!.runtime,'client-a.json')),'jev.'+name,args) as Record<string,unknown>};}catch{return {error:true,data:{} as Record<string,unknown>};}};
  const opened=await Promise.all([call(0,'open_session',{fixture_id:'standard'}),call(1,'open_session',{fixture_id:'standard'})]);
  const sessions=opened.map(r=>String(r.data.session_id));assert.notEqual(sessions[0],sessions[1]);assert.notEqual(a!.fixture.origin,b!.fixture.origin);
  for(const name of ['observe','status','cancel'])assert.equal((await call(1,name,{session_id:sessions[0],...(name==='cancel'?{goal_id:'goal'}:{})})).error,true);
  const req=(session_id:string,seed:number)=>({session_id,goal_id:'goal',idempotency_key:'key',goal:{task:'form',language:'en',seed},success:{kind:'task_complete'},time_budget_ms:10000});
  const results=await Promise.all(sessions.map((s,i)=>call(i,'run_goal',req(s,i+1))));
  for(const [i,result] of results.entries()){
   assert.equal(result.data.status,'SUCCEEDED');assert.equal(result.error,undefined);
   const state=resources[i]!.engine.ledger.state;
   assert.ok(Object.values(state.actions).length>0);
   for(const action of Object.values(state.actions)){assert.equal(action.session_id,sessions[i]);assert.equal(action.receipt?.device_id,i===0?'device-a':'device-b');assert.equal(action.receipt?.route,'mock');}
   // Repeated local calls return the identical durable result.
   const credential=await readCredential(join(resources[i]!.runtime,'client-a.json'));
   const repeated=await ipcCall(credential,'jev.run_goal',req(sessions[i]!,i+1));assert.deepEqual(repeated,result.data);
   assert.equal(Object.keys(resources[i]!.engine.ledger.state.actions).length,Object.keys(state.actions).length);
  }
  await gateway.close();gatewayClosed=true;
  for(const [i,r] of resources.entries()){
   assert.equal((await call(i,'status',{session_id:sessions[i],goal_id:'goal'})).data.status,'SUCCEEDED');
   await r.engine.kill();await assert.rejects(r.engine.openSession('a',{fixture_id:'standard'}),/KILLED/);
  }
 }finally{
  for(const r of resources.reverse()){await r.service.close();await r.browser.shutdown();await r.fixture.close();}
  if(!gatewayClosed)await gateway.close();certs.close();await rm(root,{recursive:true,force:true});
 }
});
