import {createServer,type Server,type Socket} from 'node:net';
import {mkdir,lstat,open,chmod,unlink,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Engine} from '../core/engine.js';
import {Fault} from '../core/errors.js';
import {parseTool} from './contracts.js';
import {encodeFrame,MAX_FRAME_BYTES,MAX_CALL_MS,requestedRpcTimeoutMs,startRpcDeadline,requestSchema,safeCode,type Reply} from './ipc.js';
import type {ChoiceArgs} from '../choice/contracts.js';
import type {HostService} from '../host/service.js';
import type {RealBrowserService} from '../browser/real.js';
export interface CoordinatorOptions {runtimeDir:string;engine:Engine;clients:readonly string[];transportTimeoutMs?:number;health?:()=>Promise<Record<string,unknown>>;chooseAction?:(client:string,args:ChoiceArgs,signal:AbortSignal)=>Promise<unknown>;realBrowser?:RealBrowserService;hostService?:HostService;hostNames?:readonly string[];onStop?:()=>Promise<void>;}
export class Coordinator {
 private server:Server;
 private sockets=new Set<Socket>();
 private tokens=new Map<string,string>();
 private lock?:FileHandle;
 private credentialFiles:string[]=[];
 private closing?:Promise<void>;
 private stopping=false;
 private networkOwners=new Set<string>();
 private choices=new Map<AbortController,{client:string;done:Promise<unknown>}>();
 private readonly instanceId=randomUUID();
 private constructor(private options:CoordinatorOptions){this.server=createServer(socket=>this.accept(socket));}
 static async start(options:CoordinatorOptions):Promise<Coordinator>{
  if(options.transportTimeoutMs!==undefined&&(!Number.isInteger(options.transportTimeoutMs)||options.transportTimeoutMs<10||!Number.isSafeInteger(options.transportTimeoutMs)))throw new Fault('INVALID_TIMEOUT');
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
  this.sockets.add(socket);let cancelDeadline=startRpcDeadline(this.options.transportTimeoutMs??MAX_CALL_MS,()=>socket.destroy());
  socket.on('close',()=>{cancelDeadline();this.sockets.delete(socket);});socket.on('error',()=>{});
  let buffer=Buffer.alloc(0);let consumed=false;
  const send=(reply:Reply)=>{if(socket.destroyed)return;try{socket.end(encodeFrame(reply));}catch{socket.end(encodeFrame({ok:false,error:{code:'FRAME_TOO_LARGE'}}));}};
  socket.on('data',(chunk:Buffer)=>{
   if(consumed){socket.destroy();return;}
   if(buffer.length+chunk.length>MAX_FRAME_BYTES){consumed=true;send({ok:false,error:{code:'FRAME_TOO_LARGE'}});return;}
   buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf(10);if(end<0)return;consumed=true;
   let value:unknown;try{if(end!==buffer.length-1)throw new Error();value=JSON.parse(buffer.subarray(0,end).toString('utf8'));}catch{send({ok:false,error:{code:'INVALID_REQUEST'}});return;}
   cancelDeadline();const parsed=requestSchema.safeParse(value);cancelDeadline=startRpcDeadline(this.options.transportTimeoutMs??(parsed.success?requestedRpcTimeoutMs(parsed.data.method,parsed.data.params):MAX_CALL_MS),()=>socket.destroy());
   void this.dispatch(value).then(result=>send({ok:true,result}),error=>send({ok:false,error:{code:safeCode(error)}}));
  });
 }
 private async dispatch(value:unknown):Promise<unknown>{
  const request=requestSchema.safeParse(value);if(!request.success)throw new Fault('INVALID_REQUEST');
  const {token,method,params}=request.data;const client=this.tokens.get(token);if(!client)throw new Fault('UNAUTHORIZED');
  if(method==='service.health'||method==='service.local_health'||method==='service.stop'){
   if(!z.strictObject({}).safeParse(params).success)throw new Fault('INVALID_ARGUMENTS');
   if(method==='service.local_health')return {ready:!this.stopping,instance_id:this.instanceId};
   if(method==='service.health')return {...(this.options.health?await this.options.health():{provider:'mock'}),ready:!this.stopping,active_session_limit:null,general_choice_available:!!this.options.chooseAction,real_browser_available:!!this.options.realBrowser,configured_hosts:this.options.hostNames??[]};
   if(client!=='operator')throw new Fault('UNAUTHORIZED');
   this.stopping=true;await this.abortChoices(()=>true);await this.options.engine.kill();
   setImmediate(()=>{void this.close().catch(()=>{process.stderr.write('SERVICE_SHUTDOWN_FAILED\n');});});
   return {stopping:true};
  }
  if(this.stopping)throw new Fault('KILLED');if(client==='operator')throw new Fault('UNAUTHORIZED');
  if(method.startsWith('service.network_')){
   if(client!=='a')throw new Fault('UNAUTHORIZED');
   if(method==='service.network_reconcile'){
    const input=z.strictObject({owners:z.array(z.string().regex(/^network-[a-f0-9]{64}$/))}).parse(params);
    const removed=[...this.networkOwners].filter(owner=>!input.owners.includes(owner));for(const owner of removed)await this.revokeGeneralOwner(owner);this.networkOwners=new Set(input.owners);
    return this.options.engine.reconcileNetworkOwners(input.owners);
   }
   if(method==='service.network_revoke'){
    const input=z.strictObject({owner:z.string().regex(/^network-[a-f0-9]{64}$/)}).parse(params);
    await this.revokeGeneralOwner(input.owner);this.networkOwners.delete(input.owner);await this.options.engine.revokeNetworkOwner(input.owner);return {revoked:true};
   }
   if(method==='service.network_dispatch'){
    const input=z.strictObject({owner:z.string().regex(/^network-[a-f0-9]{64}$/),method:z.string(),params:z.unknown()}).parse(params);
    return this.tool(input.owner,input.method,input.params);
   }
   throw new Fault('UNKNOWN_METHOD');
  }
  return this.tool(client,method,params);
 }
 private tool(client:string,method:string,params:unknown){
  const args=parseTool(method,params);const engine=this.options.engine;
  switch(method){
   case 'jev.host_tools':case 'jev.host_act':{engine.authorizeClient(client);const host=this.options.hostService;if(!host)throw new Fault('HOST_UNAVAILABLE');return this.scoped(client,signal=>method==='jev.host_tools'?host.tools(client,args):host.act(client,args,signal));}
   case 'jev.browser_open':case 'jev.browser_observe':case 'jev.browser_act':case 'jev.browser_close':{engine.authorizeClient(client);const browser=this.options.realBrowser;if(!browser)throw new Fault('REAL_BROWSER_UNAVAILABLE');const operation=method.slice(12) as 'open'|'observe'|'act'|'close';return this.scoped(client,()=>browser[operation](client,args));}
   case 'jev.choose_action':return this.choose(client,args as ChoiceArgs);
   case 'jev.open_session':return engine.openSession(client,args);
   case 'jev.observe':return engine.observe(client,args);
   case 'jev.run_goal':return engine.runGoal(client,args);
   case 'jev.cancel':return engine.cancel(client,args);
   case 'jev.status':return engine.status(client,args);
   case 'jev.close_session':return engine.closeSession(client,args);
   default:throw new Fault('UNKNOWN_METHOD');
  }
 }
 private async abortChoices(matches:(client:string)=>boolean){const jobs=[...this.choices].filter(([,entry])=>matches(entry.client));for(const [controller] of jobs)controller.abort();await Promise.allSettled(jobs.map(([,entry])=>entry.done));}
 private async revokeGeneralOwner(owner:string){await this.abortChoices(client=>client===owner);await this.options.realBrowser?.revokeOwner(owner);await this.options.hostService?.revokeOwner(owner);}
 private choose(client:string,args:ChoiceArgs):Promise<unknown>{this.options.engine.authorizeClient(client);if(!this.options.chooseAction)throw new Fault('GENERAL_CHOICE_UNAVAILABLE');return this.scoped(client,signal=>this.options.chooseAction!(client,args,signal));}
 private scoped(client:string,operation:(signal:AbortSignal)=>Promise<unknown>):Promise<unknown>{
  this.options.engine.authorizeClient(client);const controller=new AbortController();
  const done=(async()=>{try{
   const result=await new Promise<unknown>((resolve,reject)=>{
    const abort=()=>reject(new Fault('CANCELLED'));controller.signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{if(this.stopping||controller.signal.aborted)throw new Fault('CANCELLED');this.options.engine.authorizeClient(client);return operation(controller.signal);}).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));
   });
   this.options.engine.authorizeClient(client);if(this.stopping||controller.signal.aborted)throw new Fault('CANCELLED');return result;
  }finally{this.choices.delete(controller);}})();
  this.choices.set(controller,{client,done});return done;
 }
 private async releaseFiles(){
  for(const socket of this.sockets)socket.destroy();
  if(this.server.listening)await new Promise<void>(resolve=>this.server.close(()=>resolve()));
  await this.lock?.close();
  await Promise.all([...this.credentialFiles,'service.lock'].map(name=>unlink(join(this.options.runtimeDir,name)).catch(()=>{})));
 }
 close():Promise<void>{
  if(this.closing)return this.closing;this.stopping=true;
  this.closing=(async()=>{try{try{await this.abortChoices(()=>true);await this.options.engine.shutdown();}finally{await this.options.onStop?.();}}finally{await this.releaseFiles();}})();return this.closing;
 }
}
