import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Fault} from '../core/errors.js';
import type {OwnerContext} from './front.js';
export function parseTool(value:unknown):Record<string,unknown>{const result=value as {isError?:boolean;content?:{type:string;text?:string}[]},text=result?.content?.find(item=>item.type==='text')?.text;if(!text)throw new Fault('INVALID_RESPONSE');let obj:Record<string,unknown>;try{obj=JSON.parse(text);}catch{throw new Fault('INVALID_RESPONSE');}if(result.isError)throw new Fault(typeof obj.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(obj.code)?obj.code:'UPSTREAM_ERROR');return obj;}
export function ownerContext(status:Record<string,unknown>):OwnerContext{
 if(status.enabled!==true||status.connector_online!==true||status.local_ready!==true||typeof status.continuation_token!=='string'||typeof status.connection_id!=='string')throw new Fault('ADMISSION_REQUIRED');
 return {owner:createHash('sha256').update(status.connection_id+'\0'+status.continuation_token).digest('hex'),token:status.continuation_token};
}
export interface ValidationSession{status(token:string):Promise<Record<string,unknown>>;close():Promise<void>}
async function connectValidator(endpoint:string):Promise<ValidationSession>{
 const transport=new StreamableHTTPClientTransport(new URL(endpoint),{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(5000)])}),reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}}),client=new Client({name:'jev-mac-owner-validator',version:'1.0.0'});
 try{await client.connect(transport,{timeout:5000});}catch{await client.close().catch(()=>{});throw new Fault('AUTHORIZATION_UNAVAILABLE');}
 return {status:async token=>parseTool(await client.callTool({name:'jev.network_status',arguments:{continuation_token:token},_meta:{'io.jev.mac-public.authorization-only':true}},undefined,{timeout:5000})),close:async()=>{await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}};
}
/** One owned diagnostic transport; each call carries its own immutable end-user token. Never releases an end-user owner. */
export class OwnerValidator{
 private session?:Promise<ValidationSession>;private closed=false;
 constructor(private endpoint:string,private factory:(endpoint:string)=>Promise<ValidationSession>=connectValidator){}
 async validate(token:string,expected:string):Promise<OwnerContext>{
  if(this.closed)throw new Fault('AUTHORIZATION_UNAVAILABLE');const session=this.session??=this.factory(this.endpoint);
  try{const owner=ownerContext(await (await session).status(token));if(owner.owner!==expected||owner.token!==token)throw new Fault('OWNER_REVOKED');return owner;}
  catch(error){if(!(error instanceof Fault&&['CONTINUATION_INVALID','ADMISSION_REQUIRED','OWNER_REVOKED','FORBIDDEN'].includes(error.code))){if(this.session===session)this.session=undefined;void session.then(client=>client.close(),()=>{}).catch(()=>{});}throw error instanceof Fault?error:new Fault('AUTHORIZATION_UNAVAILABLE');}
 }
 async close(){this.closed=true;const session=this.session;this.session=undefined;if(session)try{await (await session).close();}catch{/* Diagnostic teardown has no authority over user contexts. */}}
}
