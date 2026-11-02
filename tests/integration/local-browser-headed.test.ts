import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {LocalBrowserService} from '../../src/local/service.js';
import {localBackendConfig} from '../../src/local/config.js';
import {signChoiceResponse} from '../../src/remote/choice.js';
/** Opt-in CI acceptance uses a real visible browser on the hosted Windows runner. No daily profile or hosted Jev calls. */
test('visible default launch performs real local browser input with offline decision stub',{skip:process.env.JEV_LOCAL_HEADED_ACCEPTANCE!=='1',timeout:40000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'jev-local-headed-')),stateDir=join(root,'state'),keys=generateKeyPairSync('ed25519');let observedInput=false;
 const server=createServer((request,response)=>{if(request.url?.startsWith('/input?value=visible-local-input'))observedInput=true;response.setHeader('content-type','text/html');response.end('<label>Visible input <input id="note" oninput="fetch(\'/input?value=\'+encodeURIComponent(this.value))"></label>');});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const backend=localBackendConfig({mode:'launch',browser:'chromium',stateDir,...(process.env.JEV_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.JEV_TEST_BROWSER_EXECUTABLE}:{})});assert.equal(backend.serverArgs.includes('--headless'),false);
 const service=new LocalBrowserService({stateDir,backend,cloud:{status:async()=>({ready:true}),choose:async args=>signChoiceResponse(args,{provider:'jev',model:'jev-1.14.0',selected_id:args.actions[0]!.id,confidence:1,usage:null},{privateKey:keys.privateKey,issuer:'offline-stub',audience:'offline-stub',identity:{owner_id:'stub',agent_id:'stub',device_id:'stub'},caller_scope:'stub'}),close:async()=>{}}});
 try{
  const navigate=await service.act({idempotency_key:'open-local-fixture',task:'Open local fixture',state:{observation:'New local browser'},actions:[{id:'open',tool:'browser_navigate',arguments:{url:`http://127.0.0.1:${address.port}`},description:'Open local fixture URL'}]});assert.equal(navigate.execution,'executed');
  const typed=await service.act({idempotency_key:'type-visible-local',task:'Type into fixture',state:{observation:'Visible input'},actions:[{id:'type',tool:'browser_type',arguments:{target:'#note',text:'visible-local-input'},description:'Type into visible input'}]});assert.equal(typed.execution,'executed');assert.equal(observedInput,true,'the local page must receive the actual input event');
 }finally{await service.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});
