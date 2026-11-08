import {join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {FileExecutionJournal} from './dist/bench/hybrid/execution-journal.js';
import {preparePrivateDirectory} from './dist/src/service/private-directory.js';
import {canonicalJson} from './dist/src/remote/protocol.js';
import {openStepsDatabase, isDesktopPreDispatchRejection} from './recovery.mjs';
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const safeCode = error => /^[A-Z][A-Z0-9_]*$/.test(error?.message ?? '') ? error.message : 'EXECUTION_FAILED';
function within(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error('STEP_DEADLINE'));
    signal.addEventListener('abort', abort, {once:true});
    Promise.resolve().then(() => {if(signal.aborted) throw Error('STEP_DEADLINE'); return operation();}).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if(signal.aborted) abort();
  });
}
/** Persistent host-side observe/choose/rebind/execute/verify. Model output is only an ID. */
export class JevSession {
  #db; #journal; #tail = Promise.resolve(); #closed = false;
  static async open({adapter, jev, directory}) {
    const root = preparePrivateDirectory(directory);
    const journal = await FileExecutionJournal.open(join(root, 'physical'));
    try { return new JevSession(adapter, jev, journal, openStepsDatabase(root)); }
    catch(error) {await journal.close(); throw error;}
  }
  constructor(adapter, jev, journal, db) {this.adapter=adapter; this.jev=jev; this.#journal=journal; this.#db=db;}
  observe() {if(this.#closed) throw Error('SESSION_CLOSED'); return this.adapter.observe();}
  step(options) {
    if(this.#closed) return Promise.reject(Error('SESSION_CLOSED'));
    const work = this.#tail.then(() => this.#step(options));
    this.#tail = work.then(() => {}, () => {}); return work;
  }
  async #step({task, goalId, idempotencyKey, intent, project, candidates, verify, timeoutMs=20000, settleMs=1500, minConfidence=0.9, signal:parent}) {
    if(!task || !goalId || !idempotencyKey || intent === undefined || typeof project !== 'function' || typeof candidates !== 'function' || typeof verify !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>2147483647 || !Number.isSafeInteger(settleMs) || settleMs<0 || !Number.isFinite(minConfidence) || minConfidence<0 || minConfidence>1) throw Error('INVALID_STEP');
    const id=digest({goalId,idempotencyKey}), inputDigest=digest({task,goalId,intent,scope:this.adapter.scope()});
    const prior=this.#db.prepare('SELECT * FROM steps WHERE id=?').get(id);
    if(prior) {
      if(prior.digest!==inputDigest) throw Error('IDEMPOTENCY_CONFLICT');
      return prior.result ? {...JSON.parse(prior.result), cached:true} : {status:'UNKNOWN',code:'UNFINISHED_STEP',cached:true};
    }
    const leaseKey=this.adapter.kind==='native'?'physical-host':'isolated-browser';
    if(await this.#journal.getPending(leaseKey) || this.#db.prepare("SELECT id FROM steps WHERE status IN ('PLANNING','EXECUTING','UNKNOWN') LIMIT 1").get()) throw Error('SURFACE_QUARANTINED');
    this.#db.prepare("INSERT INTO steps(id,digest,status,result,phase) VALUES(?,?,'PLANNING',NULL,'planning')").run(id,inputDigest);
    const started=performance.now(), controller=new AbortController(), timer=setTimeout(()=>controller.abort(),timeoutMs);
    const signal=AbortSignal.any([controller.signal, ...(parent?[parent]:[])]);
    let result, event, dispatchStarted=false, inputAccepted=false, decision;
    const timings={};
    const measured=async(name,operation)=>{const t=performance.now();try{return await within(operation,signal);}finally{timings[name]=(timings[name]??0)+performance.now()-t;}};
    try {
      const observed=await measured('observe_ms',() => this.adapter.observe());
      const projection=project(observed), projectionDigest=digest(projection);
      const actions=candidates(observed);
      if(!Array.isArray(actions)||!actions.length||actions.length>255||actions.some(a=>!a.id||!a.description)||new Set(actions.map(a=>a.id)).size!==actions.length) throw Error('INVALID_CANDIDATES');
      const guards=new Map(actions.map(a=>[a.id,digest(this.adapter.guard(a,observed))]));
      const selectedAt=performance.now();
      decision=await measured('model_ms',() => this.jev.choose({idempotency_key:idempotencyKey,task,state:projection,actions:actions.map(a=>({id:a.id,description:a.description})),timeout_ms:Math.max(1,timeoutMs-Math.ceil(performance.now()-started))},{signal}));
      const decisionMs=performance.now()-selectedAt;
      if(!guards.has(decision.selected_id)||!Number.isFinite(decision.confidence)||decision.confidence<minConfidence||decision.confidence>1) result={status:'REJECTED',code:'DECISION_REJECTED'};
      else {
        if(this.adapter.prepare) await measured('prepare_ms',()=>this.adapter.prepare(actions.find(a=>a.id===decision.selected_id),observed));
        const fresh=await measured('rebind_ms',() => this.adapter.observe());
        const rebound=candidates(fresh).filter(a=>a.id===decision.selected_id);
        if(rebound.length!==1||rebound[0].description!==actions.find(a=>a.id===decision.selected_id).description||digest(project(fresh))!==projectionDigest||digest(this.adapter.guard(rebound[0],fresh))!==guards.get(decision.selected_id)) result={status:'STALE',code:'STATE_CHANGED'};
        else {
          const nextEvent={schemaVersion:1,eventId:randomUUID(),leaseKey,sessionId:randomUUID(),actionId:'step-'+id,observationId:fresh.observation_id,startedAt:Date.now()};
          this.#db.prepare('UPDATE steps SET phase=?,method=?,event_json=? WHERE id=?').run('armed',rebound[0].method??null,JSON.stringify(nextEvent),id);
          try { await this.#journal.begin(nextEvent); event=nextEvent; }
          catch(error) { if(safeCode(error)==='JOURNAL_WRITE_UNCERTAIN') event=nextEvent; throw error; }
          if(signal.aborted){await this.#journal.acknowledge(event,'rejected');event=undefined;throw Error('STEP_DEADLINE');}
          this.#db.prepare("UPDATE steps SET status='EXECUTING',phase='executing' WHERE id=?").run(id);
          dispatchStarted=true;
          const submitted=await measured('execute_ms',() => this.adapter.execute(rebound[0]));
          if(submitted?.input_submitted!==true) throw Error('INPUT_RESULT_UNKNOWN');
          const copyProof=submitted.copy_proof===undefined?undefined:{match:submitted.copy_proof.match,count:submitted.copy_proof.count};
          if(copyProof!==undefined && ((copyProof.match!==true && copyProof.match!==false) || !Number.isSafeInteger(copyProof.count) || copyProof.count<0)) throw Error('COPY_PROOF_INVALID');
          inputAccepted=true;
          await this.#journal.acknowledge(event,'executed');event=undefined;
          let verified=false;
          const settleDeadline=Date.now()+settleMs;
          do {
            const after=await measured('verify_observe_ms',() => this.adapter.observe());
            verified=await measured('verify_ms',() => verify(after,{decision}));
            if(verified===true||Date.now()>=settleDeadline)break;
            await delay(Math.min(100,Math.max(1,settleDeadline-Date.now())),undefined,{signal});
          }while(!signal.aborted);
          const copyOK=copyProof===undefined || copyProof.match===true;
          result={status:verified===true&&copyOK?'VERIFIED':'POSTCONDITION_FAILED',code:verified===true&&copyOK?'POSTCONDITION_VERIFIED':'POSTCONDITION_NOT_MET',...(copyProof?{copy_proof:copyProof}:{})};
        }
      }
      result.decision_ms=Math.round(decisionMs);
    }catch(error){
      const code=safeCode(error);
      if(event && !inputAccepted && isDesktopPreDispatchRejection(code)){
        try{await this.#journal.acknowledge(event,'rejected');event=undefined;result={status:'FAILED',code,dispatch:'not-executed'};}
        catch{result={status:'UNKNOWN',code,dispatch:'not-executed'};}
      }else result={status:dispatchStarted||event?'UNKNOWN':'FAILED',code};
    }
    clearTimeout(timer);
    const output={...result,goalId,idempotencyKey,elapsed_ms:Math.round(performance.now()-started),timings:Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,Math.round(v*1000)/1000])),...(decision?{decision}:{}),cached:false};
    this.#db.prepare('UPDATE steps SET status=?,result=? WHERE id=?').run(output.status,JSON.stringify(output),id);
    return output;
  }
  async close() {
    if(this.#closed) return; this.#closed=true; await this.#tail;
    await this.adapter.close(); this.jev.close(); await this.#journal.close(); this.#db.close();
  }
}
