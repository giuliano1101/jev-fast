import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import {z} from 'zod';
import {Fault} from '../core/errors.js';
import {safeCode,readCredential,ipcCall} from '../service/ipc.js';
import {removeDeadMarker} from '../service/recovery.js';
import {HostService,createHostMcpClient,type HostServiceOptions} from '../host/service.js';
import {choiceResponseSchema} from '../remote/choice.js';
import {canonicalDigest} from '../remote/protocol.js';
import {JobStore,jobSchema,type Job} from './jobs.js';
import {MacExecutor} from './executor.js';
import {OwnerValidator} from './auth.js';
import {startFront,rawClient,privateMacClient,json,body} from './http.js';
const absolute=z.string().refine(isAbsolute),base={listenHost:z.enum(['127.0.0.1','::1','localhost']).default('127.0.0.1'),port:z.number().int().min(0).max(65535),stateDir:absolute,capabilityFile:absolute};
const frontSchema=z.strictObject({...base,macUrl:z.url(),upstreamUrl:z.url(),upstreamHost:z.string().min(1),upstreamServername:z.string().min(1).optional(),upstreamCaFile:absolute.optional()});
const macSchema=z.strictObject({...base,publicEndpoint:z.url(),credentialFile:absolute,desktopCommand:absolute,desktopArgs:z.array(z.string())});
async function recover(directory:string){mkdirSync(directory,{recursive:true,mode:0o700});await removeDeadMarker(directory,'owner.lock');}
function capability(path:string){const token=readFileSync(path,'utf8').trim();if(token.length<32||token.length>4096)throw new Fault('INVALID_CAPABILITY');return token;}
export interface MacDependencies{validator?:Pick<OwnerValidator,'validate'|'close'>;chooseAction?:HostServiceOptions['chooseAction']}
export async function startMac(config:z.infer<typeof macSchema>,dependencies:MacDependencies={}){
 await readCredential(config.credentialFile);
 await recover(config.stateDir);const hostState=join(config.stateDir,'host'),processState=join(config.stateDir,'desktop-process');await recover(hostState);await recover(processState);const store=new JobStore(config.stateDir),secret=capability(config.capabilityFile),validator=dependencies.validator??new OwnerValidator(config.publicEndpoint);let healthy=true,failed!:()=>void;const failure=new Promise<void>(resolve=>{failed=resolve;}),unavailable=()=>{healthy=false;failed();};
 const coordinatorCall=async(method:string,params:unknown)=>ipcCall(await readCredential(config.credentialFile),method,params);
 const validateJob=async(job:Job)=>{const context=await validator.validate(job.token,job.owner),local=await coordinatorCall('service.local_health',{}) as {ready?:boolean;instance_id?:unknown}|null;if(!local||local.ready!==true)throw new Fault('LOCAL_COORDINATOR_UNAVAILABLE');if(typeof context.local_instance_id!=='string'||local.instance_id!==context.local_instance_id)throw new Fault('LOCAL_INSTANCE_CHANGED');};
 const authorize=async(owner:string):Promise<void>=>validateJob(executor.context(owner));
 const runner=new HostService({storageDir:hostState,hosts:{mac:{serverCommand:config.desktopCommand,serverArgs:config.desktopArgs}},clientFactory:(hostConfig,host,signal)=>createHostMcpClient(hostConfig,host,signal,pid=>{writeFileSync(join(processState,'owner.lock'),JSON.stringify({pid})+'\n',{flag:'wx',mode:0o600});},unavailable),authorize,chooseAction:dependencies.chooseAction??(async(owner,args,signal)=>{
  await authorize(owner);if(signal.aborted)throw new Fault('OWNER_REVOKED');const health=await coordinatorCall('service.health',{}) as Record<string,unknown>;
  if(health.ready!==true||health.provider!=='jev'||health.transport!=='remote'||health.remoteReachable!==true||health.identityMatches!==true||health.routeCompatible!==true)throw new Fault('REAL_JEV_UNAVAILABLE');
  await authorize(owner);if(signal.aborted)throw new Fault('OWNER_REVOKED');const scoped={...args,idempotency_key:canonicalDigest({namespace:'public-mac-owner-choice-v1',owner,key:args.idempotency_key})};
  const decision=choiceResponseSchema.parse(await coordinatorCall('jev.choose_action',scoped));if(decision.provider!=='jev')throw new Fault('REAL_JEV_REQUIRED');return decision;
 })});
 const executor=new MacExecutor({store,runner,authorize:validateJob});
 const server=createServer((req,res)=>{void(async()=>{const supplied=req.headers['x-jev-mac-capability'];if(typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength(secret)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(secret))){req.resume();json(res,403,{code:'FORBIDDEN'});return;}
 if(req.url==='/health'&&req.method==='GET'){json(res,healthy?200:503,{ok:healthy,host:'mac',execution:'native-desktop'});return;}
 if(req.url==='/jobs'&&req.method==='POST'){const input=jobSchema.parse(JSON.parse((await body(req)).toString()));json(res,202,executor.submit(input));return;}
 const match=/^\/jobs\/([a-f0-9]{64})$/.exec(req.url??'');if(match&&req.method==='GET'){const job=store.get(match[1]!);json(res,job?200:404,job??{code:'REQUEST_NOT_FOUND'});return;}req.resume();json(res,404,{code:'NOT_FOUND'});
 })().catch(error=>{if(!res.headersSent)json(res,400,{code:safeCode(error)});else res.destroy();});});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.listenHost,resolve);});return {server,store,executor,failure,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await executor.close();await validator.close();store.close();}};
}
async function main(){const [mode,path,...extra]=process.argv.slice(2);if(!path||!isAbsolute(path)||extra.length)throw new Fault('INVALID_ARGUMENTS');const data=JSON.parse(readFileSync(path,'utf8'));let service:{close():Promise<void>;failure?:Promise<void>};
 if(mode==='front'){const config=frontSchema.parse(data);await recover(config.stateDir);const mac=privateMacClient(config.macUrl,capability(config.capabilityFile));service=await startFront({...config,mac,macHealth:()=>mac.health(),upstream:rawClient({url:config.upstreamUrl,host:config.upstreamHost,servername:config.upstreamServername,ca:config.upstreamCaFile?readFileSync(config.upstreamCaFile):undefined})});}
 else if(mode==='mac')service=await startMac(macSchema.parse(data));else throw new Fault('INVALID_ARGUMENTS');
 let closing=false;const close=(code=0)=>{if(closing)return;closing=true;void service.close().then(()=>{process.exit(code);},()=>{process.exit(1);});};process.once('SIGTERM',()=>close());process.once('SIGINT',()=>close());void service.failure?.then(()=>close(1));process.stdout.write(JSON.stringify({ready:true,mode})+'\n');
}
if(process.argv[1]?.endsWith('/mac-public/main.js'))void main().catch(error=>{process.stderr.write(JSON.stringify({code:safeCode(error)})+'\n');process.exitCode=1;});
