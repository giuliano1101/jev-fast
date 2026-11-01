import test from 'node:test';
import assert from 'node:assert/strict';
import {networkToolDefinitions} from '../../src/network/protocol.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {makeRemoteCertificates} from '../helpers/remote-fixture.js';
import {verifiedFetch} from '../helpers/network-fixture.js';
test('manual MCP keeps stateful connections disabled by default, namespaces results and expires sessions',async()=>{
 const path='../../src/network/manual-server.js',api=await import(path).catch(()=>({}));assert.equal(typeof api.startManualNetworkServer,'function','manual server is missing');
 const root=await mkdtemp(join(tmpdir(),'jev-admission-server-')),certs=makeRemoteCertificates();
 const net=await api.startManualNetworkServer({host:'127.0.0.1',port:0,allowedOrigins:[],deviceId:'d',agentId:'a',storeDir:root,tls:certs.server,sessionTtlMs:5000});
 const clients:Client[]=[];const transports:StreamableHTTPClientTransport[]=[];const fetcher=verifiedFetch(certs.ca);
 async function client(){const c=new Client({name:'same label',version:'1'});const transport=new StreamableHTTPClientTransport(new URL(net.url+'/mcp'),{fetch:fetcher});transports.push(transport);await c.connect(transport);clients.push(c);return c;}
 async function tool(c:Client,name:string,args:Record<string,unknown>={}){const result=await c.callTool({name,arguments:args});return JSON.parse((result.content as {text:string}[])[0]!.text);}
 try{
  const a=await client(),b=await client();assert.equal((await a.listTools()).tools.length,networkToolDefinitions.length);
  assert.equal((await tool(a,'jev.open_session',{request_id:'same',params:{fixture_id:'standard'}})).code,'ADMISSION_REQUIRED');
  assert.equal((await tool(a,'jev.network_status')).admission,'pending');
  const device=net.registry.register('device','Mac');net.registry.updateDeviceInstance(device.id,'11111111-1111-4111-8111-111111111111');net.registry.setEnabled(device.id,true);
  const ais=net.registry.list().filter((r:{type:string})=>r.type==='ai');assert.equal(ais.length,2);net.registry.setEnabled(ais[0].id,true);net.registry.setEnabled(ais[1].id,true);
  const ea=await tool(a,'jev.open_session',{request_id:'same',params:{fixture_id:'standard'}}),eb=await tool(b,'jev.open_session',{request_id:'same',params:{fixture_id:'standard'}});assert.equal(ea.request_id,'same');assert.equal(eb.request_id,'same');
  assert.equal((await tool(a,'jev.request_status',{request_id:'missing'})).code,'REQUEST_NOT_FOUND');
  const c=await client();assert.equal((await tool(c,'jev.request_status',{request_id:'same'})).code,'ADMISSION_REQUIRED');
  await transports[0]!.terminateSession();assert.equal(net.registry.get(ais[0].id).enabled,false);
 }finally{for(const c of clients)await c.close().catch(()=>{});await net.close();certs.close();await rm(root,{recursive:true,force:true});}
});
