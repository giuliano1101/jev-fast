import {startService,stopService,serviceHealth,inspectService} from '../../src/service/lifecycle.js';
import {safeCode} from '../../src/service/ipc.js';
export async function runLifecycle(runtime:string,args:string[]){
 try{
  const option=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const result=args[0]==='start'?await startService({runtime,...(option('--config')?{configFile:option('--config')}:{}),...(args.includes('--share-a-with-b')?{shared:true}:{}),recover:args.includes('--recover')}):args[0]==='stop'?await stopService(runtime):args[0]==='doctor'?await inspectService(runtime):await serviceHealth(runtime);
  return {code:0,stdout:JSON.stringify(result),stderr:''};
 }catch(error){return {code:1,stdout:JSON.stringify({error:{code:safeCode(error)}}),stderr:''};}
}
