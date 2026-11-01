import {createServer,type Server as HttpsServer} from 'node:https';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {Fault} from '../core/errors.js';
import {idSchema} from '../core/contracts.js';
import {safeCode} from '../service/ipc.js';
import {MAX_BODY,networkToolDefinitions,normalizeRequest,continuationTokenSchema,networkStatusArgsSchema,requestStatusArgsSchema,releaseConnectionArgsSchema,type Envelope} from './protocol.js';
import {manualSyncSchema} from './manual-protocol.js';
import {Audit,RelayStore} from './store.js';
import {AdmissionRegistry} from './admission.js';
import {startAdmissionConsole} from './admission-console.js';
export interface ManualNetworkServerOptions {
 accessMode?:'manual';host?:string;port?:number;publicHost?:string;allowedOrigins:string[];deviceId:string;agentId:string;storeDir:string;
 tls:{key:Buffer;cert:Buffer};leaseMs?:number;queueTtlMs?:number|null;responseTtlMs?:number|null;sessionTtlMs?:number|null;autoAdmitAi?:boolean;allowContinuations?:boolean;adminPort?:number;
}
const mapSchema=z.strictObject({request_id:idSchema,connection:z.uuid(),external:idSchema,owner:z.string(),grantDevice:z.uuid().nullable().default(null),grantInstance:z.uuid().nullable().default(null)});
const count=(req:IncomingMessage,name:string)=>req.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()===name).length;
function json(res:ServerResponse,status:number,value:unknown){const body=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);}
async function body(req:IncomingMessage):Promise<unknown>{return new Promise((done,fail)=>{let size=0,settled=false;const chunks:Buffer[]=[];const finish=(error?:Fault,value?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',errorEvent);req.off('aborted',errorEvent);if(error)fail(error);else done(value);};const data=(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_BODY){finish(new Fault('BODY_TOO_LARGE'));req.resume();}else chunks.push(chunk);};const end=()=>{try{finish(undefined,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(new Fault('INVALID_REQUEST'));}};const errorEvent=()=>finish(new Fault('INVALID_REQUEST'));const timer=setTimeout(()=>finish(new Fault('BODY_TIMEOUT')),2000);req.on('data',data);req.once('end',end);req.once('error',errorEvent);req.once('aborted',errorEvent);});}
export async function startManualNetworkServer(options:ManualNetworkServerOptions):Promise<{server:HttpsServer;store:RelayStore;registry:AdmissionRegistry;admin:Awaited<ReturnType<typeof startAdmissionConsole>>;url:string;close():Promise<void>}>{
 const host=options.host??'127.0.0.1';if(!options.publicHost&&!['127.0.0.1','localhost','::1'].includes(host))throw new Fault('PUBLIC_HOST_REQUIRED');
 if(options.publicHost&&!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]{1,5})?$/.test(options.publicHost))throw new Fault('INVALID_PUBLIC_HOST');
 if(options.allowedOrigins.length>16||options.allowedOrigins.some(v=>{try{return new URL(v).protocol!=='https:'||new URL(v).origin!==v;}catch{return true;}}))throw new Fault('INVALID_ORIGIN');
 if(options.port!==undefined&&(!Number.isInteger(options.port)||options.port<0||options.port>65535))throw new Fault('INVALID_PORT');
 const store=new RelayStore({directory:options.storeDir,deviceId:options.deviceId,agentId:options.agentId,leaseMs:options.leaseMs,queueTtlMs:options.queueTtlMs,responseTtlMs:options.responseTtlMs});
 let registry:AdmissionRegistry|undefined,mapping:Audit<z.infer<typeof mapSchema>>|undefined,admin:Awaited<ReturnType<typeof startAdmissionConsole>>|undefined,server:HttpsServer|undefined,timer:ReturnType<typeof setInterval>|undefined;
 const sessions=new Map<string,{mcp:Server;transport:StreamableHTTPServerTransport}>();let expectedHost=options.publicHost??'';
 try{
  const admissions=registry=new AdmissionRegistry(join(options.storeDir,'manual-registry'),options.sessionTtlMs,options.leaseMs??3000);
  const requests=mapping=new Audit(join(options.storeDir,'manual-requests'),{kind:'manual-request-map-v1'},mapSchema);
  const internal=(cid:string,rid:string)=>createHash('sha256').update(cid+'\0'+rid).digest('hex');
  // This is a trusted operator deployment policy, never a caller-controlled tool argument.
  // Only first admission is automatic: an explicitly disabled or revoked generation stays off.
  function applyAiPolicy(cid:string){
   const record=admissions.get(cid);
   if(!options.autoAdmitAi||record.type!=='ai'||record.enabled||record.generation!==0||record.state!=='pending'||!store.status().local_ready)return record;
   try{return admissions.setEnabled(cid,true);}catch(error){if(error instanceof Fault&&['DEVICE_NOT_ENABLED','DEVICE_NOT_READY'].includes(error.code))return record;throw error;}
  }
  // These capabilities exist only in this relay runtime and bind an immutable owner generation.
  const continuations=new Map<string,{cid:string;owner:string;generation:number}>(),continuationByCid=new Map<string,string>();
  function forgetContinuation(cid:string){const token=continuationByCid.get(cid);if(token)continuations.delete(token);continuationByCid.delete(cid);}
  function continuationRecord(token:string){
   const context=options.allowContinuations?continuations.get(token):undefined;
   if(!context)throw new Fault('CONTINUATION_INVALID');
   try{const record=admissions.get(context.cid);if(!record.enabled||record.owner!==context.owner||record.generation!==context.generation||!admissions.isLive(context.cid))throw new Error();return record;}
   catch{forgetContinuation(context.cid);throw new Fault('CONTINUATION_INVALID');}
  }
  function effectiveConnection(cid:string,args:unknown){const input=z.object({continuation_token:continuationTokenSchema.optional()}).parse(args);return input.continuation_token?continuationRecord(input.continuation_token).id:cid;}
  function issueContinuation(cid:string){
   const record=admissions.get(cid);if(!options.allowContinuations||!record.enabled||!record.owner)return undefined;
   const existing=continuationByCid.get(cid);if(existing){try{continuationRecord(existing);return existing;}catch{/* A changed owner generation needs a new capability. */}}
   const token=randomBytes(32).toString('hex');continuations.set(token,{cid,owner:record.owner,generation:record.generation});continuationByCid.set(cid,token);return token;
  }
  function detachTransport(cid:string){const token=continuationByCid.get(cid);let retained=false;if(token)try{continuationRecord(token);retained=true;}catch{/* Invalidated logical owners cannot survive transport cleanup. */}if(!retained)admissions.disconnect(cid);rejectRevoked();}
  function rejectRevoked(){const owners=new Set(admissions.revocations());store.rejectQueued(requests.all().filter(r=>owners.has(r.owner)).map(r=>r.request_id));}
  function result(cid:string,rid:string):Envelope{const key=internal(cid,rid),row=requests.get(key);if(!row||row.connection!==cid)throw new Fault('REQUEST_NOT_FOUND');return {...store.get(key),request_id:rid};}
  function createMcp(cid:string){
   const mcp=new Server({name:'jev-network-manual',version:'0.2.0'},{capabilities:{tools:{}}});mcp.onerror=()=>{};
   const transport=new StreamableHTTPServerTransport({sessionIdGenerator:()=>cid,enableJsonResponse:true,onsessionclosed:()=>{detachTransport(cid);sessions.delete(cid);void mcp.close();}});
   mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:networkToolDefinitions}));
   mcp.setRequestHandler(CallToolRequestSchema,async request=>{
    try{
     admissions.touch(cid);const name=request.params.name,args=request.params.arguments??{},effectiveCid=effectiveConnection(cid,args);admissions.touch(effectiveCid);const record=effectiveCid===cid?applyAiPolicy(cid):admissions.get(effectiveCid);let value:unknown;
     if(name==='jev.network_status'){networkStatusArgsSchema.parse(args);const token=issueContinuation(effectiveCid);value={...store.status(),admission:record.state,connection_id:effectiveCid,enabled:record.enabled,continuation_supported:options.allowContinuations??false,...(token?{continuation_token:token}:{})};}
     else if(name==='jev.release_connection'){releaseConnectionArgsSchema.parse(args);admissions.disconnect(effectiveCid);forgetContinuation(effectiveCid);rejectRevoked();value={released:true};}
     else{
      if(!record.enabled||!record.owner)throw new Fault('ADMISSION_REQUIRED');rejectRevoked();
      if(name==='jev.request_status'){const arg=requestStatusArgsSchema.parse(args);value=result(effectiveCid,arg.request_id);}
      else{const normalized=normalizeRequest(name,args),key=internal(effectiveCid,normalized.request_id);if(!requests.get(key))requests.put(key,{request_id:key,connection:effectiveCid,external:normalized.request_id,owner:record.owner,grantDevice:record.grantDevice,grantInstance:record.grantInstance});
       value={...store.submit(name,{request_id:key,params:normalized.params}),request_id:normalized.request_id};}
     }
     const text=JSON.stringify(value);if(Buffer.byteLength(JSON.stringify({content:[{type:'text',text}]}))>MAX_BODY)throw new Fault('RESPONSE_TOO_LARGE');return {content:[{type:'text',text}]};
    }catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({code:error instanceof z.ZodError?'INVALID_ARGUMENTS':safeCode(error)})}]};}
   });
   sessions.set(cid,{mcp,transport});return {mcp,transport};
  }
  const handle=async(req:IncomingMessage,res:ServerResponse)=>{
    if(count(req,'host')!==1||req.headers.host!==expectedHost||count(req,'origin')>1||req.headers.origin!==undefined&&!options.allowedOrigins.includes(req.headers.origin)){json(res,403,{code:'FORBIDDEN'});req.resume();return;}
   if(req.url==='/health'&&req.method==='GET'){json(res,200,{ok:true});return;}
   if(!['/mcp','/connector/register','/connector/sync'].includes(req.url??'')){json(res,404,{code:'NOT_FOUND'});req.resume();return;}
   if(req.url==='/mcp'&&req.method==='DELETE'){
    const cid=req.headers['mcp-session-id'];if(count(req,'mcp-session-id')!==1||typeof cid!=='string'||!sessions.has(cid)||!admissions.isLive(cid)){json(res,404,{code:'SESSION_NOT_FOUND'});return;}
    detachTransport(cid);const session=sessions.get(cid)!;await session.transport.handleRequest(req,res);sessions.delete(cid);await session.mcp.close();return;
   }
   if(req.method!=='POST'){json(res,405,{code:'METHOD_NOT_ALLOWED'});req.resume();return;}
   if(req.headers['content-type']?.split(';')[0]?.trim()!=='application/json'){json(res,415,{code:'INVALID_CONTENT_TYPE'});req.resume();return;}
   try{
    const value=await body(req);rejectRevoked();
    if(req.url==='/connector/register'){
     const input=z.strictObject({name:z.string(),device_id:idSchema,agent_id:idSchema}).parse(value);
     if(input.device_id!==options.deviceId||input.agent_id!==options.agentId)throw new Fault('BINDING_MISMATCH');
     const row=admissions.register('device',input.name);json(res,200,{handle:row.id,enabled:false});return;
    }
    if(req.url==='/connector/sync'){
     const input=manualSyncSchema.parse(value),record=admissions.touch(input.handle);if(record.type!=='device'||input.sync.connector_id!==record.id)throw new Fault('INVALID_REQUEST');
     admissions.updateDeviceInstance(record.id,input.sync.local_instance_id);
     const trusted=record.generation>0;
     if(trusted){for(const row of admissions.list())if(row.owner&&row.grantDevice===record.id&&input.invalidated.includes(row.owner))admissions.setEnabled(row.id,false);const permitted=admissions.revocationsFor(record.id,input.sync.local_instance_id);admissions.ackRevocations(input.revoked.filter(owner=>permitted.includes(owner)));}
     admissions.resumeDevice(record.id,input.sync.ready);
     rejectRevoked();const owners=admissions.owners(record.id),revocations=trusted?admissions.revocationsFor(record.id,input.sync.local_instance_id):[];
     let response:{acks:{request_id:string;delivery_nonce:string}[];job:unknown}={acks:[],job:null};
     if(trusted){const currentRecord=admissions.get(record.id),ready=currentRecord.enabled&&input.sync.ready;
      const receipts=input.sync.results.filter(receipt=>{const request=requests.get(receipt.request_id);if(!request)return false;return request.grantDevice===record.id||(currentRecord.enabled&&input.sync.local_instance_id!==null&&request.grantInstance===input.sync.local_instance_id);});
      if(currentRecord.enabled)store.selectConnector(record.id);
      response=currentRecord.enabled?store.sync({...input.sync,results:receipts,ready,capacity:ready&&revocations.length===0?input.sync.capacity:0}):{acks:store.acceptReceipts(receipts),job:null};
      if(response.job){const job=response.job as {request_id:string};const map=requests.get(job.request_id);if(!map||!owners.includes(map.owner))throw new Fault('OWNER_REVOKED');response.job={...response.job,network_owner:map.owner};}}
     json(res,200,{...response,owners,revocations,enabled:admissions.get(record.id).enabled});return;
    }
    const sid=req.headers['mcp-session-id'];let current:{mcp:Server;transport:StreamableHTTPServerTransport};
    if(sid!==undefined){if(count(req,'mcp-session-id')!==1||typeof sid!=='string'||!sessions.has(sid)||!admissions.isLive(sid)){json(res,404,{code:'SESSION_NOT_FOUND'});return;}admissions.touch(sid);current=sessions.get(sid)!;}
    else{
     const init=z.object({method:z.literal('initialize'),params:z.object({clientInfo:z.object({name:z.string()})})}).parse(value);
     const record=admissions.register('ai',init.params.clientInfo.name);applyAiPolicy(record.id);current=createMcp(record.id);await current.mcp.connect(current.transport);
    }
    await current.transport.handleRequest(req,res,value);
   }catch(error){if(!res.headersSent){const code=error instanceof z.ZodError?'INVALID_REQUEST':safeCode(error);json(res,code==='BODY_TOO_LARGE'?413:code==='BODY_TIMEOUT'?408:code==='HANDLE_EXPIRED'?410:code==='CONNECTOR_FENCED'?409:400,{code});}else res.destroy();}
  };
  server=createServer({...options.tls,minVersion:'TLSv1.2'},(req,res)=>{void handle(req,res).catch(()=>res.destroy());});server.headersTimeout=5000;server.requestTimeout=5000;server.keepAliveTimeout=1000;
  await new Promise<void>((done,fail)=>{server!.once('error',fail);server!.listen(options.port??0,host,done);});const address=server.address();if(!address||typeof address==='string')throw new Fault('LISTEN_FAILED');if(!expectedHost)expectedHost=`${host.includes(':')?'['+host+']':host}:${address.port}`;
  admin=await startAdmissionConsole({registry:admissions,port:options.adminPort});
  timer=setInterval(()=>{try{rejectRevoked();for(const [id,session] of sessions)if(!admissions.isLive(id)){sessions.delete(id);void session.mcp.close();}}catch{/* Storage errors fence requests on their next checked access. */}},Math.min(250,options.sessionTtlMs??250));timer.unref();
  const listener=server,panel=admin;let closing:Promise<void>|undefined;
  return {server:listener,store,registry:admissions,admin:panel,url:`https://${expectedHost}`,close:()=>closing??=(async()=>{clearInterval(timer);for(const session of sessions.values())await session.mcp.close();sessions.clear();await panel.close();listener.closeAllConnections();try{await new Promise<void>((done,fail)=>listener.close(error=>error?fail(error):done()));}finally{admissions.close();requests.close();store.close();}})()};
 }catch(error){clearInterval(timer);await admin?.close();if(server?.listening){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));}registry?.close();mapping?.close();store.close();throw error;}
}
