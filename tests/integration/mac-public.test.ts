import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {admissionFixture} from '../helpers/admission-fixture.js';
import {until} from '../helpers/network-fixture.js';
import {startFront,rawClient} from '../../src/mac-public/http.js';
import type {Job} from '../../src/mac-public/jobs.js';
test('front preserves actual relay continuation across DELETE and prevents Mac/legacy collisions in both orders',async()=>{
 const f=await admissionFixture({autoAdmitAi:true,allowContinuations:true});const clients:Client[]=[],jobs=new Map<string,Job>();let posts=0;
 const front=await startFront({stateDir:join(f.root,'front'),port:0,upstream:rawClient({url:f.net.url,ca:f.certs.ca}),mac:{submit:async job=>{posts++;const complete={...job,delivery_status:'COMPLETED' as const,reply:{ok:true,result:{host:'mac',tools:[]}}};jobs.set(job.request_id,complete);return complete;},get:async id=>jobs.get(id)!},macHealth:async()=>true});
 async function connect(name:string){const transport=new StreamableHTTPClientTransport(new URL(front.url+'/mcp')),client=new Client({name,version:'1.0.0'});await client.connect(transport);clients.push(client);return {client,transport};}
 try{const device=await f.row('device','Our Mac mini');await f.enable(device.id);await until(async()=>f.net.store.status(),row=>row.local_ready);
  const first=await connect('first'),status=await f.tool(first.client,'jev.network_status'),token=status.continuation_token;assert.equal(typeof token,'string');assert.deepEqual(status.available_hosts,['android','mac']);const context={continuation_token:token};
  const macAck=await f.tool(first.client,'jev.host_tools',{...context,request_id:'mac-first',params:{host:'desktop'}});assert.equal(macAck.delivery_status,'DISPATCHED');await until(()=>f.tool(first.client,'jev.request_status',{...context,request_id:'mac-first'}),row=>row.delivery_status==='COMPLETED');
  await first.transport.terminateSession();const second=await connect('different label');assert.equal((await f.tool(second.client,'jev.network_status',context)).connection_id,status.connection_id);assert.equal((await f.tool(second.client,'jev.request_status',{...context,request_id:'mac-first'})).delivery_status,'COMPLETED');
  const collision=await f.tool(second.client,'jev.open_session',{...context,request_id:'mac-first',params:{fixture_id:'standard'}});assert.equal(collision.code,'IDEMPOTENCY_CONFLICT');
  await f.tool(second.client,'jev.open_session',{...context,request_id:'legacy-first',params:{fixture_id:'standard'}});await until(()=>f.tool(second.client,'jev.request_status',{...context,request_id:'legacy-first'}),row=>row.delivery_status==='COMPLETED');
  const reversed=await f.tool(second.client,'jev.host_tools',{...context,request_id:'legacy-first',params:{host:'mac'}});assert.equal(reversed.code,'IDEMPOTENCY_CONFLICT');assert.equal(posts,1);
  const independent=await connect('same name, independent owner');assert.equal((await f.tool(independent.client,'jev.request_status',{request_id:'mac-first'})).code,'REQUEST_NOT_FOUND');
  assert.equal((await f.tool(second.client,'jev.release_connection',context)).released,true);assert.equal((await f.tool(second.client,'jev.request_status',{...context,request_id:'mac-first'})).code,'CONTINUATION_INVALID');
 }finally{for(const client of clients)await client.close().catch(()=>{});await front.close();await f.close();}
});
import {writeFile} from 'node:fs/promises';
import {generateKeyPairSync} from 'node:crypto';
import {startMac} from '../../src/mac-public/main.js';
import {signChoiceResponse} from '../../src/remote/choice.js';
test('owned sidecar becomes unhealthy on fake native crash; supervised restart preserves UNKNOWN and accepts only a new intent',async()=>{
 const f=await admissionFixture({connector:false}),keys=generateKeyPairSync('ed25519'),secret='private-offline-capability-'.repeat(2),capabilityFile=join(f.root,'mac-capability');await writeFile(capabilityFile,secret,{mode:0o600});
 const fake=(crash:boolean)=>`import{createInterface}from'node:readline';const r=createInterface({input:process.stdin});r.on('line',line=>{const q=JSON.parse(line);if(!('id'in q))return;let result;if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'offline-native',version:'1'}};else if(q.method==='tools/list')result={tools:[{name:'desktop_status',inputSchema:{type:'object'}}]};else if(q.method==='tools/call'){${crash?'process.exit(9);':'result={content:[{type:"text",text:"offline independent action completed"}]};'}}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`;
 const config={listenHost:'127.0.0.1' as const,port:0,stateDir:join(f.root,'mac'),capabilityFile,publicEndpoint:'https://example.invalid/mcp',credentialFile:join(f.runtime,'client-a.json'),desktopCommand:process.execPath,desktopArgs:['--input-type=module','-e',fake(true)]};
 const dependencies={validator:{validate:async()=>({owner:'owner',token:'token'}),close:async()=>{}},chooseAction:async(owner:string,args:Parameters<typeof signChoiceResponse>[0])=>signChoiceResponse(args,{provider:'jev',model:'jev-1.14.0',selected_id:'read',confidence:1,usage:null},{privateKey:keys.privateKey,issuer:'test',audience:'mac',identity:{owner_id:'owner',agent_id:'agent',device_id:'mac'},caller_scope:owner})};
 let mac=await startMac(config,dependencies);
 const params={host:'mac',idempotency_key:'crashed',task:'offline read',state:{},actions:[{id:'read',tool:'desktop_status',arguments:{},description:'read'}]};
 try{const old=mac.store.claim('owner','crashed','jev.host_act',params,'token').job;mac.executor.submit(old);await mac.failure;const address=mac.server.address();assert.ok(address&&typeof address!=='string');const health=await fetch(`http://127.0.0.1:${address.port}/health`,{headers:{'x-jev-mac-capability':secret}});assert.equal(health.status,503);await mac.close();mac=await startMac({...config,desktopArgs:['--input-type=module','-e',fake(false)]},dependencies);assert.equal(mac.store.get(old.request_id)?.delivery_status,'UNKNOWN');assert.equal(mac.store.all().length,1,'restart must not resubmit the failed physical intent');const fresh=mac.store.claim('owner','independent','jev.host_act',{...params,idempotency_key:'independent'},'token').job;mac.executor.submit(fresh);const result=await until(async()=>mac.store.get(fresh.request_id)!,job=>job.delivery_status==='COMPLETED');assert.equal((result.reply as {result:{execution:string}}).result.execution,'executed');assert.equal(mac.store.get(old.request_id)?.delivery_status,'UNKNOWN');}finally{await mac.close().catch(()=>{});await f.close();}
});
