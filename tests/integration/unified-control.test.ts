import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {chromiumExecutable} from '../../src/browser/executable.js';
import {startControlPanel,type ControlStatus} from '../../src/control/server.js';
import {startAdmissionConsole} from '../../src/network/admission-console.js';
import {AdmissionRegistry} from '../../src/network/admission.js';

test('one browser page controls actual admission API and local lifecycle without receiving relay operator capability',{timeout:30000},async()=>{
 const root=await mkdtemp('/tmp/jev-unified-actual-'),registry=new AdmissionRegistry(join(root,'registry'),null,30000);
 const device=registry.register('device','Operator Mac');registry.updateDeviceInstance(device.id,'11111111-1111-4111-8111-111111111111');registry.setEnabled(device.id,true);
 const ai=registry.register('ai','My actual AI');registry.setEnabled(ai.id,true);const owner=registry.get(ai.id).owner!;
 const admin=await startAdmissionConsole({registry,port:0});const token=new URL(admin.url).hash.slice(1),tokenFile=join(root,'admin-token'),config=join(root,'admission.json');
 await writeFile(tokenFile,token,{mode:0o600});await writeFile(config,JSON.stringify({url:new URL(admin.url).origin,tokenFile,publicMcpUrl:'https://example.invalid/mcp'}),{mode:0o600});
 let state:ControlStatus['state']='running',stops=0;
 const panel=await startControlPanel({runtime:join(root,'runtime'),port:0,admissionConfig:config,adapter:{status:async()=>({state,mode:'mock',decisionProvider:'mock',remoteReachable:null}),start:async()=>{state='running';},stop:async()=>{state='unavailable';stops++;}}});
 const browser=await chromium.launch({headless:true,executablePath:chromiumExecutable()});
 try{
  const page=await browser.newPage(),requests:string[]=[];page.on('request',request=>requests.push(JSON.stringify({url:request.url(),headers:request.headers(),body:request.postData()})));
  await page.goto(panel.url);const row=page.locator(`[data-connection-id="${ai.id}"]`);await row.waitFor();assert.equal(await page.locator('h1').innerText(),'Jev 控制台');assert.equal(registry.get(ai.id).enabled,true);
  await row.getByRole('switch').click();await page.waitForFunction(id=>document.querySelector(`[data-connection-id="${id}"]`)?.textContent?.includes('正在停止'),ai.id);
  assert.equal(registry.get(ai.id).enabled,false);assert.equal(registry.get(ai.id).state,'stopping');assert.deepEqual(registry.revocations(),[owner]);assert.equal(await row.getByRole('switch').isDisabled(),true);
  registry.ackRevocations([owner]);await page.waitForFunction(id=>!document.querySelector<HTMLButtonElement>(`[data-connection-id="${id}"] button`)?.disabled,ai.id);
  await page.getByRole('button',{name:'停止服务',exact:true}).click();await page.waitForFunction(()=>document.getElementById('status')?.textContent==='未连接');assert.equal(stops,1);
  await page.locator('#instructions > summary').click();assert.equal(await page.getByLabel('公共 MCP 地址').innerText(),'https://example.invalid/mcp');
  assert.ok(!(await page.content()).includes(token));assert.ok(requests.every(request=>!request.includes(token)),'relay operator token must remain on server');assert.equal(new URL(page.url()).origin,new URL(panel.url).origin);
 }finally{await browser.close();await panel.close();await admin.close();registry.close();await rm(root,{recursive:true,force:true});}
});
