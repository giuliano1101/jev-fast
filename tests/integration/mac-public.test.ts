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
