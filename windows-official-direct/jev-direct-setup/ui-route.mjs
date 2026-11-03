import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createJevClient} from 'file:///C:/Users/Admin/.codex/jev-direct/client.mjs';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const save=async(p,x)=>{await mkdir(dirname(p),{recursive:true});await writeFile(p,JSON.stringify(x,null,2)+'\n');};
const safeId=id=>{if(!/^[a-zA-Z0-9_-]{1,90}$/.test(id))throw Error('INVALID_OPERATION_ID');return id;};
export function identity(input){return digest({surface:input.surface,candidates:input.candidates});}
export function pickAnswer(result,candidates){
 const choice=result.answers?.target,exists=result.answers?.has_target?.noul;
 const id=choice?.choice,p=choice?.probabilities?.[id];
 const remaining=Object.entries(choice?.probabilities??{}).filter(([k])=>k!==id).map(([,v])=>v),margin=p-Math.max(0,...remaining);
 return {selected:candidates.find(x=>x.id===id),eligible:Number.isFinite(exists)&&exists>=.7&&Number.isFinite(p)&&p>=.55&&margin>=.15,has_target:exists,probability:p,margin};
}
export function validateObservation(input){
 if(!input.surface?.id||!['iab','chrome','desktop'].includes(input.surface.kind))throw Error('INVALID_SURFACE');
 if(!Number.isFinite(Date.parse(input.observed_at))||Date.now()-Date.parse(input.observed_at)>60000||Date.parse(input.observed_at)>Date.now()+5000)throw Error('STALE_OBSERVATION');
 if(!Array.isArray(input.candidates)||input.candidates.length>60)throw Error('INVALID_CANDIDATES');
 const ids=new Set();for(const c of input.candidates){safeId(c.id);if(ids.has(c.id)||!c.name||!c.binding||!['click','fill','press','download','scroll','screenshot','navigate'].includes(c.action))throw Error('INVALID_CANDIDATE');ids.add(c.id);}
}
export async function decide(runPath,input,{clientFactory=createJevClient}={}){
 const run=await load(runPath),base=dirname(resolve(runPath)),op=join(base,'operations',safeId(input.operation_id)+'.json');
 validateObservation(input);
 const requestHash=digest(input);
 try{const old=await load(op);if(old.request_hash!==requestHash)throw Error('OPERATION_ID_CONFLICT');return old;}catch(e){if(e.code!=='ENOENT')throw e;}
 const record={operation_id:input.operation_id,request_hash:requestHash,observation_hash:identity(input),surface:input.surface,observed_at:input.observed_at,status:'deciding',started_at:new Date().toISOString()};
 await save(op,record);
 const fallback=async reason=>{record.route='codex';record.reason=reason;record.status='fallback_required';await save(op,record);return record;};
 if(!input.candidates.length)return fallback('no_grounded_candidates');
 if(run.authorization?.status!=='approved'||Date.now()+31000>=Date.parse(run.authorization.expires_at))return fallback('paid_authorization_unavailable');
 const ledgerPath=join(base,'usage.json');let usage;try{usage=await load(ledgerPath);}catch(e){if(e.code!=='ENOENT')throw e;usage={attempts:[]};}
 const reservation=.002688,used=usage.attempts.reduce((n,a)=>n+(a.cost_usd??reservation),0);
 if(usage.attempts.length>=run.authorization.max_requests||used+reservation>run.authorization.max_cost_usd)return fallback('budget_exhausted');
 const attempt={operation_id:input.operation_id,started_at:new Date().toISOString(),reserved_usd:reservation,status:'reserved'};
 usage.attempts.push(attempt);await save(ledgerPath,usage);
 const criteria=Object.fromEntries(input.candidates.map(c=>[c.id,{name:c.name,role:c.role,action:c.action}]));
 const request={state:{target_description:input.target_description,candidates:Object.fromEntries(input.candidates.map(c=>[c.id,{name:c.name,role:c.role,action:c.action}]))},questions:{target:{type:'choice',instructions:'Which candidate best matches target_description?',criteria},has_target:{type:'noul',instructions:'Does at least one candidate match target_description?'}}};
 await save(join(base,'operations',input.operation_id+'.request.json'),request);
 const start=performance.now();
 try{
  const client=clientFactory();const {data,requestId}=await client.systemOne(request).withResponse();
  record.decision_ms=Math.round(performance.now()-start);record.model=data.model;record.request_id=requestId;record.usage=data.usage;record.answers=data.answers;
  attempt.status='completed';attempt.usage=data.usage;attempt.request_id=requestId;attempt.cost_usd=Number.isInteger(data.usage?.input_tokens)?data.usage.input_tokens*.042/1e6:undefined;
  await save(ledgerPath,usage);
  const picked=pickAnswer(data,input.candidates);record.judgment={has_target:picked.has_target,probability:picked.probability,margin:picked.margin};
  if(!picked.selected||!picked.eligible)return fallback('uncertain_or_no_matching_target');
  record.route='jev';record.selected=picked.selected;record.status='ready';await save(op,record);return record;
 }catch(e){attempt.status='error_or_unknown';attempt.error={name:e.constructor?.name,status:e.status};await save(ledgerPath,usage);record.error=attempt.error;return fallback('official_api_error');}
}
export async function begin(runPath,operationId,current){
 const base=dirname(resolve(runPath)),op=join(base,'operations',safeId(operationId)+'.json'),r=await load(op);
 validateObservation(current);
 if(r.status!=='ready')throw Error('NOT_READY_OR_ALREADY_EXECUTED');
 if(identity(current)!==r.observation_hash)throw Error('OBSERVATION_CHANGED');
 const claim=await open(join(base,'operations',operationId+'.execution-claim'),'wx');await claim.close();
 r.status='executing';r.execution_started_at=new Date().toISOString();await save(op,r);return r;
}
export async function finish(runPath,operationId,result){
 const op=join(dirname(resolve(runPath)),'operations',safeId(operationId)+'.json'),r=await load(op);
 if(!['executing','fallback_required'].includes(r.status))throw Error('NOT_EXECUTING');
 if(!['verified','failed','unknown'].includes(result.outcome)||!result.evidence)throw Error('VERIFICATION_REQUIRED');
 r.status=result.outcome==='verified'?'verified':result.outcome==='failed'?'failed':'unknown';r.verification=result;r.finished_at=new Date().toISOString();await save(op,r);return r;
}
async function cli(){const [cmd,runPath,a,b]=process.argv.slice(2);let value;
 if(cmd==='decide')value=await decide(runPath,await load(a));
 else if(cmd==='begin')value=await begin(runPath,a,await load(b));
 else if(cmd==='finish')value=await finish(runPath,a,await load(b));
 else throw Error('USAGE: ui-route.mjs decide RUN STEP | begin RUN ID CURRENT | finish RUN ID RESULT');
 console.log(JSON.stringify(value));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)cli().catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1;});
