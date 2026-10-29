export interface TrialRow {
 id:string;mode:'jev'|'scripted'|'computer-use';family:'locate'|'form';difficulty:'easy'|'medium'|'hard';seed:number;
 phase:'calibration'|'evaluation'|'stress';status:string;elapsed_ms:number;setup_ms:number;
 actions:number;wrong_actions:number;rejections:number;decisions:number;requests:number;
 cost_usd:number|null;reason:string|null;
 known_cost_usd?:number;unknown_usage_requests?:number;latency_censored?:boolean;actions_known?:boolean;
}
function percentile(values:number[],q:number):number|null{
 if(!values.length)return null;
 if(values.some(n=>!Number.isFinite(n)||n<0))throw new Error('INVALID_METRIC');
 const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*q)-1)]!;
}
function interval(successes:number,n:number){
 if(!n)return null;const z=1.96,p=successes/n,d=1+z*z/n;
 const center=(p+z*z/(2*n))/d,half=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/d;
 return {lower:Math.max(0,center-half),upper:Math.min(1,center+half)};
}
export function summarizeLive(rows:TrialRow[]){
 const successes=rows.filter(r=>r.status==='SUCCEEDED');const clean=successes.filter(r=>r.wrong_actions===0);
 const failures:Record<string,number>={};for(const row of rows.filter(r=>r.status!=='SUCCEEDED'))failures[row.reason??row.status]=(failures[row.reason??row.status]??0)+1;
 return {tasks:rows.length,successes:successes.length,clean_successes:clean.length,recovered_successes:successes.length-clean.length,
  success_rate:rows.length?successes.length/rows.length:null,clean_success_rate:rows.length?clean.length/rows.length:null,
  success_rate_95_interval:interval(successes.length,rows.length),clean_success_rate_95_interval:interval(clean.length,rows.length),
  p50_all_started_ms:percentile(rows.filter(r=>!r.latency_censored).map(r=>r.elapsed_ms),.5),p95_all_started_ms:percentile(rows.filter(r=>!r.latency_censored).map(r=>r.elapsed_ms),.95),
  p50_clean_success_ms:percentile(clean.map(r=>r.elapsed_ms),.5),p95_clean_success_ms:percentile(clean.map(r=>r.elapsed_ms),.95),
  wrong_actions:rows.reduce((n,r)=>n+r.wrong_actions,0),actions:rows.reduce((n,r)=>n+r.actions,0),
  rejections:rows.reduce((n,r)=>n+r.rejections,0),requests:rows.reduce((n,r)=>n+r.requests,0),
  known_cost_usd:rows.reduce((n,r)=>n+(r.known_cost_usd??r.cost_usd??0),0),unknown_cost_trials:rows.filter(r=>r.cost_usd===null).length,
  unknown_usage_requests:rows.reduce((n,r)=>n+(r.unknown_usage_requests??0),0),censored_latency_trials:rows.filter(r=>r.latency_censored).length,
  unknown_action_trials:rows.filter(r=>r.actions_known===false).length,failures};
}
export function pairedComparison(rows:TrialRow[]){
 const pairs=new Map<string,Partial<Record<TrialRow['mode'],TrialRow>>>();
 for(const row of rows.filter(r=>r.phase==='evaluation'&&r.mode!=='scripted')){
  const key=`${row.family}/${row.difficulty}/${row.seed}`;const pair=pairs.get(key)??{};
  if(pair[row.mode])throw new Error('DUPLICATE_PAIRED_CASE');pair[row.mode]=row;pairs.set(key,pair);
 }
 const matched=[...pairs.values()].filter(p=>p.jev&&p['computer-use']);
 const clean=matched.filter(p=>p.jev!.status==='SUCCEEDED'&&p['computer-use']!.status==='SUCCEEDED'&&!p.jev!.latency_censored&&!p['computer-use']!.latency_censored&&p.jev!.wrong_actions===0&&p['computer-use']!.wrong_actions===0&&p.jev!.elapsed_ms>0);
 const ratios=clean.map(p=>p['computer-use']!.elapsed_ms/p.jev!.elapsed_ms);
 return {matched_cases:matched.length,both_clean_successes:clean.length,median_paired_speed_ratio:percentile(ratios,.5),
  jev_failures_in_matched_cases:matched.filter(p=>p.jev!.status!=='SUCCEEDED').length,
  computer_use_failures_in_matched_cases:matched.filter(p=>p['computer-use']!.status!=='SUCCEEDED').length,
  note:'Ratio is computer-use / Jev page-initialization-to-terminal latency on paired clean successes only; failures remain in separate reliability denominators. Includes initial control delays; browser startup is separate. Architecture comparison, not isolated model speed.'};
}
/** Recover denominator entries from durable starts; interrupted latency is only a lower bound. */
export function reconcileTrials(rows:TrialRow[],events:Array<Record<string,unknown>>):TrialRow[]{
 const unique=new Map<string,TrialRow>();for(const row of rows){if(unique.has(row.id))throw new Error('DUPLICATE_TERMINAL_ROW');unique.set(row.id,row);}
 for(const start of events.filter(e=>e.phase==='trial'&&e.status==='started')){
  const id=start.trial,spec=start.spec as Record<string,unknown>|undefined;
  if(typeof id!=='string'||!spec||!['locate','form'].includes(String(spec.family))||!['easy','medium','hard'].includes(String(spec.difficulty))||!Number.isInteger(spec.seed)||!['jev','scripted'].includes(String(start.mode)))throw new Error('INVALID_DURABLE_START');
  if(unique.has(id))continue;
  const trail=events.filter(e=>e.trial===id),reserved=trail.filter(e=>e.phase==='transport'&&e.status==='reserved').length;
  let known=0,knownRequests=0;for(const event of trail.filter(e=>e.phase==='provider'&&e.status==='decided')){
   const usage=event.usage as {input_tokens?:unknown}|undefined;
   if(usage&&typeof usage.input_tokens==='number'&&Number.isInteger(usage.input_tokens)&&usage.input_tokens>=0){known+=usage.input_tokens*.042/1e6;knownRequests++;}
  }
  const times=trail.map(e=>e.at_ms).filter((n):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0);
  unique.set(id,{id,mode:start.mode as TrialRow['mode'],family:spec.family as TrialRow['family'],difficulty:spec.difficulty as TrialRow['difficulty'],seed:spec.seed as number,
   phase:spec.mode==='calibration'?'calibration':'evaluation',status:'UNKNOWN',elapsed_ms:Math.max(0,...times),latency_censored:true,setup_ms:0,
   actions:0,actions_known:false,wrong_actions:0,rejections:0,decisions:trail.filter(e=>e.phase==='provider'&&e.status==='started').length,
   requests:reserved,cost_usd:null,known_cost_usd:known,unknown_usage_requests:Math.max(0,reserved-knownRequests),reason:'RUN_INTERRUPTED'});
 }
 return [...unique.values()];
}
