/** One non-executing provider timing diagnostic, sharing the existing pilot budget. */
import {parseArgs} from 'node:util';
import {resolve,dirname,join} from 'node:path';
import {writeFileSync,realpathSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {channel} from 'node:diagnostics_channel';
import {JevProvider} from '../../src/providers/jev.js';
import {readPrivateFile,readPrivateJson} from '../../src/service/config.js';
import {GatewayStore} from '../../src/remote/store.js';
import {canonicalDigest} from '../../src/remote/protocol.js';
import {validatePilotApproval,createAttemptObserver} from './pilot.js';
const {values}=parseArgs({options:{approval:{type:'string'},'key-file':{type:'string'},out:{type:'string'},mock:{type:'boolean'}},strict:true});
if(!values.approval||!values.out||(!values.mock&&!values['key-file']))throw Error('DIAGNOSTIC_ARGUMENTS');
const approvalPath=realpathSync(resolve(values.approval)),approval=validatePilotApproval(await readPrivateJson(approvalPath)),state=dirname(approvalPath);
const out=resolve(values.out);writeFileSync(out,'{}\n',{flag:'wx',mode:0o600});
writeFileSync(join(state,'diagnostic-started.json'),JSON.stringify({started_at:new Date().toISOString()}),{flag:'wx',mode:0o600});
const store=new GatewayStore(state),identity={owner_id:'s10-pilot-owner',device_id:'local-mac',agent_id:'timing-diagnostic'},id='connect-diagnostic';
const start=performance.now(),phases:Array<{name:string;elapsed_ms:number;status?:number}>=[];
const listeners=['undici:client:beforeConnect','undici:client:connected','undici:request:headers'].map(name=>{const listener=(message:unknown)=>{const status=(message as {response?:{statusCode?:number}})?.response?.statusCode;phases.push({name,elapsed_ms:performance.now()-start,...(typeof status==='number'?{status}:{})});};channel(name).subscribe(listener);return {name,listener};});
const fake=async()=>new Response(JSON.stringify({model:'jev-1.14.0',answers:{action:{type:'choice',choice:'select',confidence:1}},usage:{input_tokens:1,output_tokens:0}})),observer=createAttemptObserver(values.mock?fake:fetch,()=>{},()=>id,()=>{});
const report:Record<string,unknown>={mode:values.mock?'mock':'live',scope:'provider timing only; no Engine, browser or execution receipt',provider_timeout_ms:10000};
let begun=false;
try{
 store.configureBudget(approval.approval);report.budget_before=store.budget(approval.approval.approval_id);
 const input={synthetic:true as const,snapshot_id:'timing-only',summary:JSON.stringify({task:'select',step:0,submitted:0,cancelled:false,loaded:false,scrolled:false,error:false}),goal:{task:'select' as const,language:'en' as const},candidates:[{candidate_id:'select',description:'select category (synthetic action)'},{candidate_id:'cancel',description:'click cancel (synthetic action)'}]};
 if(store.begin(identity,id,canonicalDigest(input).slice(7)).status!=='started')throw Error('DIAGNOSTIC_ALREADY_STARTED');begun=true;
 const key=values.mock?'mock-only':(await readPrivateFile(resolve(values['key-file']!),8192)).toString().trim();
 const provider=new JevProvider({key,authorization:approval.authorization,transport:observer.transport,beforeAttempt:()=>{store.reserve(identity,id,approval.approval.approval_id);}});
 const decision=await provider.decide(input,{signal:new AbortController().signal,deadline:Date.now()+10000});
 report.decision={confidence:decision.confidence,usage:decision.usage,elapsed_ms:decision.elapsed_ms,request_count:decision.request_count,retry_count:decision.retry_count};
 store.reject(identity,id,'DIAGNOSTIC_ONLY');begun=false;
}catch(error){report.error=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'DIAGNOSTIC_FAILED';if(begun)store.markUnknown(identity,id);}
finally{
 await observer.settle();for(const {name,listener} of listeners)channel(name).unsubscribe(listener);
 report.elapsed_ms=performance.now()-start;report.phases=phases;report.attempts=observer.attempts;report.budget_after=store.budget(approval.approval.approval_id);store.close();writeFileSync(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});
}
console.log(JSON.stringify(report));
