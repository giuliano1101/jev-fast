import {createServer,type Server,type Socket} from 'node:net';
import {mkdir,lstat,open,chmod,unlink,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Engine} from '../core/engine.js';
import {Fault} from '../core/errors.js';
import {parseTool} from './contracts.js';
import {encodeFrame,MAX_FRAME_BYTES,MAX_CALL_MS,requestSchema,safeCode,type Reply} from './ipc.js';
export interface CoordinatorOptions {runtimeDir:string;engine:Engine;clients:readonly string[];transportTimeoutMs?:number;health?:()=>Promise<Record<string,unknown>>;onStop?:()=>Promise<void>;}
export class Coordinator {
 private server:Server;
 private sockets=new Set<Socket>();
 private tokens=new Map<string,string>();
 private lock?:FileHandle;
 private credentialFiles:string[]=[];
 private closing?:Promise<void>;
 private stopping=false;
 private readonly instanceId=randomUUID();
 private constructor(private options:CoordinatorOptions){this.server=createServer(socket=>this.accept(socket));}
 static async start(options:CoordinatorOptions):Promise<Coordinator>{
  if(options.transportTimeoutMs!==undefined&&(!Number.isInteger(options.transportTimeoutMs)||options.transportTimeoutMs<10||options.transportTimeoutMs>MAX_CALL_MS))throw new Fault('INVALID_TIMEOUT');
  if(!options.clients.length||options.clients.some(c=>!/^[-a-zA-Z0-9_]{1,32}$/.test(c)||c==='operator')||new Set(options.clients).size!==options.clients.length)throw new Fault('INVALID_CLIENTS');
  if(Buffer.byteLength(join(options.runtimeDir,'coordinator.sock'))>100)throw new Fault('SOCKET_PATH_TOO_LONG');
  await mkdir(options.runtimeDir,{recursive:true,mode:0o700});const info=await lstat(options.runtimeDir);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o700)throw new Fault('UNSAFE_RUNTIME');
  const coordinator=new Coordinator(options);
  try{coordinator.lock=await open(join(options.runtimeDir,'service.lock'),'wx',0o600);}catch{throw new Fault('SERVICE_ALREADY_RUNNING');}
  try{
   await coordinator.lock.writeFile(JSON.stringify({pid:process.pid})+'\n');
   const path=join(options.runtimeDir,'coordinator.sock');
   await new Promise<void>((resolve,reject)=>{coordinator.server.once('error',reject);coordinator.server.listen(path,resolve);});
   await chmod(path,0o600);
   for(const identity of [...options.clients,'operator']){
    const token=randomBytes(32).toString('hex');coordinator.tokens.set(token,identity);
    const filename=identity==='operator'?'operator.json':`client-${identity}.json`;
    // Exclusive creation blocks symlink replacement; clean shutdown removes credentials.
    const credentialFile=await open(join(options.runtimeDir,filename),'wx',0o600);coordinator.credentialFiles.push(filename);
    try{await credentialFile.writeFile(JSON.stringify({version:1,socket:path,token})+'\n');}finally{await credentialFile.close();}
   }
   return coordinator;
  }catch(error){await coordinator.releaseFiles();throw error;}
 }
 private accept(socket:Socket){
  this.sockets.add(socket);const deadline=setTimeout(()=>socket.destroy(),this.options.transportTimeoutMs??MAX_CALL_MS);
  socket.on('close',()=>{clearTimeout(deadline);this.sockets.delete(socket);});socket.on('error',()=>{});
  let buffer=Buffer.alloc(0);let consumed=false;
  const send=(reply:Reply)=>{if(socket.destroyed)return;try{socket.end(encodeFrame(reply));}catch{socket.end(encodeFrame({ok:false,error:{code:'FRAME_TOO_LARGE'}}));}};
  socket.on('data',(chunk:Buffer)=>{
   if(consumed){socket.destroy();return;}
   if(buffer.length+chunk.length>MAX_FRAME_BYTES){consumed=true;send({ok:false,error:{code:'FRAME_TOO_LARGE'}});return;}
   buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf(10);if(end<0)return;consumed=true;
   let value:unknown;try{if(end!==buffer.length-1)throw new Error();value=JSON.parse(buffer.subarray(0,end).toString('utf8'));}catch{send({ok:false,error:{code:'INVALID_REQUEST'}});return;}
   void this.dispatch(value).then(result=>send({ok:true,result}),error=>send({ok:false,error:{code:safeCode(error)}}));
  });
 }
 private async dispatch(value:unknown):Promise<unknown>{
  const request=requestSchema.safeParse(value);if(!request.success)throw new Fault('INVALID_REQUEST');
  const {token,method,params}=request.data;const client=this.tokens.get(token);if(!client)throw new Fault('UNAUTHORIZED');
  if(method==='service.health'||method==='service.local_health'||method==='service.stop'){
   if(!z.strictObject({}).safeParse(params).success)throw new Fault('INVALID_ARGUMENTS');
   if(method==='service.local_health')return {ready:!this.stopping,instance_id:this.instanceId};
   if(method==='service.health')return {...(this.options.health?await this.options.health():{provider:'mock'}),ready:!this.stopping,active_session_limit:1};
   if(client!=='operator')throw new Fault('UNAUTHORIZED');
   this.stopping=true;await this.options.engine.kill();
   setImmediate(()=>{void this.close().catch(()=>{process.stderr.write('SERVICE_SHUTDOWN_FAILED\n');});});
   return {stopping:true};
  }
  if(this.stopping)throw new Fault('KILLED');if(client==='operator')throw new Fault('UNAUTHORIZED');
  const args=parseTool(method,params);const engine=this.options.engine;
  switch(method){
   case 'jev.open_session':return engine.openSession(client,args);
   case 'jev.observe':return engine.observe(client,args);
   case 'jev.run_goal':return engine.runGoal(client,args);
   case 'jev.cancel':return engine.cancel(client,args);
   case 'jev.status':return engine.status(client,args);
   case 'jev.close_session':return engine.closeSession(client,args);
   default:throw new Fault('UNKNOWN_METHOD');
  }
 }
 private async releaseFiles(){
  for(const socket of this.sockets)socket.destroy();
  if(this.server.listening)await new Promise<void>(resolve=>this.server.close(()=>resolve()));
  await this.lock?.close();
  await Promise.all([...this.credentialFiles,'service.lock'].map(name=>unlink(join(this.options.runtimeDir,name)).catch(()=>{})));
 }
 close():Promise<void>{
  if(this.closing)return this.closing;this.stopping=true;
  this.closing=(async()=>{try{try{await this.options.engine.shutdown();}finally{await this.options.onStop?.();}}finally{await this.releaseFiles();}})();return this.closing;
 }
}
