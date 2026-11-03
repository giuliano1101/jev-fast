import {readFile,open,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
const workspace='G:/Codex/Jev control',node=process.execPath,python=join(workspace,'desktop-executor/.venv/Scripts/python.exe');
const [command,arg,plan]=process.argv.slice(2);
if(command==='status'){
 console.log(JSON.stringify({official_api:true,model:'jev-latest',mcp:false,chrome_executor:existsSync(join(workspace,'jev-direct-setup/executor-service.mjs')),desktop_executor:existsSync(python),iab_adapter:true,default_decision:'jev',fallback:'codex',supported_desktop_actions:['click','fill_and_submit'],ocr:'local read-only assistance',vision:'official API target proposal; automatic coordinate clicks not activated',budget:'explicit task authorization required'},null,2));
}else if(command==='start'){
 const run=resolve(arg),base=dirname(run),r=JSON.parse(await readFile(run,'utf8'));if(r.authorization?.status!=='approved'||Date.now()>=Date.parse(r.authorization.expires_at))throw Error('TASK_PAID_AUTHORIZATION_UNAVAILABLE');
 await mkdir(base,{recursive:true});
 let gatewayReady=false;try{const {address}=JSON.parse(await readFile(join(base,'executor-service.json'),'utf8'));const response=await fetch(address+'/status',{method:'POST',body:'{}',signal:AbortSignal.timeout(1500)});const result=await response.json();gatewayReady=result.status==='ready'&&resolve(result.run)===run;}catch{}
 const env={...process.env,PYTHONPATH:join(workspace,'desktop-executor/src')};
 const probe=spawnSync(python,['-m','jev_desktop.transports.cli','--pipe','\\\\.\\pipe\\JevOfficialWindowsBroker','--no-autostart','--timeout','2','status'],{env,cwd:workspace,windowsHide:true,encoding:'utf8',timeout:4000});
 const brokerReady=probe.status===0&&!!JSON.parse(probe.stdout||'{}').broker;
 for(const [name,exe,args,ready]of [['gateway',node,[join(workspace,'jev-direct-setup/executor-service.mjs'),run],gatewayReady],['broker',python,[join(workspace,'desktop-executor/windows_broker.py'),base],brokerReady]]){
  if(ready)continue;
  const log=await open(join(base,name+'-startup.log'),'a');const child=spawn(exe,args,{cwd:workspace,windowsHide:true,detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();await log.close();
 }
 console.log(JSON.stringify({status:'starting',run,configuration:join(base,'executor-service.json')}));
}else if(['desktop','chrome'].includes(command)){
 const script=command==='desktop'?'native-adapter.mjs':'executorctl.mjs',args=command==='desktop'?[resolve(arg),resolve(plan)]:[resolve(arg),'chrome',resolve(plan)];
 const child=spawnSync(node,[join(workspace,'jev-direct-setup',script),...args],{cwd:workspace,windowsHide:true,stdio:'inherit'});process.exitCode=child.status??1;
}else throw Error('Usage: ui.mjs status | start RUN.json | desktop RUN_DIR PLAN.json | chrome RUN_DIR PLAN.json');
