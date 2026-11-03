import {NativeWorker} from './native-adapter.mjs';
import {writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const base=resolve(process.argv[2]),worker=new NativeWorker(),results=[];
try{
 for(const [name,expected] of [['steam-counterstrike','Counter-Strike 2'],['steam-doom','DOOM Eternal'],['steam-left4dead','Left 4 Dead 2']]){
  const start=performance.now(),lines=await worker.call({op:'ocr',path:join(base,'steam-screenshots',name+'.png')});const matched=lines.filter(x=>x.text.toLowerCase().includes(expected.toLowerCase()));results.push({name,expected,matched:matched.length,passed:matched.length>=2,ocr_ms:performance.now()-start});
 }
 await writeFile(join(base,'steam-ocr-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{worker.close();}
