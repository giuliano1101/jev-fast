import {constants} from 'node:fs';
import {link,mkdir,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {workflowIdSchema} from './workflow-contracts.js';
import type {HybridPlanner} from './controller.js';
const ids=z.array(workflowIdSchema).max(64);
const requestSchema=z.strictObject({sessionId:workflowIdSchema,goalPredicates:ids.min(1),observation:z.strictObject({observationId:workflowIdSchema,stateKey:workflowIdSchema,readiness:z.enum(['pending','settled','unobservable']),predicates:z.record(workflowIdSchema,z.union([z.boolean(),z.literal('unknown')])),visibleActionIds:ids}),actionIds:ids.min(1),candidates:ids,remainingActions:z.number().int().min(1).max(12),reason:workflowIdSchema});
/** Local Codex host rendezvous, not an unattended model endpoint. The authorized host reads
 * request.json and atomically renames a complete response.json into place. A fresh directory
 * is required for each handoff. Only public IDs/truth values cross this boundary, never UI text,
 * coordinates, bindings, arbitrary code, authorization scope or credentials.
 */
export function createFilesystemTeacherPort(options:{directory:string;pollIntervalMs?:number}):HybridPlanner {
 let used=false;const interval=options.pollIntervalMs??50;
 if(!Number.isInteger(interval)||interval<1||interval>1000)throw new Error('INVALID_POLL_INTERVAL');
 return async(request,context)=>{
   if(used)throw new Error('HANDOFF_LIMIT');used=true;
   const parsed=requestSchema.safeParse(request);
   if(!parsed.success||parsed.data.candidates.some(id=>!parsed.data.actionIds.includes(id))||parsed.data.observation.visibleActionIds.some(id=>!parsed.data.actionIds.includes(id))||parsed.data.goalPredicates.some(id=>!(id in parsed.data.observation.predicates)))throw new Error('INVALID_TEACHER_REQUEST');
   const check=()=>{if(context.signal.aborted)throw new Error('CANCELLED');if(!Number.isFinite(context.deadline)||Date.now()>=context.deadline)throw new Error('DEADLINE');};
   check();await mkdir(options.directory,{recursive:true,mode:0o700});check();
   const nonce=randomUUID(),requestId=randomUUID();const temporary=join(options.directory,`${requestId}.tmp`);
   const file=await open(temporary,'wx',0o600);
   try{await file.writeFile(JSON.stringify({protocolVersion:1,requestId,nonce,deadline:context.deadline,...parsed.data}));await file.sync();}finally{await file.close();}
   try{check();await link(temporary,join(options.directory,'request.json'));}finally{await unlink(temporary);}
   const responseSchema=z.strictObject({requestId:z.literal(requestId),nonce:z.literal(nonce),actionIds:z.array(workflowIdSchema.refine(id=>parsed.data.actionIds.includes(id))).min(1).max(12)});
   for(;;){
     check();
     try{
       const response=await open(join(options.directory,'response.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
       let text:string;
       try{const info=await response.stat();if(!info.isFile()||info.size>16384)throw new Error('INVALID_TEACHER_RESPONSE');text=await response.readFile('utf8');}finally{await response.close();}
       check();let data:unknown;try{data=JSON.parse(text);}catch{throw new Error('INVALID_TEACHER_RESPONSE');}
       const result=responseSchema.safeParse(data);if(!result.success)throw new Error('INVALID_TEACHER_RESPONSE');
       return {actionIds:[...result.data.actionIds]};
     }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
     await new Promise<void>((resolve,reject)=>{
       const abort=()=>{clearTimeout(timer);context.signal.removeEventListener('abort',abort);reject(new Error('CANCELLED'));};
       const timer=setTimeout(()=>{context.signal.removeEventListener('abort',abort);resolve();},Math.max(1,Math.min(interval,context.deadline-Date.now())));
       context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
     });
   }
 };
}
