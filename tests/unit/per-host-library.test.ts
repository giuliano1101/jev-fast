import test from 'node:test';
import assert from 'node:assert/strict';
const entryPath='../../src/index.js';
const library=await import(entryPath).catch(()=>undefined);
test('per-host library exports lifecycle, native and browser executors without a CLI or MCP server',()=>{
 for(const name of ['startService','stopService','serviceHealth','inspectService','DesktopExecutor','LocalBrowserService','Coordinator'])assert.equal(typeof library?.[name],'function',name);
});
test('native executor validates grounded requests and calls the driver directly',async()=>{
 assert.equal(typeof library?.DesktopExecutor,'function');
 const calls:unknown[]=[];let closed=false;
 const driver={call:async(method:string,params:unknown)=>{calls.push({method,params});return {status:'input_submitted'};},close:async()=>{closed=true;}};
 const executor=new library.DesktopExecutor({driver});assert.equal(executor.tools.length,14);
 assert.deepEqual(await executor.call('desktop_click',{app:'Any',observation_id:'seen',element_id:'e1'}),{status:'input_submitted'});
 await assert.rejects(executor.call('desktop_click',{app:'Any',x:1,y:2}));
 assert.deepEqual(calls,[{method:'click',params:{app:'Any',observation_id:'seen',element_id:'e1'}}]);await executor.close();assert.equal(closed,true);
});
test('recovery rejects caller overrides instead of changing the persisted selection',async()=>{
 assert.equal(typeof library?.startService,'function');
 for(const override of [{configFile:'/tmp/jev-unused-profile.json'},{shared:false}])await assert.rejects(library.startService({runtime:'/tmp/jev-recover-overrides',recover:true,...override}),/INVALID_ARGUMENTS/);
});
