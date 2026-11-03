// Runtime-neutral: the same local loop works with CUA and Playwright adapters.
export async function executePlan(adapter, backend, plan) {
 const started=performance.now(), trace=[];
 for (const step of plan.steps) {
  const tick=performance.now();
  let observation=await adapter.observe(step), decision;
  const observed=performance.now();
  if(observation.blocked)return {status:'handoff',reason:observation.blocked,trace,elapsed_ms:performance.now()-started};
  try { decision=await backend.decide({operation_id:step.id,observed_at:new Date().toISOString(),surface:observation.surface,target_description:step.target,candidates:observation.candidates}); }
  catch {return {status:'handoff',reason:'decision_transport_unknown',trace,elapsed_ms:performance.now()-started};}
  if(decision.route!=='jev'||decision.status!=='ready')return {status:'handoff',reason:decision.reason??decision.status,trace,elapsed_ms:performance.now()-started};
  const selected=decision.selected;
  // Check the selected live locator and URL, without taking another whole-page snapshot.
  if(!await adapter.guard(selected,observation))return {status:'handoff',reason:'target_changed',trace,elapsed_ms:performance.now()-started};
  await backend.begin(step.id,{operation_id:step.id,observed_at:new Date().toISOString(),surface:observation.surface,candidates:observation.candidates});
  let outcome='unknown', evidence, artifact, actionMs;
  try {
   const actionStart=performance.now();
   artifact=await adapter.act(selected,step);
   actionMs=performance.now()-actionStart;
   const verified=await adapter.verify(step,selected,artifact);
   outcome=verified.ok?'verified':'failed';evidence=verified.evidence;
  } catch(e) { evidence={error:String(e.message).slice(0,300),instruction:'Inspect state before any retry; input may already have happened.'}; }
  await backend.finish(step.id,{outcome,evidence,artifact});
  trace.push({id:step.id,outcome,selected:selected.name,observation_ms:observed-tick,jev_ms:decision.decision_ms,action_ms:actionMs,total_ms:performance.now()-tick,artifact});
  if(outcome!=='verified')return {status:'handoff',reason:outcome,trace,elapsed_ms:performance.now()-started};
 }
 return {status:'verified',trace,elapsed_ms:performance.now()-started};
}

export function httpBackend(address) {
 const call=async(action,data)=>{
  const response=await fetch(address+'/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(35000)});
  const result=await response.json();if(!response.ok)throw Error(result.error??'BACKEND_ERROR');return result;
 };
 return {decide:input=>call('decide',input),begin:(operation_id,current)=>call('begin',{operation_id,current}),finish:(operation_id,result)=>call('finish',{operation_id,result})};
}
