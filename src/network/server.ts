import {createServer,type Server as HttpsServer} from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {Fault} from '../core/errors.js';
import {safeCode} from '../service/ipc.js';
import {MAX_BODY,networkToolDefinitions,syncSchema,networkStatusArgsSchema,requestStatusArgsSchema,releaseConnectionArgsSchema} from './protocol.js';
import {RelayStore} from './store.js';
import {startManualNetworkServer,type ManualNetworkServerOptions} from './manual-server.js';
export const tokenSchema=z.strictObject({token:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number().int().positive()});
export type NetworkToken=z.infer<typeof tokenSchema>;
export interface NetworkServerOptions {
 accessMode?:'bearer';
 host?:string;port?:number;publicHost?:string;allowedOrigins:string[];deviceId:string;agentId:string;storeDir:string;
 tls:{key:Buffer;cert:Buffer};mcpToken:NetworkToken;connectorToken:NetworkToken;leaseMs?:number;queueTtlMs?:number|null;responseTtlMs?:number|null;
}
function headerCount(req:IncomingMessage,name:string){return req.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()===name).length;}
function authorized(req:IncomingMessage,credential:NetworkToken){if(headerCount(req,'authorization')!==1)return false;const value=req.headers.authorization;if(credential.expiresAt<=Date.now()||typeof value!=='string'||!/^Bearer [a-f0-9]{64}$/.test(value))return false;return timingSafeEqual(Buffer.from(value.slice(7)),Buffer.from(credential.token));}
function json(res:ServerResponse,status:number,value:unknown){const body=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);}
/** A bounded absolute body deadline is released before MCP/local work begins. */
async function readBody(req:IncomingMessage):Promise<unknown>{
 return new Promise((resolve,reject)=>{
  let size=0,finished=false;const chunks:Buffer[]=[];
  const done=(error?:Fault,value?:unknown)=>{if(finished)return;finished=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',fail);req.off('aborted',fail);if(error)reject(error);else resolve(value);};
  const data=(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_BODY){done(new Fault('BODY_TOO_LARGE'));req.resume();return;}chunks.push(chunk);};
  const end=()=>{try{done(undefined,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{done(new Fault('INVALID_REQUEST'));}};
  const fail=()=>done(new Fault('INVALID_REQUEST'));
  const timer=setTimeout(()=>done(new Fault('BODY_TIMEOUT')),2000);
  req.on('data',data);req.once('end',end);req.once('error',fail);req.once('aborted',fail);
 });
}
type LegacyNetworkServer= {server:HttpsServer;store:RelayStore;url:string;close():Promise<void>};
export function startNetworkServer(options:NetworkServerOptions):Promise<LegacyNetworkServer>;
export function startNetworkServer(options:ManualNetworkServerOptions & {accessMode:'manual'}):ReturnType<typeof startManualNetworkServer>;
export function startNetworkServer(options:NetworkServerOptions|(ManualNetworkServerOptions & {accessMode:'manual'})):Promise<LegacyNetworkServer|Awaited<ReturnType<typeof startManualNetworkServer>>>;
export async function startNetworkServer(options:NetworkServerOptions|(ManualNetworkServerOptions & {accessMode:'manual'})):Promise<LegacyNetworkServer|Awaited<ReturnType<typeof startManualNetworkServer>>>{
 if(options.accessMode==='manual')return startManualNetworkServer(options);
 tokenSchema.parse(options.mcpToken);tokenSchema.parse(options.connectorToken);if(options.mcpToken.token===options.connectorToken.token)throw new Fault('DISTINCT_TOKENS_REQUIRED');
 const host=options.host??'127.0.0.1',loopback=['127.0.0.1','localhost','::1'].includes(host);
 if(!options.publicHost&&!loopback)throw new Fault('PUBLIC_HOST_REQUIRED');
 if(options.publicHost&&!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]{1,5})?$/.test(options.publicHost))throw new Fault('INVALID_PUBLIC_HOST');
 if(options.allowedOrigins.length>16||options.allowedOrigins.some(v=>{try{const u=new URL(v);return u.protocol!=='https:'||u.origin!==v;}catch{return true;}}))throw new Fault('INVALID_ORIGIN');
 if(options.port!==undefined&&(!Number.isInteger(options.port)||options.port<0||options.port>65535))throw new Fault('INVALID_PORT');
 const store=new RelayStore({directory:options.storeDir,deviceId:options.deviceId,agentId:options.agentId,leaseMs:options.leaseMs,queueTtlMs:options.queueTtlMs,responseTtlMs:options.responseTtlMs});
 let expectedHost=options.publicHost??'';
 const handle=async(req:IncomingMessage,res:ServerResponse)=>{
  if(headerCount(req,'host')!==1||headerCount(req,'origin')>1||req.headers.host!==expectedHost||(req.headers.origin!==undefined&&!options.allowedOrigins.includes(req.headers.origin))){json(res,403,{code:'FORBIDDEN'});req.resume();return;}
  if(req.url==='/health'&&req.method==='GET'){json(res,200,{ok:true});return;}
  const role=req.url==='/mcp'?options.mcpToken:req.url==='/connector/sync'?options.connectorToken:null;
  if(!role){json(res,404,{code:'NOT_FOUND'});req.resume();return;}
  if(!authorized(req,role)){json(res,401,{code:'UNAUTHORIZED'});req.resume();return;}
  if(req.method!=='POST'){json(res,405,{code:'METHOD_NOT_ALLOWED'});req.resume();return;}
  if(req.headers['content-type']?.split(';')[0]?.trim()!=='application/json'){json(res,415,{code:'INVALID_CONTENT_TYPE'});req.resume();return;}
  try{
   const body=await readBody(req);
   if(req.url==='/connector/sync'){json(res,200,store.sync(syncSchema.parse(body)));return;}
   // SDK stateless transports are single-request objects. Durable state is shared only in RelayStore.
   const mcp=new Server({name:'jev-network',version:'0.1.0'},{capabilities:{tools:{}}});
   const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
   mcp.onerror=()=>{};
   mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:networkToolDefinitions}));
   mcp.setRequestHandler(CallToolRequestSchema,async request=>{
    try{
     const name=request.params.name,args=request.params.arguments??{};let result:unknown;
     if(name==='jev.network_status'){const arg=networkStatusArgsSchema.parse(args);if(arg.continuation_token)throw new Fault('CONTINUATION_INVALID');result={...store.status(),continuation_supported:false};}
     else if(name==='jev.request_status'){const arg=requestStatusArgsSchema.parse(args);if(arg.continuation_token)throw new Fault('CONTINUATION_INVALID');result=store.get(arg.request_id);}
     else if(name==='jev.release_connection'){releaseConnectionArgsSchema.parse(args);throw new Fault('CONTINUATION_UNAVAILABLE');}
     else result=store.submit(name,args);
     const text=JSON.stringify(result);
     if(Buffer.byteLength(JSON.stringify({content:[{type:'text',text}]}))>MAX_BODY)throw new Fault('RESPONSE_TOO_LARGE');
     return {content:[{type:'text',text}]};
    }catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({code:error instanceof z.ZodError?'INVALID_ARGUMENTS':safeCode(error)})}]};}
   });
   res.once('close',()=>{void transport.close();void mcp.close();});
   await mcp.connect(transport);await transport.handleRequest(req,res,body);
  }catch(error){if(!res.headersSent){const code=error instanceof z.ZodError?'INVALID_REQUEST':safeCode(error);json(res,code==='BODY_TOO_LARGE'?413:code==='BODY_TIMEOUT'?408:code==='CONNECTOR_FENCED'?409:400,{code});}}
 };
 let server:HttpsServer|undefined;
 try{
  const listener=server=createServer({...options.tls,minVersion:'TLSv1.2'},(req,res)=>{void handle(req,res);});
  listener.headersTimeout=5000;listener.requestTimeout=5000;listener.keepAliveTimeout=1000;
  await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(options.port??0,host,resolve);});
  const address=listener.address();if(!address||typeof address==='string')throw new Fault('LISTEN_FAILED');
  if(!expectedHost)expectedHost=`${host.includes(':')?'['+host+']':host}:${address.port}`;
  const url=`https://${expectedHost}`;let closing:Promise<void>|undefined;
  return {server:listener,store,url,close:()=>closing??=(async()=>{
   try{listener.closeAllConnections();await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));}
   finally{store.close();}
  })()};
 }catch(error){
  // TLS validation can fail synchronously before listen. Release only this instance's ownership.
  try{if(server?.listening){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));}}
  finally{store.close();}
  throw error;
 }
}
