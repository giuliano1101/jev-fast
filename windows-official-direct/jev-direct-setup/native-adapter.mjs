import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {executePlan,httpBackend} from './executor-loop.mjs';
const root=resolve('desktop-executor');
export class NativeWorker{
 constructor(){
  this.sequence=0;this.pending=new Map();this.process=spawn(join(root,'.venv/Scripts/python.exe'),[join(root,'native_stdio.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  createInterface({input:this.process.stdout}).on('line',line=>{const d=JSON.parse(line),p=this.pending.get(d.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(d.id);if(d.error)p.reject(Error(d.error));else p.resolve(d.result);});
  this.process.on('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('NATIVE_WORKER_EXITED_UNKNOWN'));}this.pending.clear();});
 }
 call(input){return new Promise((resolve,reject)=>{const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('NATIVE_OUTCOME_UNKNOWN'));},35000);this.pending.set(id,{resolve,reject,timer});this.process.stdin.write(JSON.stringify({...input,id})+'\n');});}
 close(){this.process.stdin.end();}
}
export function nativeAdapter(worker,{windowId,artifactDir}){
 let snapshot;
 return {
  async observe(step){
   snapshot=await worker.call({op:'observe'});
   const required=step.action==='fill'?'TYPE_TEXT':'CLICK';
   const candidates=snapshot.elements.filter(e=>step.controls.some(c=>c.name===e.name&&(!c.role||e.role===c.role))&&e.enabled&&e.visible&&e.operations.includes(required)).map((e,i)=>({id:'control_'+i,name:e.name,role:e.role,action:step.action,binding:{element_id:e.element_id,window_ref:e.window_ref}}));
   return {surface:{kind:'desktop',id:windowId},candidates};
  },
  async guard(c){return snapshot.elements.some(e=>e.element_id===c.binding.element_id&&e.visible&&e.enabled);},
  async act(c,step){
   if(c.action==='fill')return worker.call({op:'fill_submit',snapshot,element_id:c.binding.element_id,text:step.text,submit:step.submit});
   return worker.call({op:'click',snapshot,element_id:c.binding.element_id});
  },
  async verify(step){
   const start=performance.now();let current;
   do{current=await worker.call({op:'observe'});
    if(step.verify.focused){const found=current.elements.find(e=>e.focused&&e.name===step.verify.focused);return {ok:!!found,evidence:{focused_control:found?.name??null}};}
    const matches=current.elements.filter(e=>!e.editable&&['hyperlink','heading','text'].includes(e.role)&&e.name.includes(step.verify.result));
    if(matches.some(e=>e.role==='hyperlink'||e.role==='heading')){
     const path=join(artifactDir,step.id+'.png');await worker.call({op:'screenshot',path});
     return {ok:true,evidence:{result:step.verify.result,matching_labels:matches.slice(0,3).map(e=>e.name),screenshot:path}};
    }
   }while(performance.now()-start<12000);
   return {ok:false,evidence:{expected:step.verify.result,reason:'No game result outside input field'}};
  }
 };
}
if(process.argv[1]?.endsWith('native-adapter.mjs')){
 const base=resolve(process.argv[2]),plan=JSON.parse(await readFile(process.argv[3],'utf8')),worker=new NativeWorker();
 try{
  const bound=await worker.call({op:'bind',title:plan.window_title});const {address}=JSON.parse(await readFile(join(base,'executor-service.json'),'utf8'));
  const result=await executePlan(nativeAdapter(worker,{windowId:bound.windows[0].window_ref,artifactDir:join(base,'steam-screenshots')}),httpBackend(address),plan);
  await writeFile(join(base,'desktop-'+plan.steps[0].id+'-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{worker.close();}
}
