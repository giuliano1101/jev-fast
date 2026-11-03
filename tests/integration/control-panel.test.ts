import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,access,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {startControlPanel} from '../../src/control/server.js';
import {executeBounded} from '../helpers/process.js';
import {runLifecycle} from '../helpers/lifecycle.js';
import {readCredential,ipcCall} from '../../src/service/ipc.js';
import {chromiumExecutable} from '../../src/browser/executable.js';
const run=async(args:string[])=>{const index=args.indexOf('--runtime');return runLifecycle(args[index+1]!,args[0]==='service'?args.slice(1):args);};
test('real browser starts mock, uses local coordinator library, preserves service on panel close, and stops via operator lifecycle',{timeout:60000},async()=>{
 const root=await mkdtemp('/tmp/jev-panel-'),runtime=join(root,'run');let panel=await startControlPanel({runtime,port:0});
 const browser=await chromium.launch({headless:true,executablePath:chromiumExecutable()});
 try{
  await assert.rejects(access(runtime));const page=await browser.newPage({viewport:{width:1100,height:1200}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(panel.url);await page.waitForFunction(()=>document.getElementById('status')?.textContent==='未连接');assert.equal(new URL(page.url()).hash,'');await assert.rejects(access(runtime));
  assert.equal(await page.locator('h1').innerText(),'Jev 控制台');await page.locator('#instructions > summary').click();assert.ok(await page.getByText('运行能力以实际服务检查为准',{exact:false}).count());
  assert.equal(await page.getByLabel('MCP 配置').count(),0);
  await page.getByRole('button',{name:'启动服务',exact:true}).click();await page.waitForFunction(()=>document.getElementById('status')?.textContent==='运行中');assert.match(await page.locator('#mode').innerText(),/mock/);assert.equal(await page.locator('#reachability').innerText(),'无需远程连接');
  const health=JSON.parse((await run(['service','health','--runtime',runtime,'--json'])).stdout);assert.equal(health.ready,true);assert.equal(health.provider,'mock');
  const credential=JSON.parse(await readFile(join(runtime,'client-a.json'),'utf8'));assert.ok(!await page.content().then(content=>content.includes(credential.token)));
  await page.reload();await page.waitForFunction(()=>document.getElementById('status')?.textContent==='运行中');assert.equal(await page.locator('#error').isVisible(),false);
  const client=await readCredential(join(runtime,'client-a.json'));
  const opened=await ipcCall(client,'jev.open_session',{fixture_id:'standard'}) as {session_id:string};assert.ok(opened.session_id);
  const status=await ipcCall(client,'jev.status',{session_id:opened.session_id}) as {busy:boolean};assert.equal(status.busy,false);
  await panel.close();assert.equal(JSON.parse((await run(['service','health','--runtime',runtime,'--json'])).stdout).ready,true);
  panel=await startControlPanel({runtime,port:0});await page.goto(panel.url);await page.waitForFunction(()=>document.getElementById('status')?.textContent==='运行中');await page.getByRole('button',{name:'停止服务',exact:true}).click();await page.waitForFunction(()=>document.getElementById('status')?.textContent==='未连接');
  await assert.rejects(access(join(runtime,'coordinator.sock')));await assert.rejects(access(join(runtime,'service.lock')));assert.notEqual((await run(['service','health','--runtime',runtime,'--json'])).code,0);assert.deepEqual(errors,[]);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile UI must fit viewport');
 }finally{await browser.close();await panel.close();await run(['service','stop','--runtime',runtime,'--json']);await rm(root,{recursive:true,force:true});}
});
test('browser reports invalid fixed private config inline without exposing its contents or switching to mock',{timeout:30000},async()=>{
 const root=await mkdtemp('/tmp/jev-panel-config-'),runtime=join(root,'run'),config=join(root,'config.json');await writeFile(config,JSON.stringify({mode:'invalid',secret:'NEVER_DISPLAY_ME'}),{mode:0o600});
 const panel=await startControlPanel({runtime,config,port:0});const browser=await chromium.launch({headless:true,executablePath:chromiumExecutable()});
 try{const page=await browser.newPage();await page.goto(panel.url);await page.waitForFunction(()=>document.getElementById('status')?.textContent==='未连接');await page.getByRole('button',{name:'启动服务',exact:true}).click();await page.locator('#error').waitFor({state:'visible'});assert.match(await page.locator('#error').innerText(),/服务配置无效/);assert.ok(!(await page.content()).includes('NEVER_DISPLAY_ME'));await assert.rejects(access(join(runtime,'coordinator.sock')));assert.notEqual(await page.locator('#status').innerText(),'运行中');}finally{await browser.close();await panel.close();await run(['service','stop','--runtime',runtime,'--json']);await rm(root,{recursive:true,force:true});}
});
test('explicit process entry prints local URL, supports help, rejects arbitrary options and leaves runtime untouched',{timeout:15000},async()=>{
 const root=await mkdtemp('/tmp/jev-panel-main-'),runtime=join(root,'missing'),main=resolve('dist/src/control/main.js');
 try{
  const help=await executeBounded(process.execPath,[main,'--help']);assert.equal(help.code,0);assert.match(help.stdout,/--open/);assert.match(help.stdout,/47831/);
  const invalid=await executeBounded(process.execPath,[main,'--host','0.0.0.0']);assert.equal(invalid.code,1);assert.equal(invalid.stdout,'');
  const child=spawn(process.execPath,[main,'--runtime',runtime,'--port','0'],{stdio:['ignore','pipe','pipe']});let stdout='';
  try{
   const url=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('panel did not become ready')),5000);child.stdout.on('data',data=>{stdout+=data;const match=stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#\w+/);if(match){clearTimeout(timer);resolve(match[0]);}});child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(new Error('panel exited before ready'));});});
   assert.equal((await fetch(new URL('/',url))).status,200);await assert.rejects(access(runtime));
  }finally{child.kill('SIGTERM');await new Promise<void>(resolve=>child.once('close',()=>resolve()));}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a panel with default profile reports mismatch and preserves an existing explicitly shared coordinator',{timeout:30000},async()=>{
 const root=await mkdtemp('/tmp/jev-panel-profile-'),runtime=join(root,'run');
 const started=await run(['service','start','--runtime',runtime,'--share-a-with-b','--json']);assert.equal(started.code,0,started.stdout);
 const panel=await startControlPanel({runtime,port:0});
 try{
  const origin=new URL(panel.url).origin,token=new URL(panel.url).hash.slice(1);
  const response=await fetch(origin+'/api/start',{method:'POST',headers:{origin,'x-jev-control-token':token}});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:{code:'SERVICE_PROFILE_MISMATCH'}});
  assert.equal(JSON.parse((await run(['service','health','--runtime',runtime,'--json'])).stdout).ready,true);
 }finally{await panel.close();await run(['service','stop','--runtime',runtime,'--json']);await rm(root,{recursive:true,force:true});}
});

test('browser distinguishes actual Jev, remote mock, and unknown remote provider without exposing model or identity',{timeout:20000},async()=>{
 const panel=await startControlPanel({runtime:'/tmp/jev-provider-ui-stub',port:0});const browser=await chromium.launch({headless:true,executablePath:chromiumExecutable()});
 try{
  const page=await browser.newPage();let decisionProvider='mock';
  await page.route('**/api/status',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'running',mode:'remote',decisionProvider,remoteReachable:true})}));
  await page.goto(panel.url);await page.waitForFunction(()=>document.getElementById('status')?.textContent==='运行中');assert.equal(await page.locator('#mode').innerText(),'remote · 网关模拟');
  for(const [provider,label] of [['jev','remote · Jev'],['unknown','remote · provider 未知']]){
   decisionProvider=provider!;await page.getByRole('button',{name:'刷新状态',exact:false}).click();await page.waitForFunction(expected=>document.getElementById('mode')?.textContent===expected,label);
  }
 }finally{await browser.close();await panel.close();}
});
