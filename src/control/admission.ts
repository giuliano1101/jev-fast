import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {readPrivateFile,readPrivateJson} from '../service/config.js';

const connectionSchema=z.object({
 id:z.string().min(1).max(100),name:z.string().min(1).max(96),
 type:z.enum(['ai','device']),state:z.enum(['pending','enabled','stopping','offline']),
 enabled:z.boolean(),generation:z.number().int().nonnegative(),
 firstSeen:z.number().finite(),lastSeen:z.number().finite(),desiredEnabled:z.boolean().optional(),
});
export type AdmissionConnection=z.infer<typeof connectionSchema>;
export interface AdmissionAdapter {
 list():Promise<{connections:AdmissionConnection[];publicMcpUrl?:string}>;
 setEnabled(id:string,enabled:boolean):Promise<AdmissionConnection>;
}
export const admissionMutationSchema=z.strictObject({id:z.string().min(1).max(100),enabled:z.boolean()});
const unavailable=()=>new Error('CONTROL_ADMISSION_UNAVAILABLE');
const businessErrors=new Set(['DEVICE_NOT_ENABLED','DEVICE_NOT_READY','DEVICE_ALREADY_ENABLED','REVOCATION_PENDING','CONNECTION_OFFLINE','CONNECTION_NOT_FOUND']);
const configSchema=z.strictObject({
 url:z.string().url().refine(value=>{
  const url=new URL(value);
  return url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash;
 }),
 tokenFile:z.string().refine(isAbsolute),
 publicMcpUrl:z.string().url().refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.hash;}).optional(),
});
const MAX_RESPONSE_BYTES=16*1024*1024;

/** Operator-only loopback bridge. The upstream capability never reaches the browser. */
export async function loadAdmissionAdapter(file:string):Promise<AdmissionAdapter>{
 const parsed=configSchema.safeParse(await readPrivateJson(file));
 if(!parsed.success)throw new Error('INVALID_ADMISSION_CONFIGURATION');
 const config=parsed.data,origin=new URL(config.url).origin;
 async function post(path:'/api/status'|'/api/admission',body:unknown):Promise<unknown>{
  let response:Response;
  try{
   const token=(await readPrivateFile(config.tokenFile,256)).toString('utf8').trim();
   if(!/^[a-f0-9]{64}$/.test(token))throw unavailable();
   response=await fetch(new URL(path,origin),{
    method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),
    headers:{origin,'content-type':'application/json','x-jev-control-token':token},
    body:JSON.stringify(body),
   });
   if(response.status>=300&&response.status<400){await response.body?.cancel();throw unavailable();}
   const reader=response.body?.getReader();if(!reader)throw unavailable();
   const parts:Uint8Array[]=[];let bytes=0;
   for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>MAX_RESPONSE_BYTES){await reader.cancel();throw unavailable();}parts.push(part.value);}
   const value:unknown=JSON.parse(Buffer.concat(parts).toString('utf8'));
   if(!response.ok){
    const error=z.object({error:z.object({code:z.string()})}).safeParse(value);
    if(error.success&&businessErrors.has(error.data.error.code))throw new Error(error.data.error.code);
    throw unavailable();
   }
   return value;
  }catch(error){
   if(error instanceof Error&&businessErrors.has(error.message))throw error;
   throw unavailable();
  }
 }
 return {
  async list(){
   const value=z.object({connections:z.array(connectionSchema)}).safeParse(await post('/api/status',{}));
   if(!value.success)throw unavailable();
   return {...value.data,...(config.publicMcpUrl?{publicMcpUrl:config.publicMcpUrl}:{})};
  },
  async setEnabled(id,enabled){
   const input=admissionMutationSchema.parse({id,enabled});
   const value=z.object({connection:connectionSchema}).safeParse(await post('/api/admission',input));
   if(!value.success||value.data.connection.id!==id)throw unavailable();
   return value.data.connection;
  },
 };
}
