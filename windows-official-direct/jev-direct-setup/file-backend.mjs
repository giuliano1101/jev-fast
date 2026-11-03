import {writeFile,readFile,rename} from 'node:fs/promises';
export function fileBackend(directory){
 let sequence=0;const session=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
 const call=async(action,data)=>{
  const id=session+'-'+sequence++,path=directory+'/'+id;
  await writeFile(path+'.pending',JSON.stringify({action,data}),{flag:'wx'});
  await rename(path+'.pending',path+'.request.json');
  const start=Date.now();
  while(Date.now()-start<35000){try{const r=JSON.parse(await readFile(path+'.response.json','utf8'));if(r.error)throw Error(r.error);return r;}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}await new Promise(r=>setTimeout(r,40));}
  throw Error('DECISION_OUTCOME_UNKNOWN');
 };
 return {decide:input=>call('decide',input),begin:(operation_id,current)=>call('begin',{operation_id,current}),finish:(operation_id,result)=>call('finish',{operation_id,result})};
}
