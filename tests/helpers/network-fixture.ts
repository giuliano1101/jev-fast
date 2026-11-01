import {randomBytes} from 'node:crypto';
import {MAX_BODY} from '../../src/network/protocol.js';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {request as httpsRequest,createServer as createHttpsServer,type Server as HttpsServer} from 'node:https';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {checkServerIdentity} from 'node:tls';
import {Fault} from '../../src/core/errors.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {makeRemoteCertificates} from './remote-fixture.js';
import {FixtureServer} from '../../fixtures/server.js';
import {BrowserAdapter} from '../../src/browser/adapter.js';
import {Engine} from '../../src/core/engine.js';
import type {Candidate,Goal,ExecutionAuthorization,DecisionProvider,DecisionInput,DecisionContext} from '../../src/core/contracts.js';
import {MockProvider} from '../../src/providers/mock.js';
import {Coordinator,type CoordinatorOptions} from '../../src/service/coordinator.js';
import {loadServiceProfile} from '../../src/service/config.js';
import {executeBounded} from '../../src/control/server.js';
export interface NetworkEnvelope {request_id:string;delivery_status:'QUEUED'|'DISPATCHED'|'COMPLETED'|'REJECTED'|'UNKNOWN';reply?:{ok:boolean;result?:unknown;error?:{code:string}}}
export async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,timeout=12000):Promise<T>{const end=Date.now()+timeout;while(Date.now()<end){const value=await read();if(accept(value))return value;await new Promise(done=>setTimeout(done,25));}throw new Error('NETWORK_TEST_CONDITION_TIMEOUT');}
/** Actual HTTPS with normal CA/hostname verification, adapted to the SDK fetch interface. */
export function verifiedFetch(ca:Buffer):typeof fetch {
 return async(input,init)=>{
  const requestInput=input instanceof Request?input:undefined,url=new URL(requestInput?.url??String(input)),headers=new Headers(init?.headers??requestInput?.headers),method=init?.method??requestInput?.method??'GET';
  let body:Buffer|undefined;
  if(init?.body!==undefined&&init.body!==null){if(typeof init.body==='string')body=Buffer.from(init.body);else if(init.body instanceof Uint8Array)body=Buffer.from(init.body);else throw new Error('UNSUPPORTED_TEST_FETCH_BODY');}
  else if(requestInput?.body)body=Buffer.from(await requestInput.arrayBuffer());
  const signal=init?.signal??requestInput?.signal;
  return new Promise<Response>((done,fail)=>{
   const req=httpsRequest(url,{method,headers:Object.fromEntries(headers),ca,agent:false,checkServerIdentity:(_host,cert)=>checkServerIdentity(url.hostname,cert),signal:signal??undefined},res=>{
    const chunks:Buffer[]=[];let size=0;res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_BODY)req.destroy(new Error('TEST_RESPONSE_LIMIT'));else chunks.push(chunk);});
    res.on('error',fail);res.on('end',()=>{const responseHeaders=new Headers();for(const [key,value]of Object.entries(res.headers))if(value!==undefined)responseHeaders.set(key,Array.isArray(value)?value.join(', '):value);const status=res.statusCode!;done(new Response([101,204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:responseHeaders}));});
   });req.setTimeout(15000,()=>req.destroy(new Error('TEST_HTTPS_TIMEOUT')));req.on('error',fail);req.end(body);
  });
 };
}
export class HoldingProvider implements DecisionProvider {
 private mock=new MockProvider();private gate?:{entered:()=>void;released:Promise<void>};private releases=new Set<()=>void>();calls=0;
 holdNext(){let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(done=>entered=done),released=new Promise<void>(done=>release=done);this.gate={entered,released};this.releases.add(release);return {entered:waiting,release:()=>{this.releases.delete(release);release();}};}
 releaseAll(){for(const release of this.releases)release();this.releases.clear();}
 async decide(input:DecisionInput,context:DecisionContext){this.calls++;const gate=this.gate;this.gate=undefined;if(gate){gate.entered();await Promise.race([gate.released,new Promise<never>((_done,fail)=>{if(context.signal.aborted)fail(new Fault('CANCELLED'));else context.signal.addEventListener('abort',()=>fail(new Fault('CANCELLED')),{once:true});})]);}return this.mock.decide(input,context);}
}
export class CountingBrowser extends BrowserAdapter {
 physical=0;loseNextResponse=false;
 override async execute(session:string,candidate:Candidate,goal:Goal,signal:AbortSignal,authorization?:ExecutionAuthorization){await super.execute(session,candidate,goal,signal,authorization);this.physical++;if(this.loseNextResponse){this.loseNextResponse=false;throw new Error('simulated response loss after physical action');}}
}
export async function runLocalCli(runtime:string,args:string[]){return executeBounded(process.execPath,[resolve('dist/src/cli/index.js'),...args,'--runtime',runtime,'--json'],{timeoutMs:20000});}
export async function networkFixture(options:{connector?:boolean;local?:boolean;proxy?:boolean;chooseAction?:CoordinatorOptions['chooseAction']}={}){
 const serverModule='../../src/network/server.js',connectorModule='../../src/network/connector.js';
 const {startNetworkServer}=await import(serverModule),{startConnector}=await import(connectorModule);
 const root=await mkdtemp('/tmp/jev-net-'),runtime=join(root,'run'),certs=makeRemoteCertificates(),provider=new HoldingProvider();
 const tokens={mcp:randomBytes(32).toString('hex'),connector:randomBytes(32).toString('hex')},expiresAt=Date.now()+600000;
 const fixed={deviceId:'mac-test',agentId:'agent-test',storeDir:join(root,'relay'),tls:certs.server,mcpToken:{token:tokens.mcp,expiresAt},connectorToken:{token:tokens.connector,expiresAt},host:'127.0.0.1',port:0,allowedOrigins:[],leaseMs:1200,queueTtlMs:800};
 let net=await startNetworkServer(fixed),connector:undefined|{stop:()=>Promise<void>},proxy:undefined|Awaited<ReturnType<typeof faultProxy>>,coordinator:Coordinator|undefined,browser:CountingBrowser|undefined,engine:Engine|undefined;
 const fetcher=verifiedFetch(certs.ca);const clients=new Set<Client>();
 async function startLocal(){
  const fixture=await FixtureServer.start(),profile=await loadServiceProfile();browser=new CountingBrowser(fixture.origin);const currentBrowser=browser;
  engine=await Engine.create({storageDir:join(runtime,'ledger'),browser,provider,clients:profile.clients});
  coordinator=await Coordinator.start({runtimeDir:runtime,engine,clients:profile.clients,health:profile.health,chooseAction:options.chooseAction,onStop:async()=>{await currentBrowser.shutdown();await fixture.close();}});
 }
 async function startConnection(){connector=await startConnector({url:proxy?.url??net.url,deviceId:fixed.deviceId,agentId:fixed.agentId,journalDir:join(root,'connector'),credentialFile:join(runtime,'client-a.json'),token:{token:tokens.connector,expiresAt},ca:certs.ca,pollMs:50});}
 async function client(token=tokens.mcp,customFetch=fetcher){const transport=new StreamableHTTPClientTransport(new URL(net.url+'/mcp'),{fetch:customFetch,requestInit:{headers:{authorization:'Bearer '+token}}}),client=new Client({name:'network-acceptance',version:'1.0.0'});await client.connect(transport);clients.add(client);return client;}
 async function tool(client:Client,name:string,args:Record<string,unknown>={}):Promise<Record<string,unknown>>{const result=await client.callTool({name,arguments:args});const text=(result.content as {type:string;text:string}[]).find(part=>part.type==='text')?.text;if(!text)throw new Error('MISSING_TOOL_TEXT');return JSON.parse(text) as Record<string,unknown>;}
 async function submit(client:Client,method:string,request_id:string,params:Record<string,unknown>){return tool(client,method,{request_id,params}) as Promise<unknown> as Promise<NetworkEnvelope>;}
 async function status(client:Client,request_id:string){return tool(client,'jev.request_status',{request_id}) as Promise<unknown> as Promise<NetworkEnvelope>;}
 async function terminal(client:Client,request_id:string){return until(()=>status(client,request_id),row=>!['QUEUED','DISPATCHED'].includes(row.delivery_status));}
 async function ready(client:Client){return until(()=>tool(client,'jev.network_status'),row=>row.connector_online===true&&row.local_ready===true);}
 async function request(client:Client,method:string,id:string,params:Record<string,unknown>){const ack=await submit(client,method,id,params);return ['QUEUED','DISPATCHED'].includes(ack.delivery_status)?terminal(client,id):ack;}
 async function ledger(){return JSON.parse(await readFile(join(runtime,'ledger','ledger.json'),'utf8')) as {goals:Record<string,{status:string;action_ids:string[]}>;actions:Record<string,{status:string}>};}
 try{
  if(options.local!==false)await startLocal();if(options.proxy)proxy=await faultProxy(net.url,certs);
  if(options.connector!==false)await startConnection();
 }catch(error){await net.close();await coordinator?.close();certs.close();await rm(root,{recursive:true,force:true});throw error;}
 return {root,runtime,certs,tokens,expiresAt,fixed,provider,fetcher,client,tool,submit,status,terminal,ready,request,ledger,startLocal,startConnection,
  get net(){return net;},get browser(){return browser!;},get engine(){return engine!;},get connector(){return connector;},get proxy(){return proxy!;},
  stopConnection:async()=>{await connector?.stop();connector=undefined;},
  restartRelay:async()=>{const port=Number(new URL(net.url).port);await net.close();net=await startNetworkServer({...fixed,port});},
  close:async()=>{provider.releaseAll();for(const client of clients)await client.close().catch(()=>{});await connector?.stop().catch(()=>{});await proxy?.close();await net.close();await runLocalCli(runtime,['service','stop']);await coordinator?.close().catch(()=>{});certs.close();await rm(root,{recursive:true,force:true});}
 };
}
/** TLS-verified test-only link interruption. It never modifies production trust rules. */
export async function faultProxy(target:string,certs:ReturnType<typeof makeRemoteCertificates>){
 let offline=false,blockedUploads=0,dropUploads=false,dropDeliveries=false,droppedDeliveries=0,receiptBodies=0;const upstreams=new Set<ReturnType<typeof httpsRequest>>();
 const server:HttpsServer=createHttpsServer(certs.server,(req,res)=>{
  const chunks:Buffer[]=[];req.on('data',(chunk:Buffer)=>chunks.push(chunk));req.on('end',()=>{
   const body=Buffer.concat(chunks),parsed=body.length?JSON.parse(body.toString('utf8')) as {results?:unknown[]}:{};
   const isReceipt=Array.isArray(parsed.results)&&parsed.results.length>0;if(isReceipt)receiptBodies++;
   if(offline||dropUploads&&isReceipt){if(isReceipt)blockedUploads++;res.writeHead(503).end();return;}
   const url=new URL(req.url!,target),headers={...req.headers,host:url.host};
   const upstream=httpsRequest(url,{method:req.method,headers,ca:certs.ca,agent:false},reply=>{const result:Buffer[]=[];reply.on('data',(chunk:Buffer)=>result.push(chunk));reply.on('end',()=>{upstreams.delete(upstream);const data=Buffer.concat(result);if(dropDeliveries&&data.includes(Buffer.from('"delivery_nonce"'))){dropDeliveries=false;droppedDeliveries++;res.destroy();return;}res.writeHead(reply.statusCode!,reply.headers).end(data);});});
   upstreams.add(upstream);upstream.on('error',()=>{upstreams.delete(upstream);if(!res.headersSent)res.writeHead(503).end();else res.destroy();});upstream.end(body);
  });req.on('error',()=>{});
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('PROXY_NOT_LISTENING');
 return {url:`https://127.0.0.1:${address.port}`,set offline(value:boolean){offline=value;},get offline(){return offline;},set dropUploads(value:boolean){dropUploads=value;},set dropDeliveries(value:boolean){dropDeliveries=value;},get blockedUploads(){return blockedUploads;},get droppedDeliveries(){return droppedDeliveries;},get receiptBodies(){return receiptBodies;},close:async()=>{for(const req of upstreams)req.destroy();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}};
}
