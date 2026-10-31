import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {defaultRuntime} from '../service/runtime.js';
import {controlPage,controlScript,controlStyle} from './ui.js';
export {defaultRuntime} from '../service/runtime.js';
export interface CommandResult {code:number|null;stdout:string;failure?:string}
export async function executeBounded(file:string,args:string[],options:{timeoutMs?:number;maxBytes?:number}={}):Promise<CommandResult>{
 return new Promise(resolve=>{
  let stdout='',bytes=0,limited=false,settled=false;
  const child=spawn(file,args,{shell:false,stdio:['ignore','pipe','pipe'],windowsHide:true});
  const limit=()=>{limited=true;child.kill('SIGKILL');};
  const timer=setTimeout(limit,options.timeoutMs??15000);
  const finish=(result:CommandResult)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
  child.stdout.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>(options.maxBytes??65536)){limit();return;}stdout+=data.toString('utf8');});
  child.stderr.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>(options.maxBytes??65536))limit();});
  child.once('error',()=>finish({code:null,stdout:'',failure:'CONTROL_COMMAND_FAILED'}));
  child.once('close',code=>finish(limited?{code:null,stdout:'',failure:'CONTROL_COMMAND_LIMIT'}:{code,stdout}));
 });
}
export interface ControlStatus {state:'running'|'unavailable'|'blocked';mode:'mock'|'remote'|'unknown';decisionProvider:'mock'|'jev'|'unknown';remoteReachable:boolean|null;routeCompatible?:boolean;installation?:{nodeSupported:boolean|null;chromiumAvailable:boolean|null;runtime:string;socket:string}}
export interface ControlAdapter {status:()=>Promise<ControlStatus>;start:()=>Promise<void>;stop:()=>Promise<void>}
const actionCodes=new Set(['SERVICE_PROFILE_MISMATCH','UNSAFE_PRIVATE_FILE','INVALID_SERVICE_CONFIGURATION','INVALID_CONFIGURATION_JSON','UNSAFE_RUNTIME','SERVICE_START_FAILED','SERVICE_START_TIMEOUT','SERVICE_STOP_TIMEOUT','REMOTE_SHARING_NOT_SUPPORTED','CONTROL_COMMAND_LIMIT']);
function safeError(error:unknown){const code=error instanceof Error?error.message:'';return actionCodes.has(code)?code:'CONTROL_ACTION_FAILED';}
function record(value:unknown):Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:{};}
const booleanOrNull=(value:unknown)=>typeof value==='boolean'?value:null;
export class CliControlAdapter implements ControlAdapter {
 private readonly runtime:string;private readonly config?:string;private readonly execute:typeof executeBounded;
 constructor(options:{runtime:string;config?:string;execute?:typeof executeBounded}){this.runtime=resolve(options.runtime);this.config=options.config?resolve(options.config):undefined;this.execute=options.execute??executeBounded;}
 private async command(command:string[]):Promise<Record<string,unknown>>{
  const result=await this.execute(process.execPath,[fileURLToPath(new URL('../cli/index.js',import.meta.url)),...command,'--runtime',this.runtime,...(command.join(' ')==='service start'&&this.config?['--config',this.config]:[]),'--json']);
  if(result.failure)throw new Error(result.failure);
  let value:Record<string,unknown>;try{value=record(JSON.parse(result.stdout));}catch{throw new Error('CONTROL_ACTION_FAILED');}
  if(result.code!==0||value.error)throw new Error(safeError(new Error(String(record(value.error).code))));return value;
 }
 async status():Promise<ControlStatus>{
  try{
   const value=await this.command(['doctor']),raw=record(value.installation),runtime=record(raw.runtime).status,socket=record(raw.socket).status;
   const status=(value:unknown)=>['missing','private','unsafe','unreadable'].includes(String(value))?String(value):'unknown';
   const installation={nodeSupported:booleanOrNull(record(raw.node).supported),chromiumAvailable:booleanOrNull(record(raw.chromium).executableAvailable),runtime:status(runtime),socket:status(socket)};
   const unavailable=value.ready===false&&installation.nodeSupported===true&&['missing','private'].includes(installation.runtime)&&installation.socket==='missing';
   return {state:value.ready===true?'running':unavailable?'unavailable':'blocked',mode:value.transport==='remote'?'remote':value.provider==='mock'||value.provider==='remote'?value.provider:'unknown',decisionProvider:value.provider==='mock'||value.provider==='jev'?value.provider:'unknown',remoteReachable:booleanOrNull(value.remoteReachable),...(typeof value.routeCompatible==='boolean'?{routeCompatible:value.routeCompatible}:{}),installation};
  }catch{return {state:'blocked',mode:'unknown',decisionProvider:'unknown',remoteReachable:null};}
 }
 async start(){await this.command(['service','start']);}
 async stop(){await this.command(['service','stop']);}
}
export function parseControlArgs(args:string[]){
 try{
  const {values}=parseArgs({args,strict:true,allowPositionals:false,options:{runtime:{type:'string'},config:{type:'string'},port:{type:'string'},help:{type:'boolean',short:'h'},open:{type:'boolean'}}});
  if(values.help&&Object.keys(values).some(key=>key!=='help'))throw new Error();
  const port=values.port===undefined?47831:Number(values.port);
  if(values.port!==undefined&&!/^\d+$/.test(values.port)||!Number.isInteger(port)||port<0||port>65535||values.runtime===''||values.config==='')throw new Error();
  return {runtime:resolve(values.runtime??defaultRuntime()),...(values.config?{config:resolve(values.config)}:{}),port,help:values.help??false,...(values.open?{open:true}:{})};
 }catch{throw new Error('INVALID_ARGUMENTS');}
}
export async function startControlPanel(options:{runtime:string;config?:string;port?:number;adapter?:ControlAdapter}){
 const runtime=resolve(options.runtime),adapter=options.adapter??new CliControlAdapter({runtime,config:options.config});
 const token=randomBytes(32).toString('hex');let origin='',host='';let mutations:Promise<unknown>=Promise.resolve();
 function respond(res:ServerResponse,status:number,value:unknown,type='application/json; charset=utf-8'){
  const body=typeof value==='string'?value:JSON.stringify(value);res.writeHead(status,{'content-type':type,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'content-length':Buffer.byteLength(body)});res.end(body);
 }
 const count=(req:IncomingMessage,name:string)=>req.rawHeaders.filter((_,index)=>index%2===0&&req.rawHeaders[index]!.toLowerCase()===name).length;
 const authorized=(req:IncomingMessage)=>{
  const actual=req.headers['x-jev-control-token'];return count(req,'origin')===1&&req.headers.origin===origin&&req.headers['sec-fetch-site']!=='cross-site'&&typeof actual==='string'&&Buffer.byteLength(actual)===Buffer.byteLength(token)&&count(req,'x-jev-control-token')===1&&timingSafeEqual(Buffer.from(actual),Buffer.from(token));
 };
 const server=createServer({maxHeaderSize:8192,requestTimeout:5000,headersTimeout:5000},(req,res)=>{void (async()=>{
  if(req.headers.host!==host||count(req,'host')!==1){respond(res,403,{error:{code:'CONTROL_FORBIDDEN'}});return;}
  if(req.url==='/'&&req.method==='GET'){respond(res,200,controlPage({runtime,node:process.execPath,mcp:fileURLToPath(new URL('../mcp/index.js',import.meta.url)),cli:fileURLToPath(new URL('../cli/index.js',import.meta.url)),credential:join(runtime,'client-a.json'),configured:!!options.config}),'text/html; charset=utf-8');return;}
  if(req.url==='/app.js'&&req.method==='GET'){respond(res,200,controlScript,'text/javascript; charset=utf-8');return;}
  if(req.url==='/style.css'&&req.method==='GET'){respond(res,200,controlStyle,'text/css; charset=utf-8');return;}
  if(!authorized(req)){respond(res,403,{error:{code:'CONTROL_FORBIDDEN'}});return;}
  if(!['/api/status','/api/start','/api/stop'].includes(req.url??'')){respond(res,404,{error:{code:'CONTROL_NOT_FOUND'}});return;}
  if(!(req.method==='POST'||req.method==='GET'&&req.url==='/api/status')){respond(res,405,{error:{code:'CONTROL_METHOD_NOT_ALLOWED'}});return;}
  if(Number(req.headers['content-length']??0)>2048){respond(res,413,{error:{code:'CONTROL_BODY_TOO_LARGE'}});return;}
  let size=0;const chunks:Buffer[]=[];
  // Limit body collection only; CLI commands retain their own bounded deadline.
  const bodyDeadline=setTimeout(()=>req.destroy(),5000);
  try{for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>2048){respond(res,413,{error:{code:'CONTROL_BODY_TOO_LARGE'}});return;}chunks.push(Buffer.from(chunk));}}
  finally{clearTimeout(bodyDeadline);}
  if(Buffer.concat(chunks).toString('utf8')!==''){respond(res,400,{error:{code:'CONTROL_INVALID_BODY'}});return;}
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
