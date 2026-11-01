import {randomUUID} from 'node:crypto';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolResultSchema,ListToolsResultSchema,InitializeResultSchema,LATEST_PROTOCOL_VERSION,SUPPORTED_PROTOCOL_VERSIONS,type CallToolResult,type Tool,type JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import {Fault} from '../core/errors.js';
import {canonicalJson,canonicalDigest} from '../remote/protocol.js';
import type {ChoiceArgs,ChoiceResponse} from '../choice/contracts.js';
import {choiceSignal,choiceWithin} from '../choice/timing.js';
import {hostSchemas,unknownHostResult,type HostActArgs,type HostActionResult} from './contracts.js';
import {HostJournal} from './journal.js';
export interface HostConfig {serverCommand:string;serverArgs:string[];serverEnv?:Record<string,string>;device?:string}
export interface HostMcpClient {listTools():Promise<{tools:Tool[]}>;callTool(request:{name:string;arguments:Record<string,unknown>}):Promise<CallToolResult>;close():Promise<void>}
export interface HostServiceOptions {storageDir:string;chooseAction:(client:string,args:ChoiceArgs,signal:AbortSignal)=>Promise<ChoiceResponse>;hosts:Record<string,HostConfig>;clientFactory?:(config:HostConfig,host:string,signal:AbortSignal)=>Promise<HostMcpClient>}
/** Transport-only resource limits: 16 MiB JSON/messages and canonical JSON depth 32. */
const HOST_BYTES=16*1024*1024;
function jsonCopy<T>(value:T):T{const text=canonicalJson(value);if(Buffer.byteLength(text)>HOST_BYTES)throw new Fault('HOST_PAYLOAD_LIMIT');return JSON.parse(text) as T;}
function redact<T>(value:T,device?:string):T{const copy=jsonCopy(value);if(!device)return copy;function visit(item:unknown):unknown{if(typeof item==='string')return item.replaceAll(device!,'[configured-device]');if(Array.isArray(item))return item.map(visit);if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,part])=>[key,visit(part)]));return item;}return visit(copy) as T;}
/** SDK stdio transport and validators, without the high-level Client's unavoidable 60-second default timer.
 * There are no retries or implicit reconnects. initialize and every request use normal MCP JSON-RPC.
 */
export async function createHostMcpClient(config:HostConfig,_host?:string,signal?:AbortSignal):Promise<HostMcpClient>{
 if(signal?.aborted)throw new Fault('HOST_UNAVAILABLE');
 const transport=new StdioClientTransport({command:config.serverCommand,args:[...config.serverArgs],env:{...getDefaultEnvironment(),...config.serverEnv},stderr:'ignore',maxBufferSize:HOST_BYTES});
 const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Fault)=>void}>();let dead=false;
 const unavailable=()=>{dead=true;for(const request of pending.values())request.reject(new Fault('HOST_UNAVAILABLE'));pending.clear();};
 const abort=()=>{unavailable();void transport.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 transport.onclose=unavailable;transport.onerror=unavailable;
 transport.onmessage=(message:JSONRPCMessage)=>{if('method' in message){if('id' in message)void transport.send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported host client method'}}).catch(unavailable);return;}if(!('id' in message)||typeof message.id!=='string')return;const request=pending.get(message.id);if(!request)return;pending.delete(message.id);if('error' in message)request.reject(new Fault('HOST_TOOL_ERROR'));else request.resolve(message.result);};
 const request=(method:string,params:Record<string,unknown>)=>new Promise<unknown>((resolve,reject)=>{if(dead){reject(new Fault('HOST_UNAVAILABLE'));return;}const id=randomUUID();pending.set(id,{resolve,reject});void transport.send({jsonrpc:'2.0',id,method,params}).catch(()=>{pending.delete(id);reject(new Fault('HOST_UNAVAILABLE'));});});
 try{await transport.start();if(signal?.aborted)throw new Fault('HOST_UNAVAILABLE');const initialized=InitializeResultSchema.parse(await request('initialize',{protocolVersion:LATEST_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'jev-host-bridge',version:'1.0.0'}}));if(!SUPPORTED_PROTOCOL_VERSIONS.includes(initialized.protocolVersion))throw new Fault('HOST_PROTOCOL_UNSUPPORTED');await transport.send({jsonrpc:'2.0',method:'notifications/initialized'});}
 catch{unavailable();signal?.removeEventListener('abort',abort);await transport.close();throw new Fault('HOST_UNAVAILABLE');}
 return {listTools:async()=>{const tools:Tool[]=[],cursors=new Set<string>();let cursor:string|undefined;do{const result=ListToolsResultSchema.parse(await request('tools/list',cursor?{cursor}:{}));tools.push(...result.tools);cursor=result.nextCursor;if(cursor){if(cursors.has(cursor))throw new Fault('HOST_INVALID_RESPONSE');cursors.add(cursor);}}while(cursor);return {tools};},callTool:async params=>CallToolResultSchema.parse(await request('tools/call',params)),close:async()=>{unavailable();signal?.removeEventListener('abort',abort);await transport.close();}};
}
type Job={owner:string;args:HostActArgs;controller:AbortController;context:ReturnType<typeof choiceSignal>;decision?:ChoiceResponse;finished:boolean};
/** Operator-selected MCP backends only. Each successful call means one MCP tool returned, never that the user's task is complete.
 * Observation/state is supplied by the caller; this generic bridge promises no built-in UI grounding or verification. */
export class HostService {
 private readonly journal:HostJournal;private readonly hosts:Record<string,HostConfig>;private readonly clients=new Map<string,Promise<HostMcpClient>>();private readonly clientStops=new Map<string,AbortController>();private readonly tails=new Map<string,Promise<void>>();private readonly jobs=new Set<Job>();private readonly revoked=new Set<string>();private closed=false;
 constructor(private readonly options:HostServiceOptions){this.hosts=jsonCopy(options.hosts);for(const [name,config] of Object.entries(this.hosts)){if(!name||!config.serverCommand||!Array.isArray(config.serverArgs)||!config.serverArgs.every(arg=>typeof arg==='string')||(config.device!==undefined&&(!config.device||typeof config.device!=='string'))||!Object.values(config.serverEnv??{}).every(value=>typeof value==='string'))throw new Fault('INVALID_HOST_CONFIGURATION');}this.journal=new HostJournal(options.storageDir);}
 private check(owner:string){if(this.closed)throw new Fault('HOST_CLOSED');if(!owner||this.revoked.has(owner))throw new Fault('FORBIDDEN');}
 private config(host:string){if(!Object.hasOwn(this.hosts,host))throw new Fault('HOST_UNAVAILABLE');return this.hosts[host]!;}
 private client(host:string){const config=this.config(host);let client=this.clients.get(host);if(!client){const stop=new AbortController();this.clientStops.set(host,stop);client=Promise.resolve().then(()=>(this.options.clientFactory??createHostMcpClient)(config,host,stop.signal));this.clients.set(host,client);}return client;}
 async tools(owner:string,input:unknown):Promise<{host:string;tools:Tool[]}>{
  this.check(owner);const {host}=hostSchemas.host_tools.parse(input),config=this.config(host);
  try{const backend=await this.client(host),listed=await backend.listTools();this.check(owner);return {host,tools:listed.tools.map(tool=>{const copy=redact(tool,config.device);if(copy.inputSchema.properties)delete copy.inputSchema.properties.device;if(copy.inputSchema.required)copy.inputSchema.required=copy.inputSchema.required.filter(name=>name!=='device');return copy;})};}
  catch(error){this.check(owner);throw error instanceof Fault?error:new Fault('HOST_UNAVAILABLE');}
 }
 private markUnknown(job:Job,result?:CallToolResult){if(job.finished)return;const response=job.decision?unknownHostResult(job.decision):undefined;if(response&&result)response.result=result;this.journal.unknown(job.owner,job.args,response);job.finished=true;}
 async act(owner:string,input:unknown,parentSignal:AbortSignal=new AbortController().signal):Promise<HostActionResult>{
  this.check(owner);const args=jsonCopy(hostSchemas.host_act.parse(input));this.config(args.host);const prior=this.journal.begin(owner,args);this.check(owner);if(prior.status!=='started'){if(prior.response)return prior.response;throw new Fault('HOST_ACTION_UNKNOWN');}
  const controller=new AbortController(),context=choiceSignal(AbortSignal.any([parentSignal,controller.signal]),args.timeout_ms),job:Job={owner,args,controller,context,finished:false};this.jobs.add(job);
  const previous=this.tails.get(args.host)??Promise.resolve();const work=previous.then(()=>this.run(job));const tail=work.then(()=>{},()=>{});this.tails.set(args.host,tail);void tail.then(()=>{this.jobs.delete(job);if(this.tails.get(args.host)===tail)this.tails.delete(args.host);});
  try{const response=await choiceWithin(work,context.signal);this.check(owner);context.check();return response;}
  catch(error){this.markUnknown(job);this.check(owner);if(job.decision){const saved=this.journal.begin(owner,args);if(saved.status!=='started'&&saved.response)return saved.response;return unknownHostResult(job.decision);}throw error instanceof Fault?error:new Fault('HOST_UNAVAILABLE');}
  finally{context.close();}
 }
 private async run(job:Job):Promise<HostActionResult>{
  const {owner,args,context}=job,config=this.config(args.host);const check=()=>{this.check(owner);context.check();};
  try{
   check();const backend=await choiceWithin(this.client(args.host),context.signal);check();const listed=await choiceWithin(backend.listTools(),context.signal);check();const byName=new Map(listed.tools.map(tool=>[tool.name,tool]));
   for(const action of args.actions){const definition=byName.get(action.tool);if(!definition)throw new Fault('HOST_TOOL_UNAVAILABLE');if(Object.hasOwn(action.arguments,'device'))throw new Fault('HOST_ARGUMENTS_INVALID');if((definition.inputSchema.required?.includes('device')||Object.hasOwn(definition.inputSchema.properties??{},'device'))&&!config.device)throw new Fault('HOST_DEVICE_REQUIRED');}
   const choiceArgs:ChoiceArgs={idempotency_key:canonicalDigest({namespace:'host-decision-v1',host:args.host,key:args.idempotency_key}),task:args.task,state:args.state,actions:args.actions.map(action=>({id:action.id,description:action.description})),...(args.timeout_ms===undefined?{}:{timeout_ms:args.timeout_ms})};
   const decision=await choiceWithin(this.options.chooseAction(owner,choiceArgs,context.signal),context.signal);check();const selected=args.actions.find(action=>action.id===decision.selected_id);if(!selected)throw new Fault('INVALID_RESPONSE');job.decision=decision;this.journal.selected(owner,args,decision);check();
   const definition=byName.get(selected.tool)!,parameters:Record<string,unknown>=jsonCopy(selected.arguments),needsDevice=definition.inputSchema.required?.includes('device')||Object.hasOwn(definition.inputSchema.properties??{},'device');if(needsDevice){if(!config.device)throw new Fault('HOST_DEVICE_REQUIRED');parameters.device=config.device;}
   // Intentionally do not abort this underlying MCP promise. Cancellation cannot prove a physical action stopped.
   // The caller may receive UNKNOWN immediately; this host's queue remains held until the backend settles.
   check();const raw=await backend.callTool({name:selected.tool,arguments:parameters});check();const result=redact(CallToolResultSchema.parse(raw),config.device);
   if(result.isError){this.markUnknown(job,result);return {...unknownHostResult(decision),result};}
   if(job.finished)return unknownHostResult(decision);const response:HostActionResult={decision,selected_id:selected.id,execution:'executed',result};this.journal.complete(owner,args,response);job.finished=true;check();return response;
  }catch(error){this.markUnknown(job);throw error;}
 }
 revokeOwner(owner:string){this.revoked.add(owner);for(const job of this.jobs)if(job.owner===owner){this.markUnknown(job);job.controller.abort();}}
 async shutdown(){if(this.closed)return;this.closed=true;for(const job of this.jobs){this.markUnknown(job);job.controller.abort();}for(const stop of this.clientStops.values())stop.abort();await Promise.allSettled([...this.clients.values()].map(async client=>(await client).close()));this.journal.close();}
}
