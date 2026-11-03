import {readFile} from 'node:fs/promises';
const [runDir,command,path]=process.argv.slice(2),{address}=JSON.parse(await readFile(runDir+'/executor-service.json','utf8'));
const data=path?JSON.parse(await readFile(path,'utf8')):{};
const response=await fetch(address+'/'+command,{method:'POST',body:JSON.stringify(data),headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(180000)});
console.log(JSON.stringify(await response.json()));
