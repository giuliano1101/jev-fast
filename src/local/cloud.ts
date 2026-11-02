import {randomUUID} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {CallToolResultSchema,InitializeResultSchema,ListToolsResultSchema,LATEST_PROTOCOL_VERSION,SUPPORTED_PROTOCOL_VERSIONS} from '@modelcontextprotocol/sdk/types.js';
import {choiceArgsSchema,type ChoiceArgs,type ChoiceResponse} from '../choice/contracts.js';
import {choiceResponseSchema} from '../remote/choice.js';
import {canonicalDigest} from '../remote/protocol.js';
import {preparePrivateDirectory,assertPrivateFile} from '../service/private-directory.js';
export interface PublicJevCloudOptions {stateDir:string;endpoint?:string;transportFactory?:()=>Transport;pollIntervalMs?:number}
export const DEFAULT_JEV_ENDPOINT='https://jev.43-160-233-161.sslip.io/mcp';
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CLOUD_INVALID_RESPONSE');return value as Record<string,unknown>;}
function safeCode(error:unknown){const code=error instanceof Error?error.message:'';return /^[A-Z][A-Z0-9_]*$/.test(code)?code:'CLOUD_UNAVAILABLE';}
/** TLS authenticates the public service. This checks receipt shape and request/result bindings; no local fake Jev receipt is produced. */
export function validatePublicDecision(value:unknown,args:ChoiceArgs):ChoiceResponse{
 const parsed=choiceResponseSchema.safeParse(value);if(!parsed.success)throw Error('CLOUD_INVALID_DECISION');
 const response=parsed.data,{proof,...decision}=response,payload=proof.payload;
 if(Buffer.from(proof.signature,'base64url').length!==64||payload.request_digest!==canonicalDigest(args)||payload.response_digest!==canonicalDigest(decision)||payload.provider!==response.provider||payload.model!==response.model||payload.selected_id!==response.selected_id||!args.actions.some(action=>action.id===response.selected_id))throw Error('CLOUD_INVALID_DECISION');
 return response;
}
/** No SDK request timeout, automatic admission bypass, business retry or hosted browser calls. */
export class PublicJevCloud{
 private transport?:Transport;private connecting?:Promise<void>;private token?:string;private blocked?:string;private closed=false;private uncertain=false;private requestId?:string;
 private readonly pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();private readonly auditPath:string;
 constructor(private readonly options:PublicJevCloudOptions){
  const endpoint=new URL(options.endpoint??DEFAULT_JEV_ENDPOINT);
  if(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))throw Error('CLOUD_TLS_REQUIRED');
  if(endpoint.username||endpoint.password)throw Error('INVALID_CLOUD_ENDPOINT');
  this.auditPath=join(preparePrivateDirectory(options.stateDir),'cloud-requests.jsonl');
  try{assertPrivateFile(this.auditPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 private fail(){for(const pending of this.pending.values())pending.reject(Error('CLOUD_UNAVAILABLE'));this.pending.clear();this.transport=undefined;}
 private async connect(){
  if(this.closed)throw Error('CLOUD_CLOSED');if(this.blocked)throw Error(this.blocked);
  if(this.connecting)return this.connecting;
  if(this.transport)return;
  this.connecting=(async()=>{
   const transport:Transport=this.options.transportFactory?.()??new StreamableHTTPClientTransport(new URL(this.options.endpoint??DEFAULT_JEV_ENDPOINT),{reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
   this.transport=transport;transport.onclose=()=>{if(this.transport===transport)this.fail();};transport.onerror=()=>{if(this.transport===transport)this.fail();};
   transport.onmessage=message=>{if('method'in message){if('id'in message)void transport.send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported client method'}}).catch(()=>{});return;}if(typeof message.id!=='string')return;const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);if('error'in message)pending.reject(Error('CLOUD_RPC_ERROR'));else pending.resolve(message.result);};
   try{await transport.start();const initialized=InitializeResultSchema.parse(await this.request('initialize',{protocolVersion:LATEST_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'jev-local-browser',version:'1.0.0'}}));if(!SUPPORTED_PROTOCOL_VERSIONS.includes(initialized.protocolVersion))throw Error('CLOUD_PROTOCOL_UNSUPPORTED');await transport.send({jsonrpc:'2.0',method:'notifications/initialized'});const listed=ListToolsResultSchema.parse(await this.request('tools/list',{}));if(!listed.tools.some(tool=>tool.name==='jev.choose_action'))throw Error('CLOUD_CHOICE_UNAVAILABLE');}
   catch(error){this.fail();await transport.close().catch(()=>{});throw error;}
  })();try{await this.connecting;}finally{this.connecting=undefined;}
 }
 private request(method:string,params:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>{
  if(signal?.aborted)return Promise.reject(Error('CLOUD_WAIT_ABORTED'));
  const transport=this.transport;if(!transport)return Promise.reject(Error('CLOUD_UNAVAILABLE'));
  return new Promise((resolve,reject)=>{
   const id=randomUUID(),abort=()=>{this.pending.delete(id);reject(Error('CLOUD_WAIT_ABORTED'));};
   signal?.addEventListener('abort',abort,{once:true});
   this.pending.set(id,{resolve:value=>{signal?.removeEventListener('abort',abort);resolve(value);},reject:error=>{signal?.removeEventListener('abort',abort);reject(error);}});
   void transport.send({jsonrpc:'2.0',id,method,params}).catch(()=>{const pending=this.pending.get(id);this.pending.delete(id);pending?.reject(Error('CLOUD_UNAVAILABLE'));});
  });
 }
 private async call(name:string,args:Record<string,unknown>={},signal?:AbortSignal){
  await this.connect();const response=CallToolResultSchema.parse(await this.request('tools/call',{name,arguments:{...args,...(this.token?{continuation_token:this.token}:{})}},signal));
  const item=response.content.find(item=>item.type==='text');if(!item||item.type!=='text')throw Error('CLOUD_INVALID_RESPONSE');
  let value:Record<string,unknown>;try{value=record(JSON.parse(item.text));}catch{throw Error('CLOUD_INVALID_RESPONSE');}
  if(response.isError){const code=typeof value.code==='string'&&/^[A-Z][A-Z0-9_]*$/.test(value.code)?value.code:'CLOUD_TOOL_ERROR';if(['CONTINUATION_INVALID','FORBIDDEN','ADMISSION_REQUIRED'].includes(code))this.blocked=code;throw Error(code);}
  return value;
 }
 async status():Promise<{ready:boolean;code?:string;[key:string]:unknown}>{
  if(this.blocked)return {ready:false,code:this.blocked,...(this.requestId?{request_id:this.requestId}:{})};
  try{
   const value=await this.call('jev.network_status');
   if(typeof value.continuation_token==='string'&&value.continuation_token)this.token=value.continuation_token;
   const ready=!this.uncertain&&value.enabled===true&&value.connector_online===true&&value.local_ready===true&&value.continuation_supported===true&&!!this.token;
   return {ready,enabled:value.enabled===true,connector_online:value.connector_online===true,local_ready:value.local_ready===true,continuation_supported:value.continuation_supported===true,...(!ready?{code:this.uncertain?'CLOUD_DECISION_UNCERTAIN':'CLOUD_NOT_READY'}:{}),...(this.requestId?{request_id:this.requestId,uncertain:this.uncertain}:{})};
  }catch(error){return {ready:false,code:safeCode(error),...(this.requestId?{request_id:this.requestId,uncertain:this.uncertain}:{})};}
 }
 async choose(input:ChoiceArgs,signal:AbortSignal):Promise<ChoiceResponse>{
  const args=choiceArgsSchema.parse(input),status=await this.status();if(!status.ready)throw Error(status.code??'CLOUD_NOT_READY');
  const request_id=randomUUID();this.requestId=request_id;
  appendFileSync(this.auditPath,JSON.stringify({request_id,idempotency_digest:canonicalDigest(args.idempotency_key),request_digest:canonicalDigest(args),created_at:new Date().toISOString()})+'\n',{mode:0o600});
  try{
   let envelope:Record<string,unknown>;
   try{envelope=await this.call('jev.choose_action',{request_id,params:args},signal);}
   catch(error){if(signal.aborted||this.blocked)throw error;envelope=await this.call('jev.request_status',{request_id},signal);}
   while(envelope.delivery_status==='QUEUED'||envelope.delivery_status==='DISPATCHED'){
    await sleep(this.options.pollIntervalMs??250,undefined,{signal});envelope=await this.call('jev.request_status',{request_id},signal);
   }
   if(envelope.delivery_status!=='COMPLETED')throw Error(envelope.delivery_status==='UNKNOWN'?'CLOUD_DECISION_UNKNOWN':'CLOUD_DECISION_REJECTED');
   const reply=record(envelope.reply);if(reply.ok!==true){const error=record(reply.error);throw Error(typeof error.code==='string'?error.code:'CLOUD_CHOICE_FAILED');}
   const decision=validatePublicDecision(reply.result,args);appendFileSync(this.auditPath,JSON.stringify({request_id,delivery_status:'COMPLETED',decision_id:decision.proof.payload.decision_id})+'\n',{mode:0o600});return decision;
  }catch(error){this.uncertain=true;throw error;}
 }
 async close(){
  if(this.closed)return;
  if(this.token&&!this.uncertain&&!this.blocked)try{await this.call('jev.release_connection');}catch{/* A failed release is not proof of completion. */}
  this.closed=true;const transport=this.transport;this.fail();if(transport instanceof StreamableHTTPClientTransport)await transport.terminateSession().catch(()=>{});await transport?.close().catch(()=>{});
 }
}
