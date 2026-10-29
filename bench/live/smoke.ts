import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {JevProvider} from '../../src/providers/jev.js';
import {Fault} from '../../src/core/errors.js';
import {readLocalKey,RequestBudget} from './access.js';

export async function smoke(keyPath:string){
 const key=readLocalKey(keyPath);
 const directory=resolve('artifacts/live');await mkdir(directory,{recursive:true,mode:0o700});
 const budgetDirectory=resolve('.runtime/live-budget');
 let expiresAt=Date.now()+2*60*60*1000;
 try{const prior=JSON.parse(await readFile(resolve(budgetDirectory,'budget.json'),'utf8'));expiresAt=prior.expiresAt;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('BUDGET_READ_REJECTED');}
 const budget=RequestBudget.open(budgetDirectory,{maxUsd:3,maxRequests:300,expiresAt});
 const responses:Array<Record<string,unknown>>=[];const trials:Array<Record<string,unknown>>=[];
 const provider=new JevProvider({key,authorization:{approval_id:'user-20261030-usd3',expires_at:budget.summary().expiresAt,synthetic_only:true,max_requests:300,max_cost_usd:3},transport:async(url,options)=>{
  if(url!=='https://api.typesafe.ai/v1/systemone')throw new Error('ENDPOINT_DENIED');
  const reserved=budget.reserve();const started=performance.now();
  const entry:Record<string,unknown>={request:reserved.request,status:'pending',compressed:new Headers(options?.headers).get('content-encoding')==='zstd'};responses.push(entry);
  const response=await fetch(url,options);
  entry.status=response.status;entry.headers_elapsed_ms=performance.now()-started;
  return response;
 }});
 try{
  for(const large of [false,true]){
   const start=performance.now();
   try{
    const result=await provider.decide({snapshot_id:large?'compressed-smoke':'plain-smoke',synthetic:true,
     summary:'Synthetic browser task: click the Continue button to proceed. '+(large?'The Cancel button must not be selected. '.repeat(40):''),
     goal:{task:'form',language:'en'},candidates:[{candidate_id:'continue',description:'Click Continue to proceed with the synthetic task'},{candidate_id:'cancel',description:'Cancel the synthetic task without completing it'}]},
     {signal:new AbortController().signal,deadline:Date.now()+15000});
    trials.push({variant:large?'compressed':'plain',status:'passed',correct:result.candidate_id==='continue',confidence:result.confidence,model:result.model,elapsed_ms:performance.now()-start,usage:result.usage});
   }catch(error){trials.push({variant:large?'compressed':'plain',status:'failed',reason:error instanceof Fault?error.code:'REQUEST_FAILED',elapsed_ms:performance.now()-start});break;}
  }
  const report={created_at:new Date().toISOString(),live_api_called:responses.length>0,status:trials.length===2&&trials.every(t=>t.status==='passed'&&t.correct)?'passed':'failed',trials,responses,budget:budget.summary(),accounting:provider.accounting(),price_source:'https://docs.typesafe.ai/models',notes:'Reservations are conservative spend ceilings, not invoices; current-session Codex cost is unavailable.'};
  await writeFile(resolve(directory,`smoke-${Date.now()}.json`),JSON.stringify(report,null,2),{mode:0o600});
  await writeFile(resolve(directory,'smoke.json'),JSON.stringify(report,null,2),{mode:0o600});
  return report;
 }finally{budget.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 smoke(process.argv[2]??'').then(report=>{console.log(JSON.stringify(report));if(report.status!=='passed')process.exitCode=1;}).catch(()=>{console.error('LIVE_SMOKE_FAILED_CLOSED');process.exitCode=1;});
}
