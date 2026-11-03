import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fetch as proxyFetch,ProxyAgent} from 'file:///C:/Users/Admin/.codex/jev-direct/node_modules/undici/index.js';
import {executePlan,httpBackend} from './executor-loop.mjs';
const base=resolve(process.argv[2]),input=join(base,'iab-observed-image-sources.json'),photos=JSON.parse(await readFile(input,'utf8')),stamp=(await stat(input)).mtimeMs,agent=new ProxyAgent('http://127.0.0.1:7897');
const controls=photos.map((p,i)=>({id:'observed_photo_'+i,name:p.name,role:'img',action:'download',binding:{source:p.src}}));
const adapter={
 observe:async()=>{if(Date.now()-stamp>180000)throw Error('SOURCE_OBSERVATION_EXPIRED');return {surface:{kind:'iab',id:'2-observed-assets'},candidates:controls};},
 guard:async c=>{const u=new URL(c.binding.source);return u.protocol==='https:'&&u.hostname==='encrypted-tbn0.gstatic.com'&&u.pathname==='/images';},
 act:async(c,step)=>{const r=await proxyFetch(c.binding.source,{dispatcher:agent,redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok||!r.headers.get('content-type')?.startsWith('image/'))throw Error('NOT_IMAGE');const bytes=Buffer.from(await r.arrayBuffer()),path=join(base,'iab-downloads',step.id+'.jpg');await mkdir(join(base,'iab-downloads'),{recursive:true});await writeFile(path,bytes);return {path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};},
 verify:async(s,c,a)=>({ok:a.bytes>300,evidence:{saved:a.path,sha256:a.sha256,mechanism:'Codex recovery: save media source observed through IAB DOM; native downloadMedia timed out'}})
};
const {address}=JSON.parse(await readFile(join(base,'executor-service.json'),'utf8'));
const result=await executePlan(adapter,httpBackend(address),{steps:photos.map((p,i)=>({id:'iab-asset-'+(i+1),target:'Download the observed photograph named: '+p.name}))});
await writeFile(join(base,'iab-asset-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));await agent.close();
