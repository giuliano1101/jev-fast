import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod,lstat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('supervisor starts fixed configured dead jobs once, leaves live jobs alone, and respects persisted off',async()=>{
 const {Supervisor}=await import('../../src/service/supervisor.js');const root=await mkdtemp(join(tmpdir(),'jev-watch-')),runtime=join(root,'run'),config=join(root,'watch.json');
 const fixture=join(root,'fixture.cjs'),calls=join(root,'calls');await writeFile(fixture,`require('fs').appendFileSync(${JSON.stringify(calls)},'start\\n');setInterval(()=>{},1000);`);
 await writeFile(config,JSON.stringify({version:1,runtime,coordinator:{node:process.execPath,cli:fixture},jobs:[{id:'panel',command:process.execPath,args:[fixture],cwd:root}]}),{mode:0o600});
 let pid:number|undefined;
 try{
  const supervisor=await Supervisor.fromFile(config);await supervisor.tick();pid=JSON.parse(await readFile(join(runtime,'watchdog-panel.json'),'utf8')).pid;
  await supervisor.tick();assert.equal(JSON.parse(await readFile(join(runtime,'watchdog-panel.json'),'utf8')).pid,pid);
  process.kill(pid!,'SIGKILL');for(let i=0;i<100;i++){try{process.kill(pid!,0);}catch{break;}await new Promise(resolve=>setTimeout(resolve,10));}
  await supervisor.tick();const next=JSON.parse(await readFile(join(runtime,'watchdog-panel.json'),'utf8')).pid;assert.notEqual(next,pid);pid=next;
  await writeFile(config,JSON.stringify({version:1,runtime,coordinator:{node:process.execPath,cli:fixture},jobs:[{id:'connector',command:process.execPath,args:[fixture],cwd:root}]}),{mode:0o600});
  const off=await Supervisor.fromFile(config);assert.deepEqual(await off.tick(),[{id:'coordinator',state:'stopped'},{id:'connector',state:'stopped'}]);
  await chmod(config,0o644);await assert.rejects(Supervisor.fromFile(config),/UNSAFE_PRIVATE_FILE/);
 }finally{if(pid)try{process.kill(pid,'SIGKILL');}catch{/* exited */}await rm(root,{recursive:true,force:true});}
});
const recoveryPath='../../src/service/recovery.js';
test('lock recovery removes only proven-dead private owner markers and preserves audit database',async()=>{
 const {removeDeadMarker}=await import(recoveryPath);const root=await mkdtemp(join(tmpdir(),'jev-dead-'));await chmod(root,0o700);
 try{
  await writeFile(join(root,'owner.lock'),JSON.stringify({pid:999999999}),{mode:0o600});await writeFile(join(root,'network.sqlite'),'KEEP',{mode:0o600});
  assert.equal(await removeDeadMarker(root,'owner.lock'),true);assert.equal(await readFile(join(root,'network.sqlite'),'utf8'),'KEEP');assert.equal(await removeDeadMarker(root,'owner.lock'),false);
  await assert.rejects(removeDeadMarker(root,'network.sqlite'),/UNSAFE_RECOVERY_PATH/);
  await writeFile(join(root,'owner.lock'),JSON.stringify({pid:process.pid}),{mode:0o600});await assert.rejects(removeDeadMarker(root,'owner.lock'),/RECOVERY_OWNER_ALIVE/);await rm(join(root,'owner.lock'));
  await symlink(join(root,'network.sqlite'),join(root,'owner.lock'));await assert.rejects(removeDeadMarker(root,'owner.lock'),/UNSAFE_RECOVERY_PATH/);assert.equal((await lstat(join(root,'owner.lock'))).isSymbolicLink(),true);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('explicit dead Audit lock recovery preserves durable records on reopen',async()=>{
 const {removeDeadMarker}=await import(recoveryPath);const {Audit}=await import('../../src/network/store.js');const {z}=await import('zod');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const root=await mkdtemp(join(tmpdir(),'jev-audit-recover-'));await chmod(root,0o700);
 const moduleURL=new URL('../../src/network/store.js',import.meta.url).href;
 try{
  await promisify(execFile)(process.execPath,['--input-type=module','-e',`import {Audit} from ${JSON.stringify(moduleURL)};import {z} from 'zod';const audit=new Audit(${JSON.stringify(root)},{kind:'test'},z.strictObject({request_id:z.string(),value:z.string()}));audit.put('kept',{request_id:'kept',value:'UNKNOWN'});process.exit(0);`]);
  await removeDeadMarker(root,'owner.lock');const audit=new Audit(root,{kind:'test'},z.strictObject({request_id:z.string(),value:z.string()}));try{assert.deepEqual(audit.get('kept'),{request_id:'kept',value:'UNKNOWN'});}finally{audit.close();}
 }finally{await rm(root,{recursive:true,force:true});}
});
test('gateway restarts before coordinator probe so a lost model gateway cannot deadlock recovery',async()=>{
 const {Supervisor}=await import('../../src/service/supervisor.js');const root=await mkdtemp(join(tmpdir(),'jev-dependency-')),runtime=join(root,'run'),config=join(root,'watch.json'),fixture=join(root,'dependency.cjs');const pids:number[]=[];
 const {mkdir}=await import('node:fs/promises');await mkdir(runtime,{mode:0o700});await writeFile(join(runtime,'service-intent.json'),JSON.stringify({version:1,desired:'running',selection:{configFile:null,shared:false,fingerprint:'mock'}}),{mode:0o600});
 await writeFile(fixture,`if(process.argv[2]==='service'){let ready=false;try{const marker=require('fs').readFileSync(${JSON.stringify(join(runtime,'watchdog-gateway.json'))},'utf8');process.kill(JSON.parse(marker).pid,0);ready=true;}catch{}console.log(JSON.stringify({ready}));}else setInterval(()=>{},1000);`);
 await writeFile(config,JSON.stringify({version:1,runtime,coordinator:{node:process.execPath,cli:fixture},jobs:[{id:'gateway',command:process.execPath,args:[fixture,'daemon'],cwd:root},{id:'connector',command:process.execPath,args:[fixture,'daemon'],cwd:root}]}),{mode:0o600});
 try{const supervisor=await Supervisor.fromFile(config);const result=await supervisor.tick();for(const id of ['gateway','connector'])try{pids.push(JSON.parse(await readFile(join(runtime,`watchdog-${id}.json`),'utf8')).pid);}catch{/* missing is asserted below */}assert.equal(result.find(row=>row.id==='coordinator')?.state,'running');assert.equal(result.find(row=>row.id==='gateway')?.state,'started');assert.equal(result.find(row=>row.id==='connector')?.state,'started');}
 finally{for(const pid of pids)try{process.kill(pid,'SIGKILL');}catch{/* exited */}await rm(root,{recursive:true,force:true});}
});
