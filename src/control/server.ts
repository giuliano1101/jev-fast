import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {operatorToken} from '../service/operator-token.js';
import {defaultRuntime} from '../service/runtime.js';
import {controlPage,controlScript,controlStyle} from './ui.js';
import {startService,stopService,inspectService} from '../service/lifecycle.js';
export {defaultRuntime} from '../service/runtime.js';
export interface ControlStatus {state:'running'|'unavailable'|'blocked';mode:'mock'|'remote'|'unknown';decisionProvider:'mock'|'jev'|'unknown';remoteReachable:boolean|null;routeCompatible?:boolean;installation?:{nodeSupported:boolean|null;chromiumAvailable:boolean|null;runtime:string;socket:string}}
export interface ControlAdapter {status:()=>Promise<ControlStatus>;start:()=>Promise<void>;stop:()=>Promise<void>}
const actionCodes=new Set(['SERVICE_PROFILE_MISMATCH','UNSAFE_PRIVATE_FILE','INVALID_SERVICE_CONFIGURATION','INVALID_CONFIGURATION_JSON','UNSAFE_RUNTIME','SERVICE_START_FAILED','SERVICE_START_TIMEOUT','SERVICE_STOP_TIMEOUT','REMOTE_SHARING_NOT_SUPPORTED']);
function safeError(error:unknown){const code=error instanceof Error?error.message:'';return actionCodes.has(code)?code:'CONTROL_ACTION_FAILED';}
function record(value:unknown):Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:{};}
const booleanOrNull=(value:unknown)=>typeof value==='boolean'?value:null;
export interface LifecyclePort {startService:typeof startService;stopService:typeof stopService;inspectService:typeof inspectService}
export class LifecycleControlAdapter implements ControlAdapter {
 private readonly runtime:string;private readonly config?:string;private readonly lifecycle:LifecyclePort;
 constructor(options:{runtime:string;config?:string;lifecycle?:LifecyclePort}){this.runtime=resolve(options.runtime);this.config=options.config?resolve(options.config):undefined;this.lifecycle=options.lifecycle??{startService,stopService,inspectService};}
 async status():Promise<ControlStatus>{
  try{
   const value=await this.lifecycle.inspectService(this.runtime),raw=record(value.installation),runtime=record(raw.runtime).status,socket=record(raw.socket).status;
   const status=(value:unknown)=>['missing','private','unsafe','unreadable'].includes(String(value))?String(value):'unknown';
   const installation={nodeSupported:booleanOrNull(record(raw.node).supported),chromiumAvailable:booleanOrNull(record(raw.chromium).executableAvailable),runtime:status(runtime),socket:status(socket)};
   const unavailable=value.ready===false&&installation.nodeSupported===true&&['missing','private'].includes(installation.runtime)&&installation.socket==='missing';
   return {state:value.ready===true?'running':unavailable?'unavailable':'blocked',mode:value.transport==='remote'?'remote':value.provider==='mock'||value.provider==='remote'?value.provider:'unknown',decisionProvider:value.provider==='mock'||value.provider==='jev'?value.provider:'unknown',remoteReachable:booleanOrNull(value.remoteReachable),...(typeof value.routeCompatible==='boolean'?{routeCompatible:value.routeCompatible}:{}),installation};
  }catch{return {state:'blocked',mode:'unknown',decisionProvider:'unknown',remoteReachable:null};}
 }
 async start(){await this.lifecycle.startService({runtime:this.runtime,configFile:this.config});}
 async stop(){await this.lifecycle.stopService(this.runtime);}
}
export function parseControlArgs(args:string[]){
 try{
  const {values}=parseArgs({args,strict:true,allowPositionals:false,options:{runtime:{type:'string'},config:{type:'string'},'token-file':{type:'string'},port:{type:'string'},help:{type:'boolean',short:'h'},open:{type:'boolean'}}});
  if(values.help&&Object.keys(values).some(key=>key!=='help'))throw new Error();
  const port=values.port===undefined?47831:Number(values.port);
  if(values.port!==undefined&&!/^\d+$/.test(values.port)||!Number.isInteger(port)||port<0||port>65535||values.runtime===''||values.config===''||values['token-file']==='')throw new Error();
  return {runtime:resolve(values.runtime??defaultRuntime()),...(values.config?{config:resolve(values.config)}:{}),port,help:values.help??false,...(values['token-file']?{tokenFile:resolve(values['token-file'])}:{}),...(values.open?{open:true}:{})};
 }catch{throw new Error('INVALID_ARGUMENTS');}
}
export async function startControlPanel(options:{runtime:string;config?:string;tokenFile?:string;port?:number;adapter?:ControlAdapter}){
 const runtime=resolve(options.runtime),adapter=options.adapter??new LifecycleControlAdapter({runtime,config:options.config});
 const token=operatorToken(options.tokenFile);let origin='',host='';let mutations:Promise<unknown>=Promise.resolve();
 function respond(res:ServerResponse,status:number,value:unknown,type='application/json; charset=utf-8'){
  const body=typeof value==='string'?value:JSON.stringify(value);res.writeHead(status,{'content-type':type,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'content-length':Buffer.byteLength(body)});res.end(body);
 }
 const count=(req:IncomingMessage,name:string)=>req.rawHeaders.filter((_,index)=>index%2===0&&req.rawHeaders[index]!.toLowerCase()===name).length;
 const authorized=(req:IncomingMessage)=>{
  const actual=req.headers['x-jev-control-token'];return count(req,'origin')===1&&req.headers.origin===origin&&req.headers['sec-fetch-site']!=='cross-site'&&typeof actual==='string'&&Buffer.byteLength(actual)===Buffer.byteLength(token)&&count(req,'x-jev-control-token')===1&&timingSafeEqual(Buffer.from(actual),Buffer.from(token));
 };
 const server=createServer({maxHeaderSize:8192,requestTimeout:5000,headersTimeout:5000},(req,res)=>{void (async()=>{
  if(req.headers.host!==host||count(req,'host')!==1){respond(res,403,{error:{code:'CONTROL_FORBIDDEN'}});return;}
  if(req.url==='/'&&req.method==='GET'){respond(res,200,controlPage({runtime,configured:!!options.config}),'text/html; charset=utf-8');return;}
  if(req.url==='/app.js'&&req.method==='GET'){respond(res,200,controlScript,'text/javascript; charset=utf-8');return;}
  if(req.url==='/style.css'&&req.method==='GET'){respond(res,200,controlStyle,'text/css; charset=utf-8');return;}
  if(!authorized(req)){respond(res,403,{error:{code:'CONTROL_FORBIDDEN'}});return;}
  if(!['/api/status','/api/start','/api/stop'].includes(req.url??'')){respond(res,404,{error:{code:'CONTROL_NOT_FOUND'}});return;}
  if(!(req.method==='POST'||req.method==='GET'&&req.url==='/api/status')){respond(res,405,{error:{code:'CONTROL_METHOD_NOT_ALLOWED'}});return;}
  if(Number(req.headers['content-length']??0)>2048){respond(res,413,{error:{code:'CONTROL_BODY_TOO_LARGE'}});return;}
  let size=0;const chunks:Buffer[]=[];
  // Limit body collection only; lifecycle calls retain their own safety checks.
  const bodyDeadline=setTimeout(()=>req.destroy(),5000);
  try{for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>2048){respond(res,413,{error:{code:'CONTROL_BODY_TOO_LARGE'}});return;}chunks.push(Buffer.from(chunk));}}
  finally{clearTimeout(bodyDeadline);}
  const raw=Buffer.concat(chunks).toString('utf8');
  if(raw!==''){respond(res,400,{error:{code:'CONTROL_INVALID_BODY'}});return;}
  if(req.url==='/api/status'){respond(res,200,await adapter.status());return;}
  const action=req.url==='/api/start'?'start':'stop';const result=mutations.then(()=>adapter[action]());mutations=result.catch(()=>{});
  try{await result;respond(res,200,{ok:true});}catch(error){respond(res,503,{error:{code:safeError(error)}});}
 })().catch(()=>{if(!res.headersSent)respond(res,503,{error:{code:'CONTROL_ACTION_FAILED'}});else res.destroy();});});
 server.maxConnections=32;server.keepAliveTimeout=1000;server.on('clientError',(_error,socket)=>{socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??47831,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
 const address=server.address();if(!address||typeof address==='string')throw new Error('CONTROL_LISTEN_FAILED');host=`127.0.0.1:${address.port}`;origin=`http://${host}`;
 return {url:`${origin}/#${token}`,close:()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();})};
}

export function browserLaunch(platform:NodeJS.Platform,url:string){
 if(platform==='darwin')return {file:'/usr/bin/open',args:[url]};
 if(platform==='linux')return {file:'xdg-open',args:[url]};
 throw new Error('CONTROL_BROWSER_OPEN_UNSUPPORTED');
}
