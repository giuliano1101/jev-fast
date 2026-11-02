import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';
import {signChoiceResponse} from '../../src/remote/choice.js';
import {localBackendConfig,readOnlyObservation,selectBrowser} from '../../src/local/config.js';
import {LocalBrowserService} from '../../src/local/service.js';
const observation:Tool={name:'browser_snapshot',inputSchema:{type:'object'},annotations:{readOnlyHint:true}};
test('local browser defaults visible and selects installed Windows Edge before Chrome',()=>{
 assert.equal(selectBrowser('win32',{ProgramFiles:'C:\\Program Files'},p=>p.includes('Edge')),'msedge');
 assert.equal(selectBrowser('darwin',{},p=>p.includes('Google Chrome')),'chrome');
 const config=localBackendConfig({mode:'launch',browser:'msedge',stateDir:'/private/local'});
 assert.equal(config.serverCommand,process.execPath);assert.ok(config.serverArgs[0]?.endsWith(join('@playwright','mcp','cli.js')));
 assert.equal(config.serverArgs.includes('--headless'),false);assert.ok(config.serverArgs.includes('--timeout-action=0'));assert.ok(config.serverArgs.includes('--timeout-navigation=0'));
 assert.ok(localBackendConfig({mode:'attach',browser:'chrome',stateDir:'/private/local'}).serverArgs.includes('--cdp-endpoint=chrome'));
 assert.ok(localBackendConfig({mode:'extension',browser:'chrome',stateDir:'/private/local'}).serverArgs.includes('--extension'));
});
test('observation requires verified read-only names and arguments, never tabs or JS or file writes',()=>{
 assert.equal(readOnlyObservation(observation,{}),true);
 for(const tool of ['browser_tabs','browser_evaluate','browser_click','future_read_only'])assert.equal(readOnlyObservation({...observation,name:tool},{action:'list'}),false);
 assert.equal(readOnlyObservation({...observation,annotations:{readOnlyHint:false}},{}),false);
 assert.equal(readOnlyObservation(observation,{filename:'written.md'}),false);
 assert.equal(readOnlyObservation(observation,{anything:true}),false);
});
test('local action sends only descriptions/state to Jev, executes local backend once and survives reopen',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'jev-local-test-')),keys=generateKeyPairSync('ed25519');let stateDir=join(directory,'state');let calls=0,choices=0,ready=true,lose=false;
 const create=()=>new LocalBrowserService({stateDir,backend:localBackendConfig({mode:'launch',browser:'chrome',stateDir}),cloud:{status:async()=>({ready}),choose:async(args)=>{choices++;assert.equal(JSON.stringify(args).includes('LOCAL_SECRET'),false);return signChoiceResponse(args,{provider:'jev',model:'jev-1.14.0',selected_id:'write',confidence:1,usage:null},{privateKey:keys.privateKey,issuer:'test',audience:'test',identity:{owner_id:'test',agent_id:'test',device_id:'test'},caller_scope:'test'});},close:async()=>{}},clientFactory:async()=>({listTools:async()=>({tools:[observation,{name:'browser_type',inputSchema:{type:'object'}}]}),callTool:async()=>{calls++;if(lose)throw Error('lost local response');return {content:[{type:'text',text:'done'}]};},close:async()=>{}})});
 const args={idempotency_key:'write-once',task:'Type',state:{page:'input'},actions:[{id:'write',tool:'browser_type',arguments:{text:'LOCAL_SECRET'},description:'Type requested text'}]};let service=create();
 try{assert.equal((await service.act(args)).execution,'executed');assert.equal(calls,1);await service.close();const moved=join(directory,'moved-private-state');renameSync(stateDir,moved);stateDir=moved;service=create();assert.equal((await service.act(args)).execution,'executed');assert.equal(calls,1);assert.equal(choices,1);ready=false;await assert.rejects(service.act({...args,idempotency_key:'new'}),/CLOUD_NOT_READY/);assert.equal(calls,1);await assert.rejects(service.observe({tool:'browser_tabs',arguments:{action:'new'}}),/OBSERVATION_NOT_READ_ONLY/);assert.equal(calls,1);ready=true;lose=true;const unknownArgs={...args,idempotency_key:'uncertain-local'};assert.equal((await service.act(unknownArgs)).execution,'unknown');assert.equal(calls,2);await service.close();service=create();assert.equal((await service.act(unknownArgs)).execution,'unknown');assert.equal(calls,2);assert.equal(choices,2);}finally{await service.close();rmSync(directory,{recursive:true,force:true});}
});

test('standalone MCP exposes only local entrypoints with trusted CLI browser modes',async()=>{
 const {localToolDefinitions,parseLocalOptions}=await import('../../src/local/main.js');
 assert.deepEqual(localToolDefinitions.map(tool=>tool.name),['jev.local_status','jev.local_tools','jev.local_observe','jev.local_act']);
 assert.equal(parseLocalOptions(['--browser','chrome','--mode','extension']).browser.mode,'extension');
 assert.equal(parseLocalOptions(['--browser','msedge','--mode','attach']).browser.headless,false);
 assert.throws(()=>parseLocalOptions(['--browser','chrome','--mode','wrong']),/INVALID_LOCAL_BROWSER_MODE/);
 assert.throws(()=>parseLocalOptions(['--browser','chrome','--mode','attach','--cdp-endpoint','https://remote.invalid']),/INVALID_LOCAL_CDP_ENDPOINT/);
});
