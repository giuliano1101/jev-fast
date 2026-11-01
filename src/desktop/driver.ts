import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isAbsolute,win32} from 'node:path';
import {z} from 'zod';

export interface NativeLaunchSpec {command:string;args:string[];env?:Record<string,string>}
export function nativeLaunchSpec(platform:string=process.platform):NativeLaunchSpec {
 if(platform==='darwin')return {command:fileURLToPath(new URL('../../native/jev-desktop-macos',import.meta.url)),args:[]};
 if(platform==='win32')return {command:win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoProfile','-NonInteractive','-STA','-File',fileURLToPath(new URL('../../native/desktop-windows.ps1',import.meta.url))]};
 throw new Error('DESKTOP_PLATFORM_UNSUPPORTED');
}
const responseSchema=z.discriminatedUnion('ok',[
 z.strictObject({id:z.string(),ok:z.literal(true),result:z.record(z.string(),z.json())}),
 z.strictObject({id:z.string(),ok:z.literal(false),error:z.object({code:z.string().regex(/^[A-Z][A-Z0-9_]*$/)})}),
]);
const MAX_BYTES=16*1024*1024;
type Pending={id:string;resolve:(result:Record<string,unknown>)=>void;reject:(error:Error)=>void};
type Instance={child:ChildProcessWithoutNullStreams;exit:Promise<void>;buffer:Buffer;pending?:Pending;fault?:string;force?:ReturnType<typeof setTimeout>};

/** One native command at a time. A dead helper may be replaced for a new request;
 * the command whose outcome was lost is never replayed. */
export class NativeDesktopDriver {
 private instance?:Instance;private tail:Promise<void>=Promise.resolve();private stopped=false;private closing?:Promise<void>;
 constructor(private readonly spec:NativeLaunchSpec){if(!isAbsolute(spec.command)||!spec.args.every(value=>typeof value==='string'))throw new Error('INVALID_NATIVE_CONFIGURATION');}
 private start():Instance {
  const child=spawn(this.spec.command,this.spec.args,{shell:false,stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,...this.spec.env,JEV_DESKTOP_PARENT_PID:String(process.pid)}});
  let exited!:()=>void;const state:Instance={child,buffer:Buffer.alloc(0),exit:new Promise(resolve=>{exited=resolve;})};this.instance=state;
  const fault=(code:string)=>{state.fault=code;child.kill('SIGTERM');state.force??=setTimeout(()=>child.kill('SIGKILL'),1000);};
  child.stdin.on('error',()=>fault('DESKTOP_NATIVE_UNKNOWN'));
  child.stdout.on('error',()=>fault('DESKTOP_NATIVE_UNKNOWN'));
  child.stderr.on('data',()=>{/* Raw native/AppKit diagnostics are not protocol or public output. */});
  child.stdout.on('data',(part:Buffer)=>{
   if(state.fault)return;state.buffer=Buffer.concat([state.buffer,part]);
   if(state.buffer.length>MAX_BYTES){fault('DESKTOP_NATIVE_RESPONSE_LIMIT');return;}
   for(;;){const end=state.buffer.indexOf(10);if(end<0)break;const line=state.buffer.subarray(0,end);state.buffer=state.buffer.subarray(end+1);if(!line.length)continue;
    let value:z.infer<typeof responseSchema>;try{value=responseSchema.parse(JSON.parse(line.toString('utf8')));}catch{fault('DESKTOP_NATIVE_UNKNOWN');return;}
    const pending=state.pending;if(!pending||value.id!==pending.id){fault('DESKTOP_NATIVE_UNKNOWN');return;}state.pending=undefined;
    if(value.ok)pending.resolve(value.result);else pending.reject(new Error(value.error.code));
   }
  });
  child.once('error',()=>{state.fault='DESKTOP_NATIVE_UNAVAILABLE';});
  child.once('close',()=>{clearTimeout(state.force);if(this.instance===state)this.instance=undefined;const pending=state.pending;state.pending=undefined;pending?.reject(new Error(state.fault??'DESKTOP_NATIVE_UNKNOWN'));exited();});
  return state;
 }
 call(method:string,params:Record<string,unknown>):Promise<Record<string,unknown>> {
  if(this.stopped)return Promise.reject(new Error('DESKTOP_NATIVE_CLOSED'));
  const work=this.tail.then(async()=>{
   if(this.stopped)throw new Error('DESKTOP_NATIVE_CLOSED');
   const state=this.instance??this.start();const id=randomUUID(),line=JSON.stringify({id,method,params})+'\n';
   if(Buffer.byteLength(line)>MAX_BYTES)throw new Error('DESKTOP_NATIVE_REQUEST_LIMIT');
   return new Promise<Record<string,unknown>>((resolve,reject)=>{
    state.pending={id,resolve,reject};state.child.stdin.write(line,error=>{if(error){state.fault='DESKTOP_NATIVE_UNKNOWN';state.child.kill('SIGTERM');}});
   });
  });
  this.tail=work.then(()=>{},()=>{});return work;
 }
 close():Promise<void> {
  if(this.closing)return this.closing;this.stopped=true;
  this.closing=(async()=>{const state=this.instance;if(state){state.child.stdin.end();let force:ReturnType<typeof setTimeout>|undefined;const terminate=setTimeout(()=>{state.child.kill('SIGTERM');force=setTimeout(()=>state.child.kill('SIGKILL'),1000);},1000);try{await state.exit;}finally{clearTimeout(terminate);clearTimeout(force);}}await this.tail;})();return this.closing;
 }
}
