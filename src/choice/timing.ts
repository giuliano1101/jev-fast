import {performance} from 'node:perf_hooks';
import {Fault} from '../core/errors.js';
/** Chunk long caller timeouts rather than overflowing Node's signed 32-bit timer. */
export function choiceSignal(parent:AbortSignal,timeoutMs?:number):{signal:AbortSignal;check:()=>void;close:()=>void}{
 const started=performance.now(),controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,closed=false;
 const abort=()=>controller.abort();parent.addEventListener('abort',abort,{once:true});if(parent.aborted)abort();
 if(timeoutMs!==undefined){const schedule=()=>{if(closed||controller.signal.aborted)return;const remaining=timeoutMs-(performance.now()-started);if(remaining<=0)controller.abort();else timer=setTimeout(schedule,Math.min(remaining,2147483647));};schedule();}
 return {signal:controller.signal,check:()=>{if(timeoutMs!==undefined&&performance.now()-started>=timeoutMs)controller.abort();if(controller.signal.aborted)throw new Fault('CANCELLED');},close:()=>{closed=true;clearTimeout(timer);parent.removeEventListener('abort',abort);}};
}
/** Always consume late settlement, including when cancellation won the race. */
export function choiceWithin<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){void operation.catch(()=>{});return Promise.reject(new Fault('CANCELLED'));}
 return new Promise<T>((resolve,reject)=>{const abort=()=>reject(new Fault('CANCELLED'));signal.addEventListener('abort',abort,{once:true});operation.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}
