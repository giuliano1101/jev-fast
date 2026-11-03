import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {decide,begin,finish} from './ui-route.mjs';
import {createJevClient} from 'file:///C:/Users/Admin/.codex/jev-direct/client.mjs';
import {executePlan} from './executor-loop.mjs';
import {playwrightAdapter} from './playwright-adapter.mjs';
import {askOfficial} from './official-request.mjs';
import {chromium} from '../jev-fast/node_modules/playwright/index.mjs';
const run=resolve(process.argv[2]??'test-results/ui-route-20261104/run.json'),base=dirname(run),nonce=randomBytes(24).toString('hex');
let client,context,currentPage,queue=Promise.resolve();
const decisionBackend={decide:input=>decide(run,input,{clientFactory:()=>client??=createJevClient()}),begin:(id,current)=>begin(run,id,current),finish:(id,result)=>finish(run,id,result)};
const server=http.createServer((req,res)=>{
 const work=async()=>{try{
  const parts=req.url.split('/');if(parts[1]!==nonce||req.method!=='POST'||req.headers.origin){res.writeHead(403);return res.end();}
  let body='';for await(const c of req){body+=c;if(body.length>200000)throw Error('BODY_TOO_LARGE');}const data=JSON.parse(body);let result;
  if(parts[2]==='status')result={status:'ready',run,pid:process.pid,mcp:false};
  else if(parts[2]==='systemone')result=await askOfficial(run,data,client??=createJevClient());
  else if(parts[2]==='decide')result=await decisionBackend.decide(data);
  else if(parts[2]==='begin')result=await decisionBackend.begin(data.operation_id,data.current);
  else if(parts[2]==='finish')result=await decisionBackend.finish(data.operation_id,data.result);
  else if(parts[2]==='inspect'){
   if(!currentPage)throw Error('NO_OWNED_PAGE');
   result={url:currentPage.url(),snapshot:await currentPage.locator('body').ariaSnapshot()};
  } else if(parts[2]==='chrome'){
   if(!data.continue&&!['https://www.google.com/','https://www.google.com'].includes(data.start_url))throw Error('TASK_START_URL_NOT_ALLOWED');
   context??=await chromium.launchPersistentContext(join(base,'chrome-profile'),{channel:'chrome',headless:false,proxy:{server:'http://127.0.0.1:7897'},acceptDownloads:true,viewport:{width:1440,height:1000}});
   const started=performance.now();if(!data.continue){currentPage=await context.newPage();await currentPage.goto(data.start_url,{waitUntil:'domcontentloaded'});}const page=currentPage;if(!page)throw Error('NO_OWNED_PAGE');
   result=await executePlan(playwrightAdapter(page,{artifactDir:join(base,'chrome-downloads')}),decisionBackend,data.plan);
   result.including_navigation_ms=performance.now()-started;result.url=page.url();result.snapshot=await page.locator('body').ariaSnapshot();await page.screenshot({path:join(base,'chrome-current.png')});
   await writeFile(join(base,'chrome-'+data.plan.id+'.json'),JSON.stringify(result,null,2));
  } else throw Error('UNSUPPORTED_ENDPOINT');
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));
 }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(e.message).slice(0,300)}));}};
 queue=queue.then(work,work);
});
await mkdir(base,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const ipc=join(base,'ipc-'+nonce);await mkdir(ipc,{recursive:true});const claimed=new Set();
const timer=setInterval(async()=>{for(const name of await readdir(ipc)){
 if(!name.endsWith('.request.json')||claimed.has(name))continue;claimed.add(name);
 queue=queue.then(async()=>{const target=join(ipc,name.replace('.request.json','.response.json'));try{
  const {action,data}=JSON.parse(await readFile(join(ipc,name),'utf8'));let result;
  if(action==='decide')result=await decisionBackend.decide(data);
  else if(action==='begin')result=await decisionBackend.begin(data.operation_id,data.current);
  else if(action==='finish')result=await decisionBackend.finish(data.operation_id,data.result);
  else throw Error('INVALID_IPC_ACTION');await writeFile(target,JSON.stringify(result));
 }catch(e){await writeFile(target,JSON.stringify({error:e.message}));}});
}},40);
await writeFile(join(base,'executor-service.json'),JSON.stringify({address:`http://127.0.0.1:${server.address().port}/${nonce}`,ipc,pid:process.pid,run}));
const stop=async()=>{clearInterval(timer);server.close();await context?.close();};process.on('SIGTERM',stop);setTimeout(stop,3600000).unref();
