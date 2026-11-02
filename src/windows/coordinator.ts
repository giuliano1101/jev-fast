import {createServer,type IncomingMessage} from 'node:http';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {Fault} from '../core/errors.js';
import {PrivateStore} from './store.js';
import {WindowsBrowser} from './browser.js';
import {WindowsDesktop} from './desktop.js';
import {WindowsEngine} from './engine.js';
import {HttpToolPort,type ToolPort} from './network-client.js';
import {startWindowsMcp} from './protocol.js';
import {browserProfile,type WindowsConfig} from './config.js';
import {canonicalDigest} from '../remote/protocol.js';
import {NativeCommon} from './native.js';

interface Location {url:string;token:string;pid:number;fingerprint:string}
async function fingerprint(config:WindowsConfig){let digest='unversioned';try{digest=(JSON.parse(await readFile(new URL('../../build-metadata.json',import.meta.url),'utf8')) as {sourceDigest:string}).sourceDigest;}catch{/* exported isolated test */}return canonicalDigest({config,digest});}
interface Scope {id:string;clientId:string;pid:number;engine:WindowsEngine;transport:StreamableHTTPServerTransport;server:Server;disposing:boolean;retained:boolean;disposal?:Promise<void>}
async function body(req:IncomingMessage){let size=0;const parts:Buffer[]=[];for await(const value of req){const part=Buffer.from(value as Buffer);size+=part.length;if(size>16*1024*1024)throw new Fault('LOCAL_REQUEST_TOO_LARGE');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString('utf8')) as {method?:string};}
export async function startWindowsCoordinator(config:WindowsConfig,options:{port?:number;portFactory?:(clientId:string)=>ToolPort}={}){
 const store=new PrivateStore(config.runtime);await store.initialize();await store.own();
 const browser=new WindowsBrowser({runtime:config.runtime,profile:browserProfile(config),allowedFileRoots:config.allowedFileRoots,...config.browser}),desktop=new WindowsDesktop(config.script),native=new NativeCommon();
 const token=randomBytes(32).toString('hex'),configuration=await fingerprint(config),scopes=new Map<string,Scope>(),clients=new Set<string>();let origin='';
 const dispose=async(scope:Scope)=>{
  if(scope.disposal)return await scope.disposal;if(scope.retained)return;scope.disposing=true;
  scope.disposal=(async()=>{
   scope.engine.stopAccepting();await scope.server.close();await scope.engine.drain();
   try{await scope.engine.release();await scope.engine.close();scopes.delete(scope.id);}
   catch{scope.retained=true;scope.disposing=false;await scope.engine.store.write('retained-context',{local_client_id:scope.clientId,reason:'UNRESOLVED_CONTEXT_OR_CLEANUP',pid:scope.pid});}
  })();return await scope.disposal;
 };
 const server=createServer((req,res)=>{void(async()=>{
  const supplied=req.headers['x-jev-windows-token'];
  if(typeof supplied!=='string'||supplied.length!==token.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))||req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403).end();return;}
  if(req.method==='GET'&&req.url==='/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true,pid:process.pid,fingerprint:configuration}));return;}
  if(req.url!=='/mcp'){res.writeHead(404).end();return;}
  const clientId=req.headers['x-jev-windows-client'],pid=Number(req.headers['x-jev-windows-pid']);
  if(typeof clientId!=='string'||!/^[a-f0-9-]{36}$/.test(clientId)||!Number.isSafeInteger(pid)||pid<=0){res.writeHead(400).end();return;}
  const sessionId=req.headers['mcp-session-id'];let scope=typeof sessionId==='string'?scopes.get(sessionId):undefined;
  if(scope&&(scope.clientId!==clientId||scope.pid!==pid)){res.writeHead(403).end();return;}
  const parsed=req.method==='POST'?await body(req):undefined;
  if(!scope){
   if(sessionId||req.method!=='POST'||parsed?.method!=='initialize'){res.writeHead(404).end();return;}
   if(clients.has(clientId)){res.writeHead(409).end();return;}
   clients.add(clientId);const id=randomUUID(),runtime=join(config.runtime,'owners',clientId);
   const engine=new WindowsEngine({...config,runtime,allowedFileRoots:[runtime,...config.allowedFileRoots.filter(root=>resolve(root)!==resolve(config.runtime))]},options.portFactory?.(clientId)??new HttpToolPort(config.endpoint),{browser,desktop,native,resources:store});await engine.initialize();
   const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>id,enableJsonResponse:true,maxRequestBodySize:16*1024*1024,onsessionclosed:async()=>{const current=scopes.get(id);if(current)await dispose(current);}});
   const mcp=await startWindowsMcp(engine,transport);scope={id,clientId,pid,engine,transport,server:mcp,disposing:false,retained:false};scopes.set(id,scope);
   await engine.store.write('local-owner',{client_id:clientId,pid,created_at:Date.now()});
  }
  if(scope.retained||scope.disposing){res.writeHead(409).end();return;}
  await scope.transport.handleRequest(req,res,parsed);
 })().catch(()=>{if(!res.headersSent)res.writeHead(400);res.end();});});
 await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(options.port??0,'127.0.0.1',done);});const address=server.address();if(!address||typeof address==='string')throw new Fault('LOCAL_COORDINATOR_UNAVAILABLE');origin='http://127.0.0.1:'+address.port;
 const location:Location={url:origin,token,pid:process.pid,fingerprint:configuration};await store.write('coordinator',location);
 const monitor=setInterval(()=>{for(const scope of scopes.values()){try{process.kill(scope.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')void dispose(scope);}}},3000);monitor.unref();
 return {...location,async close(){clearInterval(monitor);for(const scope of [...scopes.values()])await dispose(scope);if([...scopes.values()].some(s=>s.retained))throw new Fault('UNRESOLVED_COORDINATOR_CONTEXT_RETAINED');server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await browser.shutdown();await desktop.close();await native.close();await store.close();}};
}
async function healthy(location:Location){
 try{const response=await fetch(location.url+'/health',{headers:{'x-jev-windows-token':location.token},signal:AbortSignal.timeout(1500),redirect:'error'});const value=await response.json() as {ready?:boolean;pid?:number};return response.ok&&value.ready===true&&value.pid===location.pid;}catch{return false;}
}
export async function ensureWindowsCoordinator(config:WindowsConfig,configPath:string,explicitResume=false){
 const store=new PrivateStore(config.runtime);await store.initialize();
 const existing=await store.read<Location>('coordinator');if(existing&&await healthy(existing)){if(existing.fingerprint!==await fingerprint(config))throw new Fault('LOCAL_COORDINATOR_CONFIGURATION_MISMATCH');return existing;}
 let release:(()=>Promise<void>)|undefined;const acquireDeadline=Date.now()+15000;
 while(!release){try{release=await store.lease('coordinator-startup');}catch(error){if(!(error instanceof Fault)||error.code!=='RESOURCE_BUSY'||Date.now()>=acquireDeadline)throw error;await sleep(50);}}
 try{
  const prior=await store.read<Location>('coordinator');if(prior&&await healthy(prior)){if(prior.fingerprint!==await fingerprint(config))throw new Fault('LOCAL_COORDINATOR_CONFIGURATION_MISMATCH');return prior;}
  if(prior&&!explicitResume)throw new Fault('LOCAL_COORDINATOR_OFFLINE_REQUIRES_OPERATOR_START');
  let failed=false;const child=spawn(process.execPath,[fileURLToPath(new URL('./main.js',import.meta.url)),'--config',resolve(configPath),'--serve'],{detached:true,windowsHide:true,stdio:'ignore'});child.once('error',()=>{failed=true;});child.unref();
  const deadline=Date.now()+15000;while(Date.now()<deadline&&!failed){await sleep(100);const current=await store.read<Location>('coordinator');if(current&&await healthy(current))return current;}
  throw new Fault('LOCAL_COORDINATOR_START_FAILED');
 }finally{await release();}
}
export async function connectWindowsCoordinator(location:Location){
 const clientId=randomUUID(),client=new Client({name:'Codex Windows facade',version:'0.3.0'}),transport=new StreamableHTTPClientTransport(new URL(location.url+'/mcp'),{requestInit:{headers:{'x-jev-windows-token':location.token,'x-jev-windows-client':clientId,'x-jev-windows-pid':String(process.pid)}},reconnectionOptions:{initialReconnectionDelay:250,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1,maxRetries:0}});
 await client.connect(transport);return {client,transport,async close(){await transport.terminateSession();await client.close();}};
}
