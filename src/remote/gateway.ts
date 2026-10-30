import {createServer,type Server} from 'node:https';
import type {IncomingMessage as HttpRequest,ServerResponse as HttpResponse} from 'node:http';
import {TLSSocket} from 'node:tls';
import {createHash,randomUUID,type KeyObject} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {DecisionProvider} from '../core/contracts.js';
import {Fault} from '../core/errors.js';
import {MockProvider} from '../providers/mock.js';
import {JevProvider,type JevOptions,type LiveAuthorization} from '../providers/jev.js';
import {canonicalDigest,canonicalJson,parseDecisionRequest,signDecisionResponse,type AuthenticatedIdentity,type DecisionRequest} from './protocol.js';
import {verifyAgentToken} from './credentials.js';
import {GatewayStore,type GatewayApproval} from './store.js';
export interface DecisionGatewayOptions {
 tls:{cert:string|Buffer;key:string|Buffer;ca:string|Buffer};store:GatewayStore;
 receiptPrivateKey:KeyObject;tokenPublicKey:KeyObject;issuer:string;audience:string;
 /** Trusted test profile only. Its output must still validate as a mock decision. */
 mockProvider?:DecisionProvider;
 live?:{key:string;authorization:LiveAuthorization;approval:GatewayApproval;transport?:JevOptions['transport']};
}
const publicCodes=new Set(['UNAUTHENTICATED','FORBIDDEN','INVALID_PROTOCOL','REQUEST_TOO_LARGE','STALE_SNAPSHOT','BUDGET_EXHAUSTED','RATE_LIMITED','PROVIDER_UNAVAILABLE','IDEMPOTENCY_CONFLICT','DECISION_UNKNOWN','LIVE_NOT_AUTHORIZED','INVALID_DECISION']);
const definiteRejections=new Set(['FORBIDDEN','UNAUTHENTICATED','STALE_SNAPSHOT','BUDGET_EXHAUSTED','LIVE_NOT_AUTHORIZED','INVALID_DECISION','INVALID_PROBABILITIES']);
function safeCode(error:unknown){return error instanceof Fault&&publicCodes.has(error.code)?error.code:'PROVIDER_UNAVAILABLE';}
function status(code:string){return code==='UNAUTHENTICATED'?401:code==='FORBIDDEN'?403:code==='RATE_LIMITED'?429:code==='IDEMPOTENCY_CONFLICT'||code==='DECISION_UNKNOWN'?409:code==='REQUEST_TOO_LARGE'?413:code==='PROVIDER_UNAVAILABLE'?503:400;}
function send(res:HttpResponse,value:unknown,code=200){if(res.destroyed||res.writableEnded)return;const body=canonicalJson(value);res.writeHead(code,{'content-type':'application/json','content-length':Buffer.byteLength(body),'cache-control':'no-store',connection:'close'});res.end(body);}
function fail(res:HttpResponse,code:string,requestId?:string){send(res,{code,retryable:false,...(requestId?{request_id:requestId}:{})},status(code));}
async function within<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)throw new Fault('STALE_SNAPSHOT');return new Promise<T>((resolve,reject)=>{
  const abort=()=>reject(new Fault('STALE_SNAPSHOT'));signal.addEventListener('abort',abort,{once:true});operation.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
async function readBody(req:HttpRequest,signal:AbortSignal):Promise<unknown>{
 if(req.headers['content-type']!=='application/json'||req.headers['content-encoding'])throw new Fault('INVALID_PROTOCOL');
 if(Number(req.headers['content-length']??0)>24000)throw new Fault('REQUEST_TOO_LARGE');
 const data=await within(new Promise<Buffer>((resolve,reject)=>{
  const chunks:Buffer[]=[];let bytes=0;
  req.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>24000){reject(new Fault('REQUEST_TOO_LARGE'));req.pause();}else chunks.push(chunk);});
  req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',()=>reject(new Fault('INVALID_PROTOCOL')));req.on('aborted',()=>reject(new Fault('INVALID_PROTOCOL')));
 }),signal);
 try{return JSON.parse(data.toString('utf8'));}catch{throw new Fault('INVALID_PROTOCOL');}
}
/** Private decision-only server. No executor, browser, shell, enrollment or mint endpoint. */
export function createDecisionGateway(options:DecisionGatewayOptions):Server {
 if(!options.tls.cert||!options.tls.key||!options.tls.ca||options.receiptPrivateKey.type!=='private'||options.receiptPrivateKey.asymmetricKeyType!=='ed25519'||options.tokenPublicKey.type!=='public'||options.tokenPublicKey.asymmetricKeyType!=='ed25519')throw new Fault('INVALID_GATEWAY_CONFIGURATION');
 if(options.live){
  if(options.mockProvider)throw new Fault('INVALID_GATEWAY_CONFIGURATION');
  const {approval,authorization}=options.live;
  if(approval.approval_id!==authorization.approval_id||approval.expires_at!==authorization.expires_at||approval.max_requests!==authorization.max_requests||approval.max_cost_usd!==authorization.max_cost_usd||approval.reservation_usd<32768*.042/1e6)throw new Fault('LIVE_NOT_AUTHORIZED');
  // Validate constructor authorization before opening the listener; requests use a fresh provider with a durable shared budget.
  new JevProvider(options.live);options.store.configureBudget(approval);
 }
 const route=options.live?'jev':'mock';const mock=options.mockProvider??new MockProvider();
 let active=0;const principals=new Set<string>();const rates=new Map<string,{start:number;count:number}>();
 function rateLimit(principal:string){
  const now=performance.now();let entry=rates.get(principal);
  if(!entry||now-entry.start>=60000){
   for(const [key,value] of rates)if(now-value.start>=60000)rates.delete(key);
   if(rates.size>=1024&&!rates.has(principal))throw new Fault('RATE_LIMITED');
   entry={start:now,count:0};rates.set(principal,entry);
  }
  if(entry.count>=60)throw new Fault('RATE_LIMITED');entry.count++;
 }
 async function handle(req:HttpRequest,res:HttpResponse){
  const started=performance.now(),windowStartedWall=Date.now(),controller=new AbortController();let timer=setTimeout(()=>controller.abort(),2000);
  const onClose=()=>{if(!res.writableEnded)controller.abort();};res.once('close',onClose);req.once('aborted',()=>controller.abort());
  let request:DecisionRequest|undefined,identity:AuthenticatedIdentity|undefined,principal:string|undefined,startedRecord=false,dispatched=false,admitted=false,principalHeld=false;
  try{
   if(req.headers.origin!==undefined||!['GET /health','POST /v1/decisions'].includes(`${req.method} ${req.url}`))throw new Fault('INVALID_PROTOCOL');
   const socket=req.socket;if(!(socket instanceof TLSSocket)||!socket.authorized)throw new Fault('UNAUTHENTICATED');
   const certificate=socket.getPeerCertificate();if(!certificate.raw)throw new Fault('UNAUTHENTICATED');
   const certHash=createHash('sha256').update(certificate.raw).digest('hex');
   const authorizations=req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i]!.toLowerCase()==='authorization');
   const auth=req.headers.authorization;if(authorizations.length!==1||!auth?.startsWith('Bearer '))throw new Fault('UNAUTHENTICATED');
   const authenticate=()=>options.store.authorize(verifyAgentToken(auth.slice(7),{publicKey:options.tokenPublicKey,issuer:options.issuer,audience:options.audience,certificateSha256:certHash}),certHash);
   identity=authenticate();principal=canonicalDigest(identity);rateLimit(principal);
   if(active>=4)throw new Fault('RATE_LIMITED');active++;admitted=true;
   if(req.method==='GET'){send(res,{mode:route,model:route==='jev'?'jev-1.14.0':'mock-v1',protocol:'decision-v1',policy:'p0-v1',identity});return;}
   request=parseDecisionRequest(await readBody(req,controller.signal));
   const ttl=Math.min(2000,request.deadline_ms,request.snapshot.valid_for_ms),remaining=ttl-(performance.now()-started);
   if(controller.signal.aborted||remaining<=0)throw new Fault('STALE_SNAPSHOT');
   clearTimeout(timer);timer=setTimeout(()=>controller.abort(),remaining);
   authenticate();
   const prior=options.store.begin(identity,request.idempotency_key,canonicalDigest(request).slice(7));
   startedRecord=prior.status==='started';
   authenticate();if(controller.signal.aborted||performance.now()-started>=ttl)throw new Fault('STALE_SNAPSHOT');
   if(prior.status==='complete'){send(res,prior.response);return;}
   if(prior.status==='unknown')throw new Fault('DECISION_UNKNOWN');
   if(prior.status==='rejected')throw new Fault(publicCodes.has(prior.code??'')?prior.code!:'PROVIDER_UNAVAILABLE');
   startedRecord=true;
   if(principals.has(principal))throw new Fault('RATE_LIMITED');principals.add(principal);principalHeld=true;
   const dispatchRemaining=ttl-(performance.now()-started);
   if(controller.signal.aborted||dispatchRemaining<=0)throw new Fault('STALE_SNAPSHOT');
   const provider=options.live?new JevProvider({...options.live,beforeAttempt:()=>{if(controller.signal.aborted||performance.now()-started>=ttl)throw new Fault('STALE_SNAPSHOT');authenticate();options.store.reserve(identity!,request!.idempotency_key,options.live!.approval.approval_id);authenticate();if(controller.signal.aborted||performance.now()-started>=ttl)throw new Fault('STALE_SNAPSHOT');}}):mock;
   dispatched=true;
   const decision=await within(provider.decide(request.input,{signal:controller.signal,deadline:Date.now()+dispatchRemaining}),controller.signal);
   const remainingAtIssue=ttl-(performance.now()-started);if(controller.signal.aborted||remainingAtIssue<=0)throw new Fault('STALE_SNAPSHOT');
   authenticate();
   // The verifier anchors valid_for_ms at the local request start. Sign the same
   // original window, not its remaining duration (which would subtract inference
   // time twice). issued_at_ms is this window's start, not the signing instant.
   // Both the server deadline and the original local snapshot still bound use.
   const response=signDecisionResponse(request,decision,{privateKey:options.receiptPrivateKey,issuer:options.issuer,audience:options.audience,identity,decisionId:randomUUID(),issuedAtMs:windowStartedWall,validForMs:ttl,route});
   options.store.complete(identity,request.idempotency_key,response,provider instanceof JevProvider?provider.accounting().known_cost_usd:0);startedRecord=false;authenticate();if(controller.signal.aborted||performance.now()-started>=ttl)throw new Fault('STALE_SNAPSHOT');send(res,response);
  }catch(error){
   let code=safeCode(error);
   if(startedRecord&&request&&identity){
    try{
     if(dispatched&&(!(error instanceof Fault)||!definiteRejections.has(error.code)||controller.signal.aborted)){options.store.markUnknown(identity,request.idempotency_key);code='DECISION_UNKNOWN';}
     else options.store.reject(identity,request.idempotency_key,code);
    }catch{code='PROVIDER_UNAVAILABLE';}
   }
   fail(res,code,request?.request_id);
  }finally{clearTimeout(timer);controller.abort();res.removeListener('close',onClose);if(admitted)active--;if(principalHeld&&principal)principals.delete(principal);}
 }
 const server=createServer({...options.tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',handshakeTimeout:2000,maxHeaderSize:12000},(req,res)=>{void handle(req,res);});
 server.maxConnections=64;server.maxRequestsPerSocket=1;server.headersTimeout=2000;server.requestTimeout=2000;server.timeout=2000;server.keepAliveTimeout=1;
 // Absolute socket lifetime also bounds slow TLS/header senders before the request handler exists.
 server.on('connection',socket=>{const timer=setTimeout(()=>socket.destroy(),2000);socket.once('close',()=>clearTimeout(timer));});
 server.on('checkContinue',(req,res)=>{fail(res,'INVALID_PROTOCOL');req.resume();});
 return server;
}
