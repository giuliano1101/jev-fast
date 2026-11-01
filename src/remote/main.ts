import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {open} from 'node:fs/promises';
import {createPrivateKey,createPublicKey,X509Certificate,type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {idSchema} from '../core/contracts.js';
import {Fault} from '../core/errors.js';
import {readPrivateFile,readPrivateJson,buildMetadata} from '../service/config.js';
import {safeCode} from '../service/ipc.js';
import {identitySchema} from './protocol.js';
import {certificateSha256,mintAgentToken} from './credentials.js';
import {createDecisionGateway,type DecisionGatewayOptions} from './gateway.js';
import {GatewayStore} from './store.js';
import {UsageLedger} from './usage.js';
import {ChoiceStore} from './choice-store.js';
const pathSchema=z.string().min(1).max(4096);
const configSchema=z.strictObject({mode:z.enum(['mock','live']).default('mock'),certFile:pathSchema,keyFile:pathSchema,caFile:pathSchema,receiptPrivateKeyFile:pathSchema,tokenPublicKeyFile:pathSchema,tokenPrivateKeyFile:pathSchema.optional(),storageDir:pathSchema,issuer:idSchema,audience:idSchema,bindHost:z.string().min(1).max(253).default('127.0.0.1'),port:z.number().int().min(0).max(65535).default(8443),live:z.strictObject({keyFile:pathSchema,approvalFile:pathSchema}).optional()}).refine(v=>(v.mode==='live')===Boolean(v.live));
const authorizationSchema=z.strictObject({approval_id:idSchema,expires_at:z.number().int().positive(),synthetic_only:z.literal(true),max_requests:z.number().int().min(1).max(1000),max_cost_usd:z.number().positive().max(10)});
const cappedApprovalSchema=z.strictObject({authorization:authorizationSchema,approval:z.strictObject({approval_id:idSchema,expires_at:z.number().int().positive(),max_requests:z.number().int().min(1).max(1000),max_cost_usd:z.number().positive().max(10),reservation_usd:z.number().positive().max(1)})});
const approvalSchema=z.union([cappedApprovalSchema,z.strictObject({metering:z.strictObject({policy_id:idSchema})})]);
const enrollmentSpec=z.strictObject({identity:identitySchema,certFile:pathSchema,expiresAt:z.number().int().positive(),scope:z.enum(['decide:synthetic','decide:actions']).optional()});
export async function loadGatewayConfig(file:string){
 const parsed=configSchema.safeParse(await readPrivateJson(file));if(!parsed.success)throw new Fault('INVALID_GATEWAY_CONFIGURATION');
 const root=dirname(resolve(file));return {config:parsed.data,path:(name:string)=>resolve(root,name)};
}
async function privateKey(file:string):Promise<KeyObject>{const bytes=await readPrivateFile(file);try{const key=createPrivateKey(bytes);if(key.asymmetricKeyType!=='ed25519')throw new Error();return key;}catch{throw new Fault('INVALID_CREDENTIAL_KEY');}}
async function publicKey(file:string):Promise<KeyObject>{const bytes=await readPrivateFile(file);try{const key=createPublicKey(bytes);if(key.asymmetricKeyType!=='ed25519')throw new Error();return key;}catch{throw new Fault('INVALID_CREDENTIAL_KEY');}}
/** Local operator entry point. It opens no enrollment or credential-issuance HTTP routes. */
export async function startGatewayFromConfig(file:string){
 const {config,path}=await loadGatewayConfig(file);
 const [cert,key,ca,receiptPrivateKey,tokenPublicKey]=await Promise.all([readPrivateFile(path(config.certFile)),readPrivateFile(path(config.keyFile)),readPrivateFile(path(config.caFile)),privateKey(path(config.receiptPrivateKeyFile)),publicKey(path(config.tokenPublicKeyFile))]);
 let live:DecisionGatewayOptions['live'];let usageLedger:UsageLedger|undefined;let choiceStore:ChoiceStore|undefined;
 if(config.live){
  const parsed=approvalSchema.safeParse(await readPrivateJson(path(config.live.approvalFile)));if(!parsed.success)throw new Fault('LIVE_NOT_AUTHORIZED');
  const apiKey=(await readPrivateFile(path(config.live.keyFile),8192)).toString('utf8').trim();if(!apiKey||/[\r\n]/.test(apiKey))throw new Fault('LIVE_NOT_AUTHORIZED');
  if('metering' in parsed.data){usageLedger=new UsageLedger(path(config.storageDir));choiceStore=new ChoiceStore(path(config.storageDir));live={key:apiKey,metering:{...parsed.data.metering,ledger:usageLedger}};}else live={key:apiKey,...parsed.data};
 }
 let store:GatewayStore;try{store=new GatewayStore(path(config.storageDir));}catch(error){choiceStore?.close();usageLedger?.close();throw error;}
 try{
  const server=createDecisionGateway({tls:{cert,key,ca},store,receiptPrivateKey,tokenPublicKey,issuer:config.issuer,audience:config.audience,live,choiceStore});
  await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(config.port,config.bindHost,()=>{server.removeListener('error',fail);done();});});
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{server.closeAllConnections();try{await new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()));}finally{store.close();choiceStore?.close();usageLedger?.close();}})();
  return {server,store,usageLedger,choiceStore,close,mode:config.mode};
 }catch(error){store.close();choiceStore?.close();usageLedger?.close();throw error;}
}
export async function runOperator(argv:string[]):Promise<unknown>{
 let args;try{args=parseArgs({args:argv,options:{help:{type:'boolean',short:'h'},config:{type:'string'},spec:{type:'string'},out:{type:'string'}},strict:true,allowPositionals:true});}catch{throw new Fault('INVALID_ARGUMENTS');}
 const {values,positionals}=args;
 if(values.help){if(positionals.length||Object.keys(values).some(k=>k!=='help'))throw new Fault('INVALID_ARGUMENTS');return {help:'Jev operator: serve --config FILE | usage --config FILE | enroll --config FILE --spec FILE | revoke --config FILE --spec FILE | mint --config FILE --spec FILE --out FILE. Files must be private (0600). Default gateway mode is mock. Mint writes a certificate-bound synthetic or actions token only to an exclusive 0600 file; maximum lifetime is one hour.'};}
 const command=positionals[0];if(positionals.length!==1||!values.config||!['serve','usage','enroll','revoke','mint'].includes(command!))throw new Fault('INVALID_ARGUMENTS');
 if(command==='usage'){
  if(values.spec!==undefined||values.out!==undefined)throw new Fault('INVALID_ARGUMENTS');
  const {config,path}=await loadGatewayConfig(values.config);if(!config.live)throw new Fault('LIVE_NOT_AUTHORIZED');
  const policy=approvalSchema.safeParse(await readPrivateJson(path(config.live.approvalFile)));if(!policy.success||!('metering' in policy.data))throw new Fault('LIVE_NOT_AUTHORIZED');
  const ledger=new UsageLedger(path(config.storageDir));try{return ledger.summary();}finally{ledger.close();}
 }
 if(command==='serve'){
  if(values.spec!==undefined||values.out!==undefined)throw new Fault('INVALID_ARGUMENTS');
  const service=await startGatewayFromConfig(values.config);
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void service.close().catch(()=>{process.stderr.write('GATEWAY_SHUTDOWN_FAILED\n');process.exitCode=1;});});
  service.server.on('error',()=>{process.stderr.write('GATEWAY_FAILED\n');void service.close().catch(()=>{});process.exitCode=1;});
  return {ready:true,mode:service.mode,model:service.mode==='live'?'jev-1.14.0':'mock-v1',protocol:'decision-v1',policy:'p0-v1',build:buildMetadata,address:service.server.address()};
 }
 if(!values.spec||(command==='mint'?!values.out:values.out!==undefined))throw new Fault('INVALID_ARGUMENTS');
 const {config,path}=await loadGatewayConfig(values.config),raw=await readPrivateJson(values.spec);
 if(command==='revoke'){
  const spec=z.strictObject({identity:identitySchema}).safeParse(raw);if(!spec.success)throw new Fault('INVALID_OPERATOR_SPEC');
  const store=new GatewayStore(path(config.storageDir));try{store.revoke(spec.data.identity);return {revoked:true};}finally{store.close();}
 }
 const spec=enrollmentSpec.safeParse(raw);if(!spec.success)throw new Fault('INVALID_OPERATOR_SPEC');
 const cert=await readPrivateFile(resolve(dirname(resolve(values.spec)),spec.data.certFile));
 let certificate:X509Certificate;try{certificate=new X509Certificate(cert);}catch{throw new Fault('INVALID_CERTIFICATE');}
 const now=Date.now(),expires=spec.data.expiresAt;
 if(Date.parse(certificate.validFrom)>now||expires<=now||expires>Date.parse(certificate.validTo))throw new Fault('INVALID_CREDENTIAL_EXPIRY');
 const certificateHash=certificateSha256(cert),store=new GatewayStore(path(config.storageDir));
 try{
  if(command==='enroll'){store.enroll({...spec.data.identity,certificate_sha256:certificateHash,expires_at:expires});return {enrolled:true};}
  if(expires-now>3600000)throw new Fault('INVALID_CREDENTIAL_EXPIRY');
  if(!config.tokenPrivateKeyFile)throw new Fault('TOKEN_SIGNING_KEY_REQUIRED');
  store.authorize(spec.data.identity,certificateHash);
  const key=await privateKey(path(config.tokenPrivateKeyFile)),expected=await publicKey(path(config.tokenPublicKeyFile));
  if(!createPublicKey(key).equals(expected))throw new Fault('INVALID_CREDENTIAL_KEY');
  const token=mintAgentToken({issuer:config.issuer,audience:config.audience,identity:spec.data.identity,certificate_sha256:certificateHash,scope:spec.data.scope??'decide:synthetic',issued_at_ms:now,expires_at_ms:expires},key);
  let output;try{output=await open(resolve(values.out!),'wx',0o600);}catch{throw new Fault('TOKEN_OUTPUT_UNAVAILABLE');}
  try{await output.writeFile(token+'\n');await output.sync();}finally{await output.close();}
  return {tokenWritten:true,expiresAt:expires,scope:spec.data.scope??'decide:synthetic'};
 }finally{store.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void runOperator(process.argv.slice(2)).then(result=>process.stdout.write(JSON.stringify(result)+'\n'),error=>{process.stderr.write(safeCode(error)+'\n');process.exitCode=1;});
