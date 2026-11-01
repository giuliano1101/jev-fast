import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Coordinator,type CoordinatorOptions} from '../../src/service/coordinator.js';
import {ipcCall,readCredential} from '../../src/service/ipc.js';
import {parseTool,toolDefinitions} from '../../src/service/contracts.js';
import type {Engine} from '../../src/core/engine.js';
const args={idempotency_key:'new-choice',task:'Search a real public website',state:{page:'https://example.org',search:''},actions:[{id:'search',description:'Fill the visible search input'}]};
async function setup(chooseAction?:(client:string,args:unknown,signal:AbortSignal)=>Promise<unknown>,realBrowser?:object){
 const dir=await mkdtemp(join(tmpdir(),'jev-choice-ipc-'));const owners=new Set(['a','b']);const engine={authorizeClient(client:string){if(!owners.has(client))throw new Error('UNAUTHORIZED');},async reconcileNetworkOwners(next:string[]){for(const owner of [...owners])if(owner.startsWith('network-'))owners.delete(owner);for(const owner of next)owners.add(owner);return {owners:next};},async revokeNetworkOwner(owner:string){owners.delete(owner);},async kill(){},async shutdown(){}} as unknown as Engine;
 const options={runtimeDir:dir,engine,clients:['a','b'],chooseAction,realBrowser} as CoordinatorOptions;
 const service=await Coordinator.start(options);return {dir,service,a:await readCredential(join(dir,'client-a.json')),b:await readCredential(join(dir,'client-b.json')),close:async()=>{await service.close();await rm(dir,{recursive:true,force:true});}};
}
test('facade accepts general real-host choices without fixture task whitelist or64candidate cap',()=>{
 assert.ok(toolDefinitions.some(t=>t.name==='jev.choose_action'));
 const many={...args,actions:Array.from({length:129},(_,n)=>({id:'action-'+n,description:'Visible application action '+n}))};
 assert.deepEqual(parseTool('jev.choose_action',many),many);
 assert.throws(()=>parseTool('jev.choose_action',{...args,caller_scope:'other'}),/INVALID_ARGUMENTS/);
});
test('general choices need no browser session and run concurrently with authenticated caller scopes',async()=>{
 const scopes:string[]=[],releases:(()=>void)[]=[];let entered!:()=>void;const both=new Promise<void>(r=>entered=r);
 const f=await setup(async(client)=>{scopes.push(client);if(scopes.length===2)entered();await new Promise<void>(r=>releases.push(r));return {provider:'jev',selected_id:'search'};});
 try{const a=ipcCall(f.a,'jev.choose_action',args),b=ipcCall(f.b,'jev.choose_action',{...args,idempotency_key:'second'});await Promise.race([both,Promise.all([a,b]).then(()=>{throw new Error("CALLS_ENDED_WITHOUT_CONCURRENCY");})]);assert.deepEqual(new Set(scopes),new Set(['a','b']));releases.forEach(r=>r());assert.equal((await a as {selected_id:string}).selected_id,'search');await b;const health=await ipcCall(f.a,'service.health',{}) as {active_session_limit:number|null;general_choice_available:boolean};assert.equal(health.active_session_limit,null);assert.equal(health.general_choice_available,true);}finally{releases.forEach(r=>r());await f.close();}
});
test('network revocation cancels a general decision without granting caller-supplied ownership',async()=>{
 let began!:()=>void;const ready=new Promise<void>(r=>began=r);const owner='network-'+'a'.repeat(64);
 const f=await setup(async(client,_args,signal)=>{assert.equal(client,owner);began();await new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('CANCELLED')),{once:true}));});
 try{await ipcCall(f.a,'service.network_reconcile',{owners:[owner]});const request=ipcCall(f.a,'service.network_dispatch',{owner,method:'jev.choose_action',params:args});const rejected=assert.rejects(request);await Promise.race([ready,request.then(()=>{throw new Error("DECISION_NOT_ENTERED");})]);await ipcCall(f.a,'service.network_revoke',{owner});await rejected;await assert.rejects(ipcCall(f.a,'service.network_dispatch',{owner,method:'jev.choose_action',params:args}));}finally{await f.close();}
});
test('unconfigured offline service reports unavailable without silently enabling hosted choice',async()=>{const f=await setup();try{await assert.rejects(ipcCall(f.a,'jev.choose_action',args),/GENERAL_CHOICE_UNAVAILABLE/);}finally{await f.close();}});

test('remote browser tools route actual URL to the configured owner-scoped executor',async()=>{
 const seen:unknown[]=[];const browser={async open(client:string,args:unknown){seen.push({client,args});return {session_id:'real-session'};},async revokeOwner(){},async shutdown(){}};const f=await setup(undefined,browser);
 try{const opened=await ipcCall(f.a,'jev.browser_open',{url:'https://example.org/real-page'});assert.deepEqual(opened,{session_id:'real-session'});assert.deepEqual(seen,[{client:'a',args:{url:'https://example.org/real-page'}}]);}finally{await f.close();}
});
