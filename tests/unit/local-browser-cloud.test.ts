import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setImmediate} from 'node:timers/promises';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import {signChoiceResponse} from '../../src/remote/choice.js';
import type {ChoiceArgs} from '../../src/choice/contracts.js';
import {PublicJevCloud} from '../../src/local/cloud.js';
const args:ChoiceArgs={idempotency_key:'idem',task:'type',state:{page:'observed'},actions:[{id:'type',description:'Type text'}]};
function fixture(options:{holdInitialize?:boolean}={}){
 const directory=mkdtempSync(join(tmpdir(),'jev-local-cloud-')),dir=join(directory,'state'),keys=generateKeyPairSync('ed25519'),calls:{name:string;args:Record<string,unknown>}[]=[];let invalid=false,chooseCalls=0,lose=false;let response:unknown;
 let releaseInitialize!:()=>void,initializeEntered!:()=>void;const initializeGate=new Promise<void>(resolve=>{releaseInitialize=resolve;}),entered=new Promise<void>(resolve=>{initializeEntered=resolve;}),methods:string[]=[];
 const transport:Transport={start:async()=>{},close:async()=>{},send:async(message:JSONRPCMessage|JSONRPCMessage[])=>{
  if(Array.isArray(message)||!('method'in message))return;methods.push(message.method);if(!('id'in message))return;let result:Record<string,unknown>;
  if(message.method==='initialize'){initializeEntered();if(options.holdInitialize)await initializeGate;result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'offline-public-stub',version:'1'}};}
  else if(message.method==='tools/list')result={tools:[{name:'jev.choose_action',inputSchema:{type:'object'}}]};
  else{const params=message.params as {name:string;arguments:Record<string,unknown>};calls.push({name:params.name,args:params.arguments});
   let value:unknown;
   if(invalid)value={code:'CONTINUATION_INVALID'};
   else if(params.name==='jev.network_status')value={enabled:true,connector_online:true,local_ready:true,continuation_supported:true,continuation_token:'PRIVATE_CONTINUATION'};
   else if(params.name==='jev.choose_action'){chooseCalls++;response=signChoiceResponse(params.arguments.params as ChoiceArgs,{provider:'jev',model:'jev-1.14.0',selected_id:'type',confidence:1,usage:null},{privateKey:keys.privateKey,issuer:'stub',audience:'stub',identity:{owner_id:'stub',agent_id:'stub',device_id:'stub'},caller_scope:'stub'});value={delivery_status:'QUEUED'};}
   else if(params.name==='jev.request_status')value={delivery_status:'COMPLETED',reply:{ok:true,result:response}};
   else value={released:true};
   if(lose&&params.name==='jev.choose_action'){lose=false;throw Error('response lost');}
   result={content:[{type:'text',text:JSON.stringify(value)}],...(invalid?{isError:true}:{})};
  }
  queueMicrotask(()=>transport.onmessage?.({jsonrpc:'2.0',id:message.id,result}));
 }};
 const cloud=new PublicJevCloud({stateDir:dir,endpoint:'http://127.0.0.1/mcp',transportFactory:()=>transport,pollIntervalMs:1});
 return {cloud,calls,dir,methods,entered,releaseInitialize,get chooseCalls(){return chooseCalls;},invalidate(){invalid=true;},loseChoose(){lose=true;},async close(){await cloud.close();rmSync(directory,{recursive:true,force:true});}};
}
test('cloud uses same request id to poll, privately caches continuation and only asks public Jev to choose',async()=>{
 const f=fixture();try{const status=await f.cloud.status();assert.equal(status.ready,true);assert.equal(JSON.stringify(status).includes('PRIVATE_CONTINUATION'),false);assert.equal((await f.cloud.choose(args,new AbortController().signal)).provider,'jev');assert.equal(f.chooseCalls,1);
 const choose=f.calls.find(call=>call.name==='jev.choose_action')!,poll=f.calls.find(call=>call.name==='jev.request_status')!;assert.equal(choose.args.request_id,poll.args.request_id);for(const call of f.calls.slice(1))assert.equal(call.args.continuation_token,'PRIVATE_CONTINUATION');assert.equal(f.calls.some(call=>call.name.startsWith('jev.browser')),false);
 const audit=readFileSync(join(f.dir,'cloud-requests.jsonl'),'utf8');assert.ok(audit.includes(String(choose.args.request_id)));assert.equal(audit.includes('PRIVATE_CONTINUATION'),false);assert.equal(audit.includes('observed'),false);
 }finally{await f.close();}
});
test('invalid continuation stays closed and cannot initialize a replacement identity',async()=>{
 const f=fixture();try{await f.cloud.status();f.invalidate();assert.equal((await f.cloud.status()).ready,false);assert.equal((await f.cloud.status()).code,'CONTINUATION_INVALID');await assert.rejects(f.cloud.choose(args,new AbortController().signal),/CONTINUATION_INVALID/);assert.equal(f.chooseCalls,0);assert.equal(f.calls.filter(call=>call.name==='jev.network_status'&&!call.args.continuation_token).length,1);}finally{await f.close();}
});

test('lost choose response queries the original request and never resubmits a decision',async()=>{
 const f=fixture();try{await f.cloud.status();f.loseChoose();assert.equal((await f.cloud.choose(args,new AbortController().signal)).selected_id,'type');assert.equal(f.chooseCalls,1);const choose=f.calls.find(call=>call.name==='jev.choose_action')!,poll=f.calls.find(call=>call.name==='jev.request_status')!;assert.equal(choose.args.request_id,poll.args.request_id);}finally{await f.close();}
});

test('concurrent first status and action wait for initialization before sending any business request',async()=>{
 const f=fixture({holdInitialize:true});const first=f.cloud.status();await f.entered;const action=f.cloud.choose(args,new AbortController().signal);
 try{await setImmediate();assert.deepEqual(f.methods,['initialize'],'neither network_status nor choose_action may bypass pending initialize');f.releaseInitialize();const [status,decision]=await Promise.all([first,action]);assert.equal(status.ready,true);assert.equal(decision.selected_id,'type');assert.equal(f.chooseCalls,1);assert.ok(f.methods.indexOf('notifications/initialized')<f.methods.indexOf('tools/call'));}
 finally{f.releaseInitialize();await Promise.allSettled([first,action]);await f.close();}
});
