import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,type Route} from 'playwright';
import {startControlPanel} from '../../src/control/server.js';
import {chromiumExecutable} from '../../src/browser/executable.js';

type Connection={id:string;type:'ai'|'device';name:string;state:'enabled'|'pending'|'stopping'|'offline';enabled:boolean;generation:number;firstSeen:number;lastSeen:number};
const connection=(id:string,type:'ai'|'device',state:Connection['state'],name=id):Connection=>({id,type,name,state,enabled:state==='enabled',generation:1,firstSeen:Date.now(),lastSeen:Date.now()});
async function fixture(){
 const panel=await startControlPanel({runtime:'/tmp/jev-console-browser-test',port:0});
 const browser=await chromium.launch({headless:true,executablePath:chromiumExecutable()});
 const page=await browser.newPage({viewport:{width:1100,height:1000}});const pageErrors:string[]=[];page.on('pageerror',error=>pageErrors.push(error.message));
 const state={connections:[connection('ai-one','ai','enabled','Alpha AI'),connection('phone','device','enabled','工作手机'),connection('waiting','ai','pending','等待中的 AI'),connection('hostile','ai','enabled','<img src=x onerror="window.XSS=true">'),...Array.from({length:150},(_,i)=>connection('old-'+i,'ai','offline','历史 AI '+i))],failed:false,configured:true,requests:[] as {id:string;enabled:boolean}[],polls:0,hold:undefined as ((route:Route)=>Promise<void>)|undefined,failMutation:false,stops:0};
 await page.route('**/api/stop',route=>{state.stops++;return route.fulfill({status:200,contentType:'application/json',body:'{}'});});
 await page.route('**/api/status',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'running',mode:'remote',decisionProvider:'jev',remoteReachable:true})}));
 await page.route('**/api/connections',async route=>{state.polls++;if(state.hold)return state.hold(route);await route.fulfill({status:state.failed?503:200,contentType:'application/json',body:JSON.stringify(state.failed?{error:{code:'ADMISSION_UNAVAILABLE'}}:{configured:state.configured,connections:state.connections,publicMcpUrl:'https://example.invalid/mcp'})});});
 await page.route('**/api/admission',async route=>{const request=route.request().postDataJSON() as {id:string;enabled:boolean};state.requests.push(request);if(state.failMutation){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'ADMISSION_UNAVAILABLE'}})});return;}const selected=state.connections.find(row=>row.id===request.id)!;selected.state=request.enabled?'enabled':'stopping';selected.enabled=request.enabled;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({connection:selected})});});
 return {page,state,open:()=>page.goto(panel.url),close:async()=>{await browser.close();await panel.close();assert.deepEqual(pageErrors,[]);}};
}

test('one compact console controls the exact connection, safely renders names, and keeps history/filter state',{timeout:25000},async()=>{
 const f=await fixture();try{
  await f.open();assert.equal(await f.page.locator('h1').innerText(),'Jev 控制台');
  await f.page.locator('[data-connection-id="ai-one"]').waitFor();
  assert.equal(await f.page.locator('#connections-list > [data-connection-id]').count(),4);
  assert.equal(await f.page.locator('#history').getAttribute('open'),null);
  assert.match(await f.page.locator('#history summary').innerText(),/150/);
  assert.equal(await f.page.evaluate(()=>Boolean((window as unknown as {XSS?:boolean}).XSS)),false);
  assert.match(await f.page.locator('[data-connection-id="hostile"]').innerText(),/<img src=x/);
  assert.equal(await f.page.locator('[data-connection-id="hostile"] img').count(),0);
  await f.page.getByLabel('搜索连接').fill('Alpha');assert.equal(await f.page.locator('#connections-list > [data-connection-id]:visible').count(),1);
  await f.page.getByLabel('搜索连接').fill('');await f.page.getByLabel('连接类型').selectOption('device');assert.equal(await f.page.locator('#connections-list > [data-connection-id]:visible').count(),1);
  await f.page.getByLabel('连接类型').selectOption('all');await f.page.locator('[data-connection-id="ai-one"] button').click();
  await f.page.waitForFunction(()=>document.querySelector('[data-connection-id="ai-one"]')?.textContent?.includes('正在停止'));
  assert.deepEqual(f.state.requests,[{id:'ai-one',enabled:false}]);assert.equal(await f.page.locator('[data-connection-id="ai-one"] button').isDisabled(),true);
  await f.page.locator('#history summary').click();await f.page.getByLabel('搜索连接').fill('历史 AI 149');
  await f.page.waitForTimeout(2200);assert.equal(await f.page.locator('#history').getAttribute('open'),'');assert.equal(await f.page.getByLabel('搜索连接').inputValue(),'历史 AI 149');assert.equal(await f.page.locator('#history-list > [data-connection-id]:visible').count(),1);
  await f.page.setViewportSize({width:390,height:844});assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await f.page.locator('iframe').count(),0);assert.equal(await f.page.locator('#instructions').getAttribute('open'),null);
 }finally{await f.close();}
});

test('polling preserves focused row nodes and stale list replies cannot undo a pending stop',{timeout:20000},async()=>{
 const f=await fixture();try{
  await f.open();const button=f.page.locator('[data-connection-id="ai-one"] button');await button.waitFor();await button.focus();await button.evaluate(node=>node.setAttribute('data-retained','yes'));
  const initial=f.state.polls;await f.page.waitForFunction(()=>document.querySelector('[data-retained="yes"]')===document.activeElement);await f.page.waitForTimeout(2200);assert.ok(f.state.polls>initial);assert.equal(await button.getAttribute('data-retained'),'yes');assert.equal(await button.evaluate(node=>node===document.activeElement),true);
  const stale=JSON.stringify({configured:true,connections:structuredClone(f.state.connections)});let release:(()=>void)|undefined;let held=false;
  f.state.hold=async route=>{held=true;await new Promise<void>(resolve=>{release=resolve;});await route.fulfill({status:200,contentType:'application/json',body:stale});};
  await f.page.getByRole('button',{name:'刷新状态',exact:false}).click();await f.page.waitForTimeout(200);assert.equal(held,true);
  await button.click();await f.page.waitForFunction(()=>document.querySelector('[data-connection-id="ai-one"]')?.textContent?.includes('正在停止'));f.state.hold=undefined;release!();
  await f.page.waitForTimeout(200);assert.match(await f.page.locator('[data-connection-id="ai-one"]').innerText(),/正在停止/);
 }finally{await f.close();}
});

test('connection fetch and row mutation errors stay visible while service stop remains available',{timeout:15000},async()=>{
 const f=await fixture();try{
  await f.open();await f.page.locator('[data-connection-id="ai-one"]').waitFor();f.state.failMutation=true;await f.page.locator('[data-connection-id="ai-one"] button').click();await f.page.locator('[data-connection-id="ai-one"] [role="alert"]').waitFor();
  f.state.failed=true;await f.page.getByRole('button',{name:'刷新状态',exact:false}).click();await f.page.locator('#connections-error').waitFor({state:'visible'});assert.match(await f.page.locator('#connections-error').innerText(),/连接列表.*不可用/);assert.equal(await f.page.getByRole('button',{name:'停止服务',exact:true}).isEnabled(),true);assert.equal(await f.page.locator('[data-connection-id="ai-one"] [role="alert"]').isVisible(),true);
 }finally{await f.close();}
});


test('unconfigured installs offer collapsed setup and public connection instructions without requesting secrets',{timeout:15000},async()=>{
 const f=await fixture();try{
  f.state.configured=false;f.state.connections=[];await f.open();await f.page.locator('#advanced').waitFor({state:'visible'});
  assert.equal(await f.page.locator('#advanced').getAttribute('open'),null);assert.equal(await f.page.locator('#instructions').getAttribute('open'),null);assert.match(await f.page.locator('#connections-empty').innerText(),/暂未启用/);
  await f.page.locator('#instructions summary').click();assert.equal(await f.page.getByLabel('公共 MCP 地址',{exact:true}).innerText(),'https://example.invalid/mcp');assert.ok(JSON.parse(await f.page.getByLabel('MCP 配置',{exact:true}).innerText()).mcpServers.jev);assert.match(await f.page.getByLabel('CLI 命令',{exact:true}).innerText(),/doctor/);
 }finally{await f.close();}
});

test('slow list and status reads do not block the general service stop control',{timeout:15000},async()=>{
 const f=await fixture();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});try{
  await f.open();await f.page.locator('[data-connection-id="ai-one"]').waitFor();
  f.state.hold=async route=>{await gate;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:true,connections:f.state.connections})});};
  await f.page.route('**/api/status',async route=>{await gate;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'running',mode:'mock'})});});
  await f.page.getByRole('button',{name:'刷新状态',exact:false}).click();await f.page.getByRole('button',{name:'停止服务',exact:true}).click();await f.page.waitForFunction(()=>document.getElementById('activity')?.textContent?.includes('停止命令已完成'));
  assert.equal(f.state.stops,1);assert.equal(await f.page.getByRole('button',{name:'停止服务',exact:true}).isEnabled(),true);
 }finally{release();await f.close();}
});

test('successful service lifecycle fences a list read started before stop',{timeout:15000},async()=>{
 const f=await fixture();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let held=false;try{
  await f.open();await f.page.locator('[data-connection-id="ai-one"]').waitFor();
  const stale=structuredClone(f.state.connections);stale.find(row=>row.id==='ai-one')!.name='OBSOLETE BEFORE STOP';
  f.state.hold=async route=>{held=true;await gate;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({configured:true,connections:stale})});};
  await f.page.getByRole('button',{name:'刷新状态',exact:false}).click();await f.page.waitForTimeout(100);assert.equal(held,true);
  await f.page.getByRole('button',{name:'停止服务',exact:true}).click();await f.page.waitForFunction(()=>document.getElementById('activity')?.textContent?.includes('停止命令已完成'));
  f.state.hold=undefined;release();await f.page.waitForTimeout(200);
  assert.match(await f.page.locator('[data-connection-id="ai-one"]').innerText(),/Alpha AI/);
  assert.doesNotMatch(await f.page.locator('[data-connection-id="ai-one"]').innerText(),/OBSOLETE BEFORE STOP/);
 }finally{release();await f.close();}
});

test('obsolete list failure cannot report a fresh error after a successful connection mutation',{timeout:15000},async()=>{
 const f=await fixture();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let held=false;try{
  await f.open();await f.page.locator('[data-connection-id="ai-one"]').waitFor();
  f.state.hold=async route=>{held=true;await gate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'CONTROL_ADMISSION_UNAVAILABLE'}})});};
  await f.page.getByRole('button',{name:'刷新状态',exact:false}).click();await f.page.waitForTimeout(100);assert.equal(held,true);
  await f.page.locator('[data-connection-id="ai-one"] button').click();await f.page.waitForFunction(()=>document.querySelector('[data-connection-id="ai-one"]')?.textContent?.includes('正在停止'));
  f.state.hold=undefined;release();await f.page.waitForTimeout(200);
  assert.equal(await f.page.locator('#connections-error').isVisible(),false);
  assert.match(await f.page.locator('[data-connection-id="ai-one"]').innerText(),/正在停止/);
 }finally{release();await f.close();}
});
