import {constants,lstatSync,openSync,closeSync,fstatSync,readFileSync} from 'node:fs';
import {isAbsolute,dirname} from 'node:path';
import {z} from 'zod';
import {idSchema} from '../core/contracts.js';
import {Fault} from '../core/errors.js';
import {tokenSchema,type NetworkServerOptions} from './server.js';
import type {ConnectorOptions} from './connector.js';
const pathSchema=z.string().max(4096).refine(isAbsolute);
const identity={deviceId:idSchema,agentId:idSchema};
const serverConfig=z.strictObject({...identity,host:z.string().min(1).max(253).optional(),port:z.number().int().min(1).max(65535),publicHost:z.string().min(1).max(260),allowedOrigins:z.array(z.string().max(300)).max(16),storeDir:pathSchema,tlsKeyFile:pathSchema,tlsCertFile:pathSchema,mcpTokenFile:pathSchema,connectorTokenFile:pathSchema});
const connectorConfig=z.strictObject({...identity,url:z.string().max(300),journalDir:pathSchema,credentialFile:pathSchema,tokenFile:pathSchema,caFile:pathSchema.optional(),pollMs:z.number().int().min(25).max(1000).optional()});
/** Operator-provisioned inputs only: never generate or reset secrets, enrollment or budget state. */
function privateFile(path:string):Buffer {
 let fd:number|undefined;
 try{
  if(!isAbsolute(path))throw new Error();const parent=lstatSync(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o777)!==0o700)throw new Error();
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const info=fstatSync(fd);if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||info.size>65536)throw new Error();
  return readFileSync(fd);
 }catch{throw new Fault('PRIVATE_FILE_REQUIRED');}finally{if(fd!==undefined)closeSync(fd);}
}
function jsonFile(path:string):unknown{try{return JSON.parse(privateFile(path).toString('utf8'));}catch(e){if(e instanceof Fault)throw e;throw new Fault('INVALID_NETWORK_CONFIG');}}
export function loadNetworkConfig(mode:'server',path:string):NetworkServerOptions;
export function loadNetworkConfig(mode:'connector',path:string):ConnectorOptions;
export function loadNetworkConfig(mode:'server'|'connector',path:string):NetworkServerOptions|ConnectorOptions {
 if(mode==='server'){
  const config=serverConfig.safeParse(jsonFile(path));if(!config.success)throw new Fault('INVALID_NETWORK_CONFIG');
  const {tlsKeyFile,tlsCertFile,mcpTokenFile,connectorTokenFile,...rest}=config.data;
  const mcpToken=tokenSchema.safeParse(jsonFile(mcpTokenFile)),connectorToken=tokenSchema.safeParse(jsonFile(connectorTokenFile));
  if(!mcpToken.success||!connectorToken.success)throw new Fault('INVALID_NETWORK_CONFIG');if(mcpToken.data.token===connectorToken.data.token)throw new Fault('DISTINCT_TOKENS_REQUIRED');
  return {...rest,tls:{key:privateFile(tlsKeyFile),cert:privateFile(tlsCertFile)},mcpToken:mcpToken.data,connectorToken:connectorToken.data};
 }
 const config=connectorConfig.safeParse(jsonFile(path));if(!config.success)throw new Fault('INVALID_NETWORK_CONFIG');const {tokenFile,caFile,...rest}=config.data;
 const token=tokenSchema.safeParse(jsonFile(tokenFile));if(!token.success)throw new Fault('INVALID_NETWORK_CONFIG');return {...rest,token:token.data,...(caFile?{ca:privateFile(caFile)}:{})};
}
