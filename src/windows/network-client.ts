import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {setTimeout as sleep} from 'node:timers/promises';
import {Fault} from '../core/errors.js';
import {canonicalDigest} from '../remote/protocol.js';
import {PrivateStore} from './store.js';

export type JsonObject=Record<string,unknown>;
export interface ToolPort {call(name:string,args:JsonObject,signal?:AbortSignal):Promise<unknown>;close():Promise<void>}
export class RemoteToolError extends Fault {constructor(code:string){super(code);}}
export function parseTool(value:unknown):JsonObject{
 const reply=value as {isError?:boolean;content?:Array<{type:string;text?:string}>};
 const item=reply.content?.find(c=>c.type==='text'&&c.text);
 if(!item?.text)throw new Fault('INVALID_MCP_REPLY');
 const data=JSON.parse(item.text) as JsonObject;
 if(reply.isError)throw new RemoteToolError(typeof data.code==='string'?data.code:'REMOTE_TOOL_ERROR');
 return data;
}
/** Each call may use a fresh transport. Business replay belongs to the durable journal, never SDK retries. */
export class HttpToolPort implements ToolPort {
 constructor(readonly url:string,readonly timeoutMs=120000){const u=new URL(url);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&u.hostname==='127.0.0.1'))throw new Fault('UNSAFE_JEV_ENDPOINT');}
 async call(name:string,args:JsonObject,signal?:AbortSignal){
  const client=new Client({name:'Jev Windows executor',version:'0.3.0'});
  const transport=new StreamableHTTPClientTransport(new URL(this.url),{reconnectionOptions:{initialReconnectionDelay:250,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1,maxRetries:0}});
  try{await client.connect(transport,{timeout:this.timeoutMs,signal});signal?.throwIfAborted();return parseTool(await client.callTool({name,arguments:args},undefined,{timeout:this.timeoutMs,signal}));}
  finally{await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}
 }
 async close(){}
}
interface RequestRecord {id:string;method:string;digest:string;phase:'submitted'|'completed'|'rejected'|'unknown';result?:unknown;code?:string;started:number;elapsed_ms?:number}
export class JevNetworkClient {
 private token:string|undefined;
 private loaded=false;
 constructor(readonly store:PrivateStore,readonly port:ToolPort,readonly pollMs=250,readonly waitMs=120000){}
 private async load(){if(!this.loaded){this.token=(await this.store.read<{token?:string}>('continuation'))?.token;this.loaded=true;}}
 private context():JsonObject{return this.token?{continuation_token:this.token}:{};}
 async status(){
  await this.load();const status=await this.port.call('jev.network_status',this.context()) as JsonObject;
  if(typeof status.continuation_token==='string'){this.token=status.continuation_token;await this.store.write('continuation',{token:this.token});}
  const {continuation_token:_secret,...safe}=status;return safe;
 }
 async ready(){const s=await this.status();if(!(s.enabled&&s.connector_online&&s.local_ready))throw new Fault('JEV_NOT_READY_OPERATOR_STATE');return s;}
 async request(id:string,method:string,params:JsonObject,signal?:AbortSignal):Promise<unknown>{
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Fault('INVALID_REQUEST_ID');
  await this.load();const key='request-'+id,digest=canonicalDigest({method,params});
  const release=await this.store.lease(key);
  try{
   let record=await this.store.read<RequestRecord>(key);
   if(record&&record.digest!==digest)throw new Fault('REQUEST_ID_CONFLICT');
   if(record?.phase==='completed')return record.result;
   if(record?.phase==='rejected')throw new Fault(record.code??'REQUEST_REJECTED');
   if(!record){
    await this.ready();if(signal?.aborted)throw new Fault('CANCELLED_BEFORE_DISPATCH');record={id,method,digest,phase:'submitted',started:Date.now()};await this.store.write(key,record);
    try{return await this.settle(record,await this.port.call(method,{request_id:id,params,...this.context()},signal));}
    catch(error){
     if(record.phase==='completed'||record.phase==='rejected')throw error;
     // A lost initial response, including an invalid continuation, is not permission to resubmit.
     return await this.recover(record);
    }
   }
   return await this.recover(record);
  }finally{await release();}
 }
 async recoverRequest(id:string){
  await this.load();const release=await this.store.lease('request-'+id);
  try{const record=await this.store.read<RequestRecord>('request-'+id);if(!record)throw new Fault('LOCAL_REQUEST_NOT_FOUND');
   if(record.phase==='completed')return record.result;if(record.phase==='rejected')throw new Fault(record.code??'REQUEST_REJECTED');return await this.recover(record);
  }finally{await release();}
 }
 private async recover(record:RequestRecord):Promise<unknown>{
  try{return await this.settle(record,await this.port.call('jev.request_status',{request_id:record.id,...this.context()}));}
  catch(error){if(record.phase==='completed'||record.phase==='rejected')throw error;record.phase='unknown';record.code='NETWORK_OUTCOME_UNKNOWN';await this.store.write('request-'+record.id,record);throw new Fault('NETWORK_OUTCOME_UNKNOWN');}
 }
 private async settle(record:RequestRecord,initial:unknown):Promise<unknown>{
  let envelope=initial as JsonObject;const deadline=Date.now()+this.waitMs;
  while(envelope.delivery_status==='QUEUED'||envelope.delivery_status==='DISPATCHED'){
   if(Date.now()>=deadline)throw new Fault('DELIVERY_WAIT_EXPIRED');await sleep(this.pollMs);
   envelope=await this.port.call('jev.request_status',{request_id:record.id,...this.context()}) as JsonObject;
  }
  if(envelope.request_id!==record.id)throw new Fault('REPLY_REQUEST_MISMATCH');
  if(envelope.delivery_status==='COMPLETED'){
   const reply=envelope.reply as {ok?:boolean;result?:unknown;error?:{code?:string}}|undefined;
   if(reply?.ok===true){record.phase='completed';record.result=reply.result;record.elapsed_ms=Date.now()-record.started;await this.store.write('request-'+record.id,record);return reply.result;}
   if(reply?.ok===false){record.phase='rejected';record.code=reply.error?.code??'REMOTE_REJECTED';await this.store.write('request-'+record.id,record);throw new Fault(record.code);}
  }
  // REJECTED/UNKNOWN and malformed responses cannot establish absence of effects.
  throw new Fault('NETWORK_OUTCOME_UNKNOWN');
 }
 async release(){
  await this.load();if(!this.token)return {released:false};
  for(const key of await this.store.keys('request-')){const record=await this.store.read<RequestRecord>(key);if(record?.phase==='submitted'||record?.phase==='unknown')throw new Fault('UNRESOLVED_REQUEST_CONTEXT_RETAINED');}
  const result=await this.port.call('jev.release_connection',this.context()) as JsonObject;
  if(result.released===true){this.token=undefined;await this.store.write('continuation',{});}return result;
 }
 async close(){await this.port.close();}
}
