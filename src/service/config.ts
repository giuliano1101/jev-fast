import type {HostConfig} from '../host/service.js';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash,createPublicKey} from 'node:crypto';
import {z} from 'zod';
import {idSchema,type DecisionProvider} from '../core/contracts.js';
import {Fault} from '../core/errors.js';
import {MockProvider} from '../providers/mock.js';
import {RemoteDecisionProvider,RemoteChoiceClient} from '../remote/client.js';
import type {ChoiceArgs} from '../choice/contracts.js';
import {verifyChoiceResponse,type ChoiceResponse} from '../remote/choice.js';
import {canonicalDigest,identitySchema} from '../remote/protocol.js';
import type {RemoteExecutionPolicy} from '../remote/execution.js';
/** Read a bounded, owner-only regular file without following its final symlink. */
export async function readPrivateFile(path:string,maxBytes=65536):Promise<Buffer>{
 try{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const info=await file.stat();if(!info.isFile()||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||info.nlink!==1||info.size>maxBytes)throw new Error();
   const data=Buffer.alloc(maxBytes+1);let size=0;
   while(size<data.length){const {bytesRead}=await file.read(data,size,data.length-size,null);if(!bytesRead)break;size+=bytesRead;}
   if(size>maxBytes)throw new Error();return data.subarray(0,size);
  }finally{await file.close();}
 }catch{throw new Fault('UNSAFE_PRIVATE_FILE');}
}
export async function readPrivateJson(path:string):Promise<unknown>{const bytes=await readPrivateFile(path);try{return JSON.parse(bytes.toString('utf8'));}catch{throw new Fault('INVALID_CONFIGURATION_JSON');}}
const pathSchema=z.string().min(1).max(4096);
const schema=z.discriminatedUnion('mode',[
 z.strictObject({mode:z.literal('mock')}),
 z.strictObject({mode:z.literal('remote'),endpoint:z.string().min(1).max(2048),caFile:pathSchema,certFile:pathSchema,keyFile:pathSchema,tokenFile:pathSchema,tokenReload:z.boolean().optional(),hostConfigs:z.record(z.string().min(1),pathSchema).optional(),receiptPublicKeyFile:pathSchema,issuer:idSchema,audience:idSchema,identity:identitySchema,enforcementMode:z.enum(['required_jev','test_mock'])})
]);
export interface ServiceProfile {hosts?:Record<string,HostConfig>;chooseAction?:(client:string,args:ChoiceArgs,signal:AbortSignal)=>Promise<ChoiceResponse>;mode:'mock'|'remote';provider:DecisionProvider;clients:readonly string[];sharedAccess?:Record<string,string[]>;remotePolicy?:RemoteExecutionPolicy;fingerprint:string;health:()=>Promise<Record<string,unknown>>}
import {buildMetadata} from './build.js';
export {buildMetadata} from './build.js';
export async function loadServiceProfile(configFile?:string,shared=false):Promise<ServiceProfile>{
 const parsed=schema.safeParse(configFile?await readPrivateJson(configFile):{mode:'mock'});if(!parsed.success)throw new Fault('INVALID_SERVICE_CONFIGURATION');
 const config=parsed.data;
 const base={protocol:'decision-v1',policy:'p0-v1',enforcement:'advisory-only',build:buildMetadata};
 if(config.mode==='mock'){
  const fingerprint=canonicalDigest({mode:'mock',shared});
  return {mode:'mock',provider:new MockProvider(),clients:['a','b'],sharedAccess:shared?{a:['b']}:undefined,fingerprint,health:async()=>({...base,provider:'mock',model:'mock-v1',enforcementMode:'test_mock',remoteReachable:null,profileFingerprint:fingerprint})};
 }
 if(shared)throw new Fault('REMOTE_SHARING_NOT_SUPPORTED');
 const root=dirname(resolve(configFile!));
 const hosts:Record<string,HostConfig>={};const hostMaterial:string[]=[];
 const hostSchema=z.object({serverCommand:z.string().min(1),serverArgs:z.array(z.string()),serverEnv:z.record(z.string(),z.string()).optional(),device:z.string().min(1).optional()});
 for(const [name,file] of Object.entries(config.hostConfigs??{})){const bytes=await readPrivateFile(resolve(root,file));const parsed=hostSchema.safeParse(JSON.parse(bytes.toString('utf8')));if(!parsed.success)throw new Fault('INVALID_HOST_CONFIGURATION');hosts[name]=parsed.data;hostMaterial.push(createHash('sha256').update(bytes).digest('hex'));}

 const [ca,cert,key,tokenBytes,publicBytes]=await Promise.all([config.caFile,config.certFile,config.keyFile,config.tokenFile,config.receiptPublicKeyFile].map(path=>readPrivateFile(resolve(root,path))));
 let publicKey;try{publicKey=createPublicKey(publicBytes!);if(publicKey.asymmetricKeyType!=='ed25519')throw new Error();}catch{throw new Fault('INVALID_REMOTE_CONFIGURATION');}
 const parseReloadToken=(bytes:Buffer)=>{
  const raw=bytes.toString('utf8');
  if(!/^[\x21-\x7e]+(?:\r?\n)?$/.test(raw))throw new Fault('INVALID_REMOTE_CONFIGURATION');
  const value=raw.trim();if(value.length>8192)throw new Fault('INVALID_REMOTE_CONFIGURATION');return value;
 };
 const token=config.tokenReload?parseReloadToken(tokenBytes!):tokenBytes!.toString('utf8').trim();
 if(token.length>8192)throw new Fault('INVALID_REMOTE_CONFIGURATION');
 const tokenLoader=config.tokenReload?async()=>parseReloadToken(await readPrivateFile(resolve(root,config.tokenFile),8194)):undefined;
 const provider=new RemoteDecisionProvider({url:config.endpoint,ca:ca!,cert:cert!,key:key!,token,tokenLoader});
 const choiceClient=new RemoteChoiceClient({url:config.endpoint,ca:ca!,cert:cert!,key:key!,token,tokenLoader});
 const chooseAction=async(client:string,args:ChoiceArgs,signal:AbortSignal)=>verifyChoiceResponse(await choiceClient.choose(client,args,signal),{args,caller_scope:client,publicKey,issuer:config.issuer,audience:config.audience,identity:config.identity});
 const remotePolicy={publicKey,issuer:config.issuer,audience:config.audience,identity:config.identity,enforcementMode:config.enforcementMode};
 const fingerprint=canonicalDigest({config,shared:false,...(hostMaterial.length?{hostMaterial}:{}),...(config.tokenReload?{configFile:resolve(configFile!)}:{}),material:(config.tokenReload?[ca,cert,key,publicBytes]:[ca,cert,key,tokenBytes,publicBytes]).map(bytes=>createHash('sha256').update(bytes!).digest('hex'))});
 return {mode:'remote',provider,chooseAction,...(Object.keys(hosts).length?{hosts}:{}),clients:['a'],remotePolicy,fingerprint,health:async()=>{
  const metadata={...base,provider:'remote',model:'unknown',enforcementMode:config.enforcementMode,identity:config.identity,localClient:'a',profileFingerprint:fingerprint};
  try{const actual=await provider.health();const identityMatches=canonicalDigest(actual.identity)===canonicalDigest(config.identity);return {...metadata,provider:actual.mode,transport:'remote',model:actual.model,protocol:actual.protocol,policy:actual.policy,authenticatedIdentity:actual.identity,identityMatches,remoteReachable:true,routeCompatible:identityMatches&&(config.enforcementMode==='test_mock'||actual.mode==='jev')};}
  catch{return {...metadata,transport:'remote',remoteReachable:false,diagnostic:'REMOTE_UNAVAILABLE_OR_UNAUTHORIZED'};}
 }};
}
