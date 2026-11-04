import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {browserCandidate} from './browser.mjs';

const stamp=()=>new Date().toISOString();
const csv=rows=>{
  if(!rows.length)return '';
  const keys=Object.keys(rows[0]),quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';
  return '\ufeff'+[keys,...rows.map(row=>keys.map(k=>row[k]))].map(row=>row.map(quote).join(',')).join('\n')+'\n';
};
const route=url=>{const u=new URL(url);return u.origin==='null'?u.protocol+u.pathname:u.origin+u.pathname;};
const matches=(node,target)=>Object.entries(target).every(([key,value])=>node[key]===value);

/** Reusable in-process orchestration. Every input still gets its own fresh Jev decision. */
export class BrowserWorkflow {
  constructor(session,{goalId,outputDirectory,onRecord}={}){
    if(!goalId||!outputDirectory)throw Error('WORKFLOW_CONFIGURATION_REQUIRED');
    this.session=session;this.goalId=goalId;this.outputDirectory=outputDirectory;this.onRecord=onRecord;
    this.startedAt=stamp();this.actions=[];this.requests=[];
    mkdirSync(outputDirectory,{recursive:true,mode:0o700});
    session.adapter.enableDownloads(join(outputDirectory,'downloads'));
    const runtime=session.jev;
    session.jev={...runtime,choose:async(args,options)=>{
      const t=performance.now(),start=stamp();let result,error;
      try{result=await runtime.choose(args,options);return result;}catch(e){error=e.message;throw e;}
      finally{
        const row={id:args.idempotency_key,start,end:stamp(),elapsed_ms:Math.round((performance.now()-t)*1000)/1000,task:args.task,state:args.state,actions:args.actions,...(result?{result}:{}),...(error?{error}:{}),endpoint:runtime.deployment?.endpoint};
        this.requests.push(row);appendFileSync(join(outputDirectory,'requests.jsonl'),JSON.stringify(row)+'\n');
      }
    }};
  }
  get adapter(){return this.session.adapter;}
  observe(){return this.session.observe();}
  #record(row){
    row.sequence=this.actions.length+1;this.actions.push(row);
    appendFileSync(join(this.outputDirectory,'actions.jsonl'),JSON.stringify(row)+'\n');this.onRecord?.(row);return row;
  }
  /** Narrow default projection; callers may supply an explicit task-scoped project. */
  projection(spec,state){
    const target={...spec.target,...(spec.label!==undefined?{label:spec.label}:{}),...(spec.role?{role:spec.role}:{})};
    const relevant=Object.keys(target).length?state.elements.filter(e=>matches(e,target)):[];
    return {...(['navigate','newTab','back','forward','switchTab','scroll'].includes(spec.method)?{}:{title:state.title}),route:route(state.url),controls:relevant.map(({element_id:_id,href:_href,...e})=>e),
      ...(spec.method==='scroll'?{scroll:{x:state.scroll.x,y:state.scroll.y,viewport:state.scroll.viewport},regions:state.regions.map(r=>({id:r.id}))}:{}),
      ...(spec.method==='switchTab'?{target:state.tabs.filter(t=>t.id===spec.params?.tabId).map(t=>({route:route(t.url),active:t.active}))}:{})};
  }
  async run(spec){
    const {id,task=spec.description,description=task,method,params={},target={},label,role,verify,project,settleMs=4000,timeoutMs=30000}=spec;
    const start=stamp(),t=performance.now();let result,error,evidence;
    try{
      result=await this.session.step({goalId:this.goalId,idempotencyKey:id,task,intent:{method,target,...(label!==undefined?{label}:{}),...(role?{role}:{}),params},
        project:project??(state=>this.projection(spec,state)),candidates:state=>[browserCandidate(state,{id,description,method,target,label,role,params})],
        verify:async state=>{const passed=await verify(state);evidence={...this.projection(spec,state),url:state.url,verified:passed===true};return passed;},settleMs,timeoutMs});
    }catch(e){error=/^[A-Z][A-Z0-9_]*$/.test(e.message)?e.message:'WORKFLOW_ERROR';}
    const row=this.#record({id,kind:'input',task,method,start,end:stamp(),elapsed_ms:Math.round((performance.now()-t)*1000)/1000,status:result?.status??'FAILED',...(result?{result}:{}),...(evidence?{evidence}:{}),...(error?{error}:{})});
    if(row.status!=='VERIFIED'){
      // Persist a read-only snapshot, then stop. Never change a key or replay input.
      try{writeFileSync(join(this.outputDirectory,'stopped-state.json'),JSON.stringify(await this.observe(),null,2));}catch{}
      this.export();throw Error('WORKFLOW_STOPPED:'+id+':'+row.status+':'+(result?.code??error));
    }
    return row;
  }
  async read({id,task,operation,verify=()=>true,timeoutMs=0}){
    const start=stamp(),t=performance.now();let evidence,status='FAILED',error;
    try{
      const deadline=Date.now()+timeoutMs;
      do{evidence=await operation();if(await verify(evidence)){status='VERIFIED';break;}if(Date.now()>=deadline)break;await delay(100);}while(true);
    }catch(e){error=e.message;}
    this.#record({id,kind:'read-only',task,method:'independent-read',start,end:stamp(),elapsed_ms:Math.round((performance.now()-t)*1000)/1000,status,evidence,...(error?{error}:{})});
    if(status!=='VERIFIED'){this.export();throw Error('READ_CHECK_FAILED:'+id);}
    return evidence;
  }
  async scrollUntil({id,task,visible,target,delta=550,maxSteps=5}){
    await this.read({id:id+':layout',task:'Wait read-only for document, fonts and layout to settle before scrolling',operation:()=>this.adapter.waitForLayout(),verify:r=>r.settled});
    for(let i=0;i<maxSteps;i++){
      const state=await this.observe();if(visible(state))return state;
      const before=state.scroll.y;
      const offscreen=target?state.scroll_targets.find(node=>matches(node,target)):undefined;
      const direction=offscreen&&offscreen.bottom<=0?-Math.abs(delta):Math.abs(delta);
      await this.run({id:id+':'+i,task,method:'scroll',params:{delta:offscreen?direction:delta,region:'main'},verify:s=>s.scroll.y!==before||visible(s)});
    }
    const state=await this.observe();if(visible(state))return state;
    throw Error('TARGET_NOT_VISIBLE');
  }
  async decide(args){
    const result=await this.session.jev.choose(args);
    if(result.confidence<0.9)throw Error('LOW_CONFIDENCE_NO_INPUT');
    return result;
  }
  async screenshot(name){
    const directory=join(this.outputDirectory,'screenshots');mkdirSync(directory,{recursive:true,mode:0o700});
    return this.read({id:'screenshot:'+name,task:'Save terminal evidence screenshot',operation:async()=>{await this.adapter.screenshot(join(directory,name+'.png'));return {path:join(directory,name+'.png')};}});
  }
  export(){
    const write=(name,value)=>writeFileSync(join(this.outputDirectory,name),JSON.stringify(value,null,2));
    write('actions.json',this.actions);write('requests.json',this.requests);write('downloads.json',this.adapter.downloads);write('observation-diagnostics.json',this.adapter.diagnostics);
    writeFileSync(join(this.outputDirectory,'actions.csv'),csv(this.actions.map(a=>({sequence:a.sequence,id:a.id,kind:a.kind,task:a.task,method:a.method,start:a.start,end:a.end,elapsed_ms:a.elapsed_ms,status:a.status,cached:a.result?.cached??'',model_ms:a.result?.timings?.model_ms??'',execute_ms:a.result?.timings?.execute_ms??'',error:a.error??a.result?.code??''}))));
    writeFileSync(join(this.outputDirectory,'requests.csv'),csv(this.requests.map(q=>({id:q.id,start:q.start,end:q.end,elapsed_ms:q.elapsed_ms,model:q.result?.model,confidence:q.result?.confidence,input_tokens:q.result?.usage?.input_tokens,output_tokens:q.result?.usage?.output_tokens,error:q.error??''}))));
  }
  async close(){
    const browser=this.adapter.browser;
    try{await this.read({id:'cleanup',task:'Close owned Chrome and session',operation:async()=>{await this.session.close();return {browser_disconnected:!browser.isConnected()};},verify:x=>x.browser_disconnected});}
    finally{this.export();}
  }
}
