import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../../src/core/engine.js';
import {MockProvider} from '../../src/providers/mock.js';
import type {BrowserPort,Snapshot} from '../../src/core/contracts.js';
class AdmissionBrowser implements BrowserPort {
 gate?:Promise<void>;closes=0;closeError=false;
 async open(){await this.gate;return {allowed_origin:'http://127.0.0.1:7777'};}
 async observe():Promise<Snapshot>{throw new Error('unexpected observe');}
 async validate():Promise<boolean>{throw new Error('unexpected validate');}
 async execute(){throw new Error('unexpected execute');}
 async check():Promise<boolean>{throw new Error('unexpected check');}
 async close(){this.closes++;if(this.closeError)throw new Error('close failed');}
}
test('network grants are distinct owners, revoke drains pending opens and never reactivates a generation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-admission-owner-')),browser=new AdmissionBrowser();
 const engine=await Engine.create({storageDir:dir,browser,provider:new MockProvider(),clients:['a','b']});
 const api=engine as Engine & {grantNetworkOwner(owner:string):void;revokeNetworkOwner(owner:string):Promise<void>};
 try{
  assert.equal(typeof api.grantNetworkOwner,'function','network owner grant is missing');
  const owner='network-'+ 'a'.repeat(64);api.grantNetworkOwner(owner);
  let release!:()=>void;browser.gate=new Promise<void>(done=>release=done);
  const open=engine.openSession(owner,{fixture_id:'standard'});const rejected=assert.rejects(open,/UNAUTHORIZED/);
  let drained=false;const revoke=api.revokeNetworkOwner(owner).then(()=>{drained=true;});
  await new Promise(done=>setImmediate(done));assert.equal(drained,false,'pending open must drain before revoke acknowledges');
  release();await rejected;await revoke;assert.equal(browser.closes,1);
  assert.throws(()=>api.grantNetworkOwner(owner),/OWNER_REVOKED/);
  await assert.rejects(engine.openSession(owner,{fixture_id:'standard'}),/UNAUTHORIZED/);
  browser.gate=undefined;const own=await engine.openSession('a',{fixture_id:'standard'});
  const next='network-'+'b'.repeat(64);api.grantNetworkOwner(next);
  await assert.rejects(engine.status(next,{session_id:own.session_id}),/UNAUTHORIZED/);
  await api.revokeNetworkOwner(next);assert.equal((await engine.status('a',{session_id:own.session_id}) as {closed:boolean}).closed,false);
 }finally{await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});
test('historical owner count never prevents admitting a fresh owner or revoking an old generation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-admission-cap-')),browser=new AdmissionBrowser();const engine=await Engine.create({storageDir:dir,browser,provider:new MockProvider(),clients:['a']});
 try{
  for(let index=0;index<9999;index++){const owner='network-'+index.toString(16).padStart(64,'0');engine.grantNetworkOwner(owner);await engine.revokeNetworkOwner(owner);}
  const last='network-'+'f'.repeat(64);engine.grantNetworkOwner(last);await engine.revokeNetworkOwner(last);
  await assert.rejects(engine.openSession(last,{fixture_id:'standard'}),/UNAUTHORIZED/);assert.doesNotThrow(()=>engine.grantNetworkOwner('network-'+'e'.repeat(64)));
 }finally{await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});
test('reconciliation joins an already running lease revocation before acknowledging its drain',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-admission-race-')),browser=new AdmissionBrowser();const engine=await Engine.create({storageDir:dir,browser,provider:new MockProvider(),clients:['a']});
 let release!:()=>void;
 try{
  const owner='network-'+'c'.repeat(64);engine.grantNetworkOwner(owner);browser.gate=new Promise<void>(done=>release=done);
  const open=engine.openSession(owner,{fixture_id:'standard'}),rejected=assert.rejects(open,/UNAUTHORIZED/);const first=engine.revokeNetworkOwner(owner);
  let drained=false;const reconcile=engine.reconcileNetworkOwners([]).then(()=>{drained=true;});await new Promise(done=>setImmediate(done));const observed=drained;
  release();await rejected;await first;await reconcile;assert.equal(observed,false);assert.equal(browser.closes,1);
 }finally{release?.();await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});
test('failed owner cleanup stays pending until a successful reconciliation retry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-admission-cleanup-')),browser=new AdmissionBrowser();const engine=await Engine.create({storageDir:dir,browser,provider:new MockProvider(),clients:['a']});
 try{
  const owner='network-'+'d'.repeat(64);engine.grantNetworkOwner(owner);await engine.openSession(owner,{fixture_id:'standard'});browser.closeError=true;
  await assert.rejects(engine.revokeNetworkOwner(owner),/close failed/);await assert.rejects(engine.reconcileNetworkOwners([]),/close failed/);
  browser.closeError=false;await engine.reconcileNetworkOwners([]);assert.equal(browser.closes,3);
 }finally{browser.closeError=false;await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});
test('failed pre-ledger open cleanup remains owned and must drain before revocation acknowledgment',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-admission-orphan-')),browser=new AdmissionBrowser();const engine=await Engine.create({storageDir:dir,browser,provider:new MockProvider(),clients:['a']});let release!:()=>void;
 try{
  const owner='network-'+'e'.repeat(64);engine.grantNetworkOwner(owner);browser.gate=new Promise<void>(done=>release=done);browser.closeError=true;
  const open=engine.openSession(owner,{fixture_id:'standard'}),openFailed=assert.rejects(open,/close failed|cleanup failed/);
  const revoke=engine.revokeNetworkOwner(owner),drainFailed=assert.rejects(revoke,/close failed/);release();await openFailed;await drainFailed;
  assert.equal(Object.keys(engine.ledger.state.sessions).length,0);assert.ok((await engine.openSession('a',{fixture_id:'standard'})).session_id);
  browser.closeError=false;await engine.reconcileNetworkOwners([]);assert.equal(browser.closes,3);
  browser.gate=undefined;await engine.openSession('a',{fixture_id:'standard'});
 }finally{release?.();browser.closeError=false;await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});
test('allocated open cleanup retries physical close even after its ledger row was fenced closed',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-admission-allocated-')),browser=new AdmissionBrowser();const engine=await Engine.create({storageDir:dir,browser,provider:new MockProvider(),clients:['a']});let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(done=>entered=done),gate=new Promise<void>(done=>release=done);
 const transaction=engine.ledger.transaction.bind(engine.ledger);let first=true;t.mock.method(engine.ledger,'transaction',async (change:Parameters<typeof engine.ledger.transaction>[0])=>{await transaction(change);if(first){first=false;entered();await gate;}});
 try{
  const owner='network-'+'f'.repeat(64);engine.grantNetworkOwner(owner);browser.closeError=true;
  const open=engine.openSession(owner,{fixture_id:'standard'}),openFailed=assert.rejects(open,/close failed/);await waiting;
  const revoke=engine.revokeNetworkOwner(owner),drainFailed=assert.rejects(revoke,/close failed/);release();await openFailed;await drainFailed;
  assert.equal(Object.values(engine.ledger.state.sessions)[0]!.closed,true);
  await assert.rejects(engine.reconcileNetworkOwners([]),/close failed/);browser.closeError=false;await engine.reconcileNetworkOwners([]);assert.equal(browser.closes,4);
 }finally{release?.();browser.closeError=false;await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('owner revocation drains extension executors before acknowledging and retries failures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-owner-extension-'));let entered!:()=>void,release!:()=>void,calls=0;const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const options={storageDir:dir,browser:new AdmissionBrowser(),provider:new MockProvider(),clients:['a'],onOwnerRevoked:async(owner:string)=>{assert.equal(owner,'network-'+'a'.repeat(64));calls++;entered();await gate;if(calls===1)throw new Error('extension close failed');}};
 const engine=await Engine.create(options),owner='network-'+'a'.repeat(64);engine.grantNetworkOwner(owner);
 try{let settled=false;const revoking=engine.revokeNetworkOwner(owner);const failed=assert.rejects(revoking,/extension close failed/);void revoking.finally(()=>{settled=true;}).catch(()=>{});await enteredPromise;assert.equal(settled,false);await assert.rejects(engine.openSession(owner,{fixture_id:'standard'}),/UNAUTHORIZED/);release();await failed;await engine.reconcileNetworkOwners([]);assert.equal(calls,2);}finally{release();await engine.shutdown();await rm(dir,{recursive:true,force:true});}
});
