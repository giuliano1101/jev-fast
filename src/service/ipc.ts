import {createConnection} from 'node:net';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname} from 'node:path';
import {z} from 'zod';
import {Fault} from '../core/errors.js';
export const MAX_FRAME_BYTES=16*1024*1024;
/** Diagnostic and incomplete-frame timeout; never a default business execution budget. */
export const MAX_CALL_MS=65000;
/** A small transport grace allows the caller's execution timeout to return its result. */
export function requestedRpcTimeoutMs(method:string,params:unknown,diagnosticTimeoutMs=MAX_CALL_MS):number|null {
 const args=params&&typeof params==='object'?params as Record<string,unknown>:{};
 if(method==='service.network_dispatch')return typeof args.method==='string'?requestedRpcTimeoutMs(args.method,args.params,diagnosticTimeoutMs):diagnosticTimeoutMs;
 if(!method.startsWith('jev.'))return diagnosticTimeoutMs;
 const budget=args.time_budget_ms??args.timeout_ms;
 return typeof budget==='number'&&Number.isSafeInteger(budget)&&budget>0?Math.min(Number.MAX_SAFE_INTEGER,budget+5000):null;
}
/** Node timers overflow above 2^31-1 ms, so long caller deadlines use successive chunks. */
export function startRpcDeadline(timeoutMs:number|null,onDeadline:()=>void):()=>void {
 if(timeoutMs===null)return ()=>{};
 const end=Date.now()+timeoutMs;let timer:ReturnType<typeof setTimeout>|undefined,cancelled=false;
 const next=()=>{if(cancelled)return;const remaining=end-Date.now();if(remaining<=0){onDeadline();return;}timer=setTimeout(next,Math.min(remaining,2147483647));};
 next();return ()=>{cancelled=true;clearTimeout(timer);};
}
export const credentialSchema=z.strictObject({version:z.literal(1),socket:z.string().min(1).max(100),token:z.string().regex(/^[0-9a-f]{64}$/)});
export type Credential=z.infer<typeof credentialSchema>;
export type Reply={ok:true;result:unknown}|{ok:false;error:{code:string}};
export const requestSchema=z.strictObject({token:z.string().regex(/^[0-9a-f]{64}$/),method:z.string().min(1).max(64),params:z.unknown()});
export function safeCode(error:unknown):string{return error instanceof Fault&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?error.code:'INTERNAL_FAILURE';}
export function encodeFrame(value:unknown):string {const frame=JSON.stringify(value)+'\n';if(Buffer.byteLength(frame)>MAX_FRAME_BYTES)throw new Fault('FRAME_TOO_LARGE');return frame;}
export async function readCredential(path:string):Promise<Credential>{
 try{
  const parent=await lstat(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o777)!==0o700)throw new Error();
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=await file.stat();if(!info.isFile()||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||info.size>4096)throw new Error();const credential=credentialSchema.parse(JSON.parse(await file.readFile('utf8')));const socket=await lstat(credential.socket);if(!socket.isSocket()||socket.uid!==process.getuid?.()||(socket.mode&0o777)!==0o600||dirname(credential.socket)!==dirname(path))throw new Error();return credential;}finally{await file.close();}
 }catch{throw new Fault('UNSAFE_CREDENTIAL');}
}
export async function ipcCall(credential:Credential,method:string,params:unknown):Promise<unknown>{
 const parsed=credentialSchema.safeParse(credential);if(!parsed.success)throw new Fault('UNAUTHORIZED');
 const frame=encodeFrame({token:credential.token,method,params});
 return new Promise((resolve,reject)=>{
  const socket=createConnection(credential.socket);let buffer=Buffer.alloc(0);let settled=false;
  const finish=(error:Fault|null,value?:unknown)=>{if(settled)return;settled=true;cancelDeadline();socket.destroy();if(error)reject(error);else resolve(value);};
  const cancelDeadline=startRpcDeadline(requestedRpcTimeoutMs(method,params),()=>finish(new Fault('TRANSPORT_TIMEOUT')));
  socket.on('connect',()=>socket.write(frame));
  socket.on('data',(chunk:Buffer)=>{
   if(buffer.length+chunk.length>MAX_FRAME_BYTES){finish(new Fault('FRAME_TOO_LARGE'));return;}
   buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf(10);if(end<0)return;
   try{const reply=z.discriminatedUnion('ok',[z.strictObject({ok:z.literal(true),result:z.unknown()}),z.strictObject({ok:z.literal(false),error:z.strictObject({code:z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)})})]).parse(JSON.parse(buffer.subarray(0,end).toString('utf8')));if(reply.ok)finish(null,reply.result);else finish(new Fault(reply.error.code));}catch{finish(new Fault('INVALID_RESPONSE'));}
  });
  socket.on('error',()=>finish(new Fault('SERVICE_UNAVAILABLE')));socket.on('end',()=>finish(new Fault('RESPONSE_LOST')));
 });
}
