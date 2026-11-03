import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {image} from 'file:///C:/Users/Admin/.codex/jev-direct/node_modules/@typesafe-ai/sdk/dist/index.mjs';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
export async function askOfficial(runPath,body,client){
 const base=dirname(resolve(runPath)),run=await load(runPath),reservation=.002688;
 if(run.authorization?.status!=='approved'||Date.now()+31000>=Date.parse(run.authorization.expires_at))throw Error('PAID_AUTHORIZATION_EXPIRED');
 let ledger;try{ledger=await load(join(base,'usage.json'));}catch(e){if(e.code!=='ENOENT')throw e;ledger={attempts:[]};}
 if(ledger.attempts.length>=run.authorization.max_requests||ledger.attempts.reduce((n,a)=>n+(a.cost_usd??reservation),0)+reservation>run.authorization.max_cost_usd)throw Error('PAID_BUDGET_EXHAUSTED');
 const id='desktop-'+Date.now()+'-'+ledger.attempts.length;
 const request={...body};delete request._image_path;
 if(body._image_path){
  const p=resolve(body._image_path),r=relative(base,p);if(r.startsWith('..')||isAbsolute(r))throw Error('IMAGE_OUTSIDE_TASK_ARTIFACTS');
  request.state={...request.state,screenshot:image(await readFile(p))};
 }
 const attempt={operation_id:id,started_at:new Date().toISOString(),status:'reserved',reserved_usd:reservation};ledger.attempts.push(attempt);
 const persist=()=>writeFile(join(base,'usage.json'),JSON.stringify(ledger,null,2));await persist();await mkdir(join(base,'operations'),{recursive:true});
 await writeFile(join(base,'operations',id+'.request.json'),JSON.stringify(body,null,2));
 const start=performance.now();
 try{
  const {data,requestId}=await client.systemOne(request,body._image_path?{headers:{'TypeSafe-Danger-Zone-Images':'true'},retry:{maxRetries:0}}:undefined).withResponse();
  Object.assign(attempt,{status:'completed',request_id:requestId,model:data.model,usage:data.usage,elapsed_ms:Math.round(performance.now()-start),cost_usd:Number.isInteger(data.usage?.input_tokens)?data.usage.input_tokens*.042/1e6:undefined});await persist();
  await writeFile(join(base,'operations',id+'.response.json'),JSON.stringify({request_id:requestId,...data},null,2));return data;
 }catch(e){attempt.status='error_or_unknown';attempt.error={name:e.constructor.name,status:e.status,detail:e.body};await persist();throw Error('OFFICIAL_API_FAILED_'+(e.status??'TRANSPORT')+': '+JSON.stringify(e.body??{}).slice(0,800));}
}

