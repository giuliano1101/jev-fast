import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {Fault,ExecutionNotStarted} from '../core/errors.js';
import type {JsonObject} from './network-client.js';

/** One hidden UIA process amortizes startup; requests stay strictly serial on the physical desktop. */
export class WindowsUiaWorker {
 private child:ChildProcessWithoutNullStreams|undefined;
 private tail:Promise<unknown>=Promise.resolve();
 private sequence=0;
 private response:((value:JsonObject)=>void)|undefined;
 private reject:((error:Error)=>void)|undefined;
 private buffer='';
 private decoder=new StringDecoder('utf8');
 constructor(readonly script:string){}
 private start(){
  if(this.child&&!this.child.killed)return;
  this.decoder=new StringDecoder('utf8');this.buffer='';
  if(process.platform!=='win32')throw new Fault('WINDOWS_EXECUTOR_UNAVAILABLE');
  const child=spawn(join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-STA','-File',this.script,'-Server'],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;
  child.stderr.resume();
  child.stdout.on('data',(part:Buffer)=>{
   if(this.child!==child)return;this.buffer+=this.decoder.write(part);if(Buffer.byteLength(this.buffer)>16*1024*1024){this.fail(new Fault('WINDOWS_UIA_OUTPUT_TOO_LARGE'));child.kill();return;}
   let boundary:number;while((boundary=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,boundary);this.buffer=this.buffer.slice(boundary+1);if(!line.trim())continue;try{this.response?.(JSON.parse(line.replace(/^\uFEFF/,'')) as JsonObject);}catch{this.fail(new Fault('WINDOWS_UIA_INVALID_REPLY'));}}
  });
  child.once('error',()=>{if(this.child===child){this.fail(new ExecutionNotStarted());this.child=undefined;}});
  child.once('exit',()=>{if(this.child===child){this.child=undefined;this.fail(new Fault('WINDOWS_UIA_WORKER_EXITED'));}});
 }
 private fail(error:Error){this.reject?.(error);this.response=undefined;this.reject=undefined;}
 call(input:JsonObject):Promise<JsonObject>{
  const result=this.tail.then(async()=>{
   this.start();const id=++this.sequence;
   return await new Promise<JsonObject>((done,reject)=>{
    const clear=()=>{clearTimeout(timer);this.response=undefined;this.reject=undefined;};
    const timer=setTimeout(()=>{clear();this.child?.kill();reject(new Fault('WINDOWS_UIA_TIMEOUT'));},30000);
    this.reject=error=>{clear();reject(error);};
    this.response=value=>{if(value.id!==id){clear();reject(new Fault('WINDOWS_UIA_REPLY_MISMATCH'));return;}clear();if(value.ok===true)done(value.result as JsonObject);else reject(value.input_started===false&&input.operation==='act'?new ExecutionNotStarted():new Fault('WINDOWS_UIA_FAILURE'));};
    this.child!.stdin.write(JSON.stringify({id,request:input})+'\n',error=>{if(error)this.fail(new Fault('WINDOWS_UIA_WRITE_UNCERTAIN'));});
   });
  });
  this.tail=result.catch(()=>{});return result;
 }
 async close(){await this.tail;const child=this.child;if(!child)return;this.child=undefined;child.stdin.end();await new Promise<void>(done=>{const timer=setTimeout(()=>{child.kill();done();},2000);child.once('exit',()=>{clearTimeout(timer);done();});});}
}
