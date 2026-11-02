import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {signChoiceResponse} from '../../src/remote/choice.js';
import {createHostMcpClient,type HostMcpClient} from '../../src/host/service.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {choiceArgsSchema} from '../../src/choice/contracts.js';
/** The fixture owns this browser. Headless is explicit for CI; the product launch default is separately asserted headed. */
test('official local MCP attaches to existing local tab, types via Jev stub, and leaves borrowed browser alive',{timeout:40000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'jev-local-cdp-')),profile=join(directory,'fixture-browser'),keys=generateKeyPairSync('ed25519');
 const server=createServer((_request,response)=>response.setHeader('content-type','text/html').end('<title>Local fixture</title><label>Local note <input id="note"></label>'));
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const cloudCalls:string[]=[];let choiceRequests=0;const cloudServer=createServer(async(request,response)=>{
  if(request.method!=='POST'){response.writeHead(405).end();return;}
  const mcp=new Server({name:'offline-public-Jev-stub',version:'1'},{capabilities:{tools:{}}}),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'jev.choose_action',inputSchema:{type:'object'}}]}));
  mcp.setRequestHandler(CallToolRequestSchema,async request=>{
   cloudCalls.push(request.params.name);let value:unknown;const parameters=request.params.arguments??{};
   if(request.params.name==='jev.network_status')value={enabled:true,connector_online:true,local_ready:true,continuation_supported:true,continuation_token:'PRIVATE_TEST_CONTINUATION'};
   else {assert.equal(parameters.continuation_token,'PRIVATE_TEST_CONTINUATION');if(request.params.name==='jev.choose_action'){choiceRequests++;const args=choiceArgsSchema.parse(parameters.params);assert.equal(JSON.stringify(args).includes('PRIVATE_LOCAL_INPUT'),false);value={delivery_status:'COMPLETED',reply:{ok:true,result:signChoiceResponse(args,{provider:'jev',model:'jev-1.14.0',selected_id:args.actions[0]!.id,confidence:1,usage:null},{privateKey:keys.privateKey,issuer:'offline-stub',audience:'offline-stub',identity:{owner_id:'stub',agent_id:'stub',device_id:'stub'},caller_scope:'stub'})}};}else value={released:true};}
   return {content:[{type:'text',text:JSON.stringify(value)}]};
  });
  response.once('close',()=>{void transport.close();void mcp.close();});await mcp.connect(transport);await transport.handleRequest(request,response);
 });
 cloudServer.listen(0,'127.0.0.1');await once(cloudServer,'listening');const cloudAddress=cloudServer.address();assert.ok(cloudAddress&&typeof cloudAddress==='object');
 function result(reply:CallToolResult):Record<string,unknown>{assert.equal(reply.isError,undefined,JSON.stringify(reply));const text=reply.content.find(value=>value.type==='text');assert.ok(text&&text.type==='text');return JSON.parse(text.text) as Record<string,unknown>;}
 let service:HostMcpClient|undefined;let fixtureContext:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined;
 try{
  fixtureContext=await chromium.launchPersistentContext(profile,{headless:true,args:['--remote-debugging-port=0'],...(process.env.JEV_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.JEV_TEST_BROWSER_EXECUTABLE}:{})});
  const fixtureBrowser=fixtureContext.browser();assert.ok(fixtureBrowser);
  let port:string|undefined;for(let attempts=0;attempts<200&&!port;attempts++){try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];}catch{await sleep(50);}}
  assert.ok(port,'fixture browser must provide actual local CDP endpoint');const endpoint=`http://127.0.0.1:${port}`;
  const page=fixtureContext.pages()[0]!;await page.goto(`http://127.0.0.1:${address.port}`);
  service=await createHostMcpClient({serverCommand:process.execPath,serverArgs:[resolve('dist/src/local/main.js'),'--mode','attach','--browser','chrome','--state-dir',join(directory,'state'),'--cdp-endpoint',endpoint,'--jev-endpoint',`http://127.0.0.1:${cloudAddress.port}/mcp`]});
  const call=(name:string,args:Record<string,unknown>={})=>service!.callTool({name,arguments:args});
  assert.deepEqual((await service.listTools()).tools.map(tool=>tool.name),['jev.local_status','jev.local_tools','jev.local_observe','jev.local_act']);
  const status=result(await call('jev.local_status'));assert.equal(status.platform,process.platform);assert.equal(status.execution_host,'local');assert.equal((status.cloud as {ready:boolean}).ready,true);
  const tools=result(await call('jev.local_tools'));assert.ok(JSON.stringify(tools).includes('browser_type'));
  const snapshot=await call('jev.local_observe',{tool:'browser_snapshot',arguments:{}});assert.ok(JSON.stringify(snapshot).includes('Local note'));
  const args={idempotency_key:'input-once',task:'Type into local fixture',state:{observed:'Local note input'},actions:[{id:'type',tool:'browser_type',arguments:{target:'#note',text:'PRIVATE_LOCAL_INPUT'},description:'Type the requested note'}]};
  assert.equal(result(await call('jev.local_act',args)).execution,'executed');assert.equal(await page.locator('#note').inputValue(),'PRIVATE_LOCAL_INPUT');assert.equal(choiceRequests,1);assert.equal(cloudCalls.some(name=>name.startsWith('jev.browser_')),false);
  await service.close();service=undefined;assert.equal(fixtureBrowser.isConnected(),true,'closing bridge must not terminate attached daily browser');assert.equal(await page.title(),'Local fixture');assert.equal(await page.locator('#note').inputValue(),'PRIVATE_LOCAL_INPUT');
 }finally{await service?.close();await fixtureContext?.close();server.closeAllConnections();cloudServer.closeAllConnections();await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>cloudServer.close(()=>resolve()))]);rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
