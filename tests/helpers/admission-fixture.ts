import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {makeRemoteCertificates} from './remote-fixture.js';
import {CountingBrowser,HoldingProvider,verifiedFetch,until,runLocalCli,faultProxy,type NetworkEnvelope} from './network-fixture.js';
import {FixtureServer} from '../../fixtures/server.js';
import {loadServiceProfile} from '../../src/service/config.js';
import {Coordinator,type CoordinatorOptions} from '../../src/service/coordinator.js';
import {Engine} from '../../src/core/engine.js';
export interface ConnectionRow {id:string;type:'ai'|'device';name:string;enabled:boolean;generation:number;state:string;firstSeen:number;lastSeen:number;}
export async function admissionFixture(options:{local?:boolean;connector?:boolean;name?:string;sessionTtlMs?:number;leaseMs?:number;autoAdmitAi?:boolean;allowContinuations?:boolean;chooseAction?:CoordinatorOptions['chooseAction'];proxy?:boolean}={}){
 const serverModule='../../src/network/manual-server.js',connectorModule='../../src/network/manual-connector.js';
 const {startManualNetworkServer}=await import(serverModule),{startManualConnector}=await import(connectorModule);
 const root=await mkdtemp('/tmp/jev-gate-'),runtime=join(root,'run'),certs=makeRemoteCertificates(),provider=new HoldingProvider();
 const net=await startManualNetworkServer({host:'127.0.0.1',port:0,allowedOrigins:[],deviceId:'mac-manual',agentId:'agent-manual',storeDir:join(root,'relay'),tls:certs.server,sessionTtlMs:options.sessionTtlMs??60000,leaseMs:options.leaseMs,autoAdmitAi:options.autoAdmitAi,allowContinuations:options.allowContinuations,adminPort:0});
 const proxy=options.proxy?await faultProxy(net.url,certs):undefined;
 let connector:undefined|{stop():Promise<void>;registrationId():string|undefined},coordinator:Coordinator|undefined,engine:Engine|undefined,browser:CountingBrowser|undefined;
 const fetcher=verifiedFetch(certs.ca),clients=new Set<Client>();
 async function startLocal(){const fixture=await FixtureServer.start(),profile=await loadServiceProfile();browser=new CountingBrowser(fixture.origin);const ownedBrowser=browser;engine=await Engine.create({storageDir:join(runtime,'ledger'),browser,provider,clients:profile.clients});coordinator=await Coordinator.start({runtimeDir:runtime,engine,clients:profile.clients,health:profile.health,chooseAction:options.chooseAction,onStop:async()=>{await ownedBrowser.shutdown();await fixture.close();}});}
 async function startConnection(name=options.name??'Our Mac mini',journal='connector'){connector=await startManualConnector({url:proxy?.url??net.url,name,deviceId:'mac-manual',agentId:'agent-manual',journalDir:join(root,journal),credentialFile:join(runtime,'client-a.json'),ca:certs.ca,pollMs:50});}
 async function client(name='Our AI',customFetch=fetcher){const transport=new StreamableHTTPClientTransport(new URL(net.url+'/mcp'),{fetch:customFetch}),client=new Client({name,version:'1.0.0'});await client.connect(transport);clients.add(client);return {client,transport};}
 async function tool(client:Client,name:string,args:Record<string,unknown>={}):Promise<Record<string,unknown>>{const result=await client.callTool({name,arguments:args});const text=(result.content as {type:string;text:string}[]).find(block=>block.type==='text')?.text;if(!text)throw new Error('MISSING_GATE_TOOL_TEXT');return JSON.parse(text);}
 async function submit(client:Client,name:string,id:string,params:Record<string,unknown>){return tool(client,name,{request_id:id,params}) as Promise<unknown> as Promise<NetworkEnvelope>;}
 async function status(client:Client,id:string){return tool(client,'jev.request_status',{request_id:id}) as Promise<unknown> as Promise<NetworkEnvelope>;}
 async function request(client:Client,name:string,id:string,params:Record<string,unknown>){const ack=await submit(client,name,id,params);return ['QUEUED','DISPATCHED'].includes(ack.delivery_status)?until(()=>status(client,id),row=>!['QUEUED','DISPATCHED'].includes(row.delivery_status),15000):ack;}
 const rows=()=>net.registry.list() as ConnectionRow[];
 async function row(type:'ai'|'device',name:string){return until(async()=>rows().find(row=>row.type===type&&row.name===name),row=>!!row) as Promise<ConnectionRow>;}
 function enable(id:string,value=true){return net.registry.setEnabled(id,value);}
 const adminUrl=new URL(net.admin.url),adminHeaders={origin:adminUrl.origin,'x-jev-control-token':adminUrl.hash.slice(1)};
 async function admin(action:'status'|'admission',body?:unknown){const response=await fetch(adminUrl.origin+'/api/'+action,{method:action==='status'?'GET':'POST',headers:{...adminHeaders,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json() as Record<string,unknown>};}
 async function approve(clientName='Our AI',deviceName=options.name??'Our Mac mini'){const device=await row('device',deviceName);await enable(device.id);await until(async()=>net.store.status(),status=>status.local_ready===true);const ai=await row('ai',clientName);await enable(ai.id);return {device,ai};}
 try{if(options.local!==false)await startLocal();if(options.connector!==false)await startConnection();}catch(error){await connector?.stop();await net.close();await coordinator?.close();certs.close();await rm(root,{recursive:true,force:true});throw error;}
 return {root,runtime,certs,net,provider,fetcher,client,tool,submit,status,request,rows,row,enable,approve,admin,startConnection,
  get proxy(){return proxy!;},get engine(){return engine!;},get browser(){return browser!;},get connector(){return connector;},
  stopConnection:async()=>{await connector?.stop();connector=undefined;},
  close:async()=>{provider.releaseAll();for(const client of clients)await client.close().catch(()=>{});await connector?.stop().catch(()=>{});await proxy?.close();await net.close();await runLocalCli(runtime,['service','stop']);await coordinator?.close().catch(()=>{});certs.close();await rm(root,{recursive:true,force:true});}
 };
}
