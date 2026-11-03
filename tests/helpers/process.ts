import {spawn} from 'node:child_process';
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
