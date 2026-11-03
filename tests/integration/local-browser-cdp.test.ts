import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {signChoiceResponse} from '../../src/remote/choice.js';
import {LocalBrowserService} from '../../src/local/service.js';
import {localBackendConfig} from '../../src/local/config.js';
/** The fixture owns this browser. Headless is explicit for CI; the product launch default is separately asserted headed. */
test('local browser library attaches to existing local tab, types via Jev stub, and leaves borrowed browser alive',{timeout:40000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'jev-local-cdp-')),profile=join(directory,'fixture-browser'),keys=generateKeyPairSync('ed25519');
 const server=createServer((_request,response)=>response.setHeader('content-type','text/html').end('<title>Local fixture</title><label>Local note <input id="note"></label>'));
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 let choiceRequests=0;
 let service:LocalBrowserService|undefined;let fixtureContext:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined;
 try{
  fixtureContext=await chromium.launchPersistentContext(profile,{headless:true,args:['--remote-debugging-port=0'],...(process.env.JEV_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.JEV_TEST_BROWSER_EXECUTABLE}:{})});
  const fixtureBrowser=fixtureContext.browser();assert.ok(fixtureBrowser);
  let port:string|undefined;for(let attempts=0;attempts<200&&!port;attempts++){try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];}catch{await sleep(50);}}
  assert.ok(port,'fixture browser must provide actual local CDP endpoint');const endpoint=`http://127.0.0.1:${port}`;
  const page=fixtureContext.pages()[0]!;await page.goto(`http://127.0.0.1:${address.port}`);
  service=new LocalBrowserService({stateDir:join(directory,'state'),backend:localBackendConfig({mode:'attach',browser:'chrome',stateDir:join(directory,'state'),endpoint}),decision:{status:async()=>({ready:true}),choose:async args=>{choiceRequests++;assert.equal(JSON.stringify(args).includes('PRIVATE_LOCAL_INPUT'),false);return signChoiceResponse(args,{provider:'jev',model:'jev-1.14.0',selected_id:args.actions[0]!.id,confidence:1,usage:null},{privateKey:keys.privateKey,issuer:'offline-stub',audience:'offline-stub',identity:{owner_id:'stub',agent_id:'stub',device_id:'stub'},caller_scope:'stub'});},close:async()=>{}}});
  const status=await service.status();assert.equal(status.platform,process.platform);assert.equal(status.execution_host,'local');assert.equal(status.decision.ready,true);
  assert.ok(JSON.stringify(await service.tools()).includes('browser_type'));
  const snapshot=await service.observe({tool:'browser_snapshot',arguments:{}});assert.ok(JSON.stringify(snapshot).includes('Local note'));
  const args={idempotency_key:'input-once',task:'Type into local fixture',state:{observed:'Local note input'},actions:[{id:'type',tool:'browser_type',arguments:{target:'#note',text:'PRIVATE_LOCAL_INPUT'},description:'Type the requested note'}]};
  assert.equal((await service.act(args)).execution,'executed');assert.equal(await page.locator('#note').inputValue(),'PRIVATE_LOCAL_INPUT');assert.equal(choiceRequests,1);
  await service.close();service=undefined;assert.equal(fixtureBrowser.isConnected(),true,'closing bridge must not terminate attached daily browser');assert.equal(await page.title(),'Local fixture');assert.equal(await page.locator('#note').inputValue(),'PRIVATE_LOCAL_INPUT');
 }finally{await service?.close();await fixtureContext?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
