/** Real model + two real stdio facades + real local browser. Explicit opt-in only. */
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startWindowsCoordinator} from '../../src/windows/coordinator.js';
import {loadWindowsConfig} from '../../src/windows/config.js';
import {parseTool,type JsonObject} from '../../src/windows/network-client.js';
import {windowsWorkbench} from '../../tests/fixtures/windows-workbench.js';
import {Fault} from '../../src/core/errors.js';

export async function runMcpLive(configPath:string,reportPath:string){
 const config=await loadWindowsConfig(configPath),coordinator=await startWindowsCoordinator(config),site=await windowsWorkbench();
 const clients:Client[]=[],transports:StdioClientTransport[]=[];const cases:JsonObject[]=[];let uncertain=false,businessStarted=false;
 const connect=async()=>{const c=new Client({name:'Windows real acceptance',version:'1'}),t=new StdioClientTransport({command:process.execPath,args:[resolve('dist/src/windows/main.js'),'--config',resolve(configPath)],stderr:'pipe'});clients.push(c);transports.push(t);await c.connect(t);return c;};
 const call=async(c:Client,name:string,args:JsonObject)=>parseTool(await c.callTool({name:'jev_windows.'+name,arguments:args},undefined,{timeout:180000}));
 const record=async(id:string,operation:()=>Promise<JsonObject|void>)=>{const start=Date.now();const result=await operation()??{};cases.push({id,status:'passed',elapsed_ms:Date.now()-start,provider:result.provider,model:result.model,request_id:result.request_id,usage:result.usage});console.log(JSON.stringify({test:id,status:'passed'}));};
 try{
  const [a,b]=await Promise.all([connect(),connect()]);
  await record('actual-facade-tools',async()=>{assert.equal((await a.listTools()).tools.length,28);assert.equal((await b.listTools()).tools.length,28);});
  for(const c of [a,b]){const s=await call(c,'status',{}),jev=s.jev as JsonObject;assert.equal(jev.enabled,true);assert.equal(jev.connector_online,true);assert.equal(jev.local_ready,true);}
  let one:JsonObject={},two:JsonObject={};businessStarted=true;
  await record('first-client-local-browser',async()=>{one=await call(a,'browser_open',{url:site.url,operation_id:'mcp-live-open'});const result=one.action as JsonObject;assert.equal(result.provider,'jev');assert.equal(result.verified,true);return result;});
  await record('second-client-same-operation-id',async()=>{two=await call(b,'browser_open',{url:site.url,operation_id:'mcp-live-open'});assert.notEqual(one.session_id,two.session_id);const result=two.action as JsonObject;assert.equal(result.provider,'jev');assert.equal(result.verified,true);return result;});
  await record('cross-owner-observation-refused',async()=>{const result=await a.callTool({name:'jev_windows.browser_observe',arguments:{session_id:two.session_id}});assert.equal(result.isError,true);assert.ok(JSON.stringify(result).includes('BROWSER_SESSION_NOT_OWNED'));});
  await record('release-one-keeps-other',async()=>{await call(a,'release',{});const o=await call(b,'browser_observe',{session_id:two.session_id});assert.ok(String((o.state as JsonObject).text).includes('Windows Jev workbench'));});
  const observed=await call(b,'browser_observe',{session_id:two.session_id}),input=((observed.state as JsonObject).controls as JsonObject[]).find(c=>String(c.label).includes('Test name'));assert.ok(input);
  await record('real-jev-through-default-facade',async()=>{const result=await call(b,'browser_act',{operation_id:'mcp-live-fill',target:two.session_id,snapshot_id:observed.snapshot_id,task:'Fill the actual Test name field with Windows MCP live.',actions:[{id:'fill',description:'Fill Test name with Windows MCP live',action:{operation:'fill',control_id:input.control_id,value:'Windows MCP live'}}],expected:{control:{control_id:input.control_id,value:'Windows MCP live'}}});assert.equal(result.provider,'jev');assert.equal(result.verified,true);return result;});
  await record('own-resources-released',async()=>{await call(b,'release',{});});
 }catch(error){const code=error instanceof Fault?error.code:'MCP_RESPONSE_UNKNOWN';uncertain=businessStarted&&(/UNKNOWN|CONTINUATION/.test(code)||!(error instanceof Fault));cases.push({id:'suite-stopped',status:'failed',code,uncertain});process.exitCode=1;console.log(JSON.stringify({error:code,uncertain}));}
 finally{
  for(const c of clients)await c.close();for(const t of transports)await t.close();
  if(!uncertain){try{await coordinator.close();}catch{cases.push({id:'cleanup',status:'failed',code:'CLEANUP_UNCONFIRMED'});process.exitCode=1;}}
  await site.close();await mkdir(dirname(resolve(reportPath)),{recursive:true});await writeFile(reportPath,JSON.stringify({schema_version:1,executor:'real-jev-default-windows-mcp',uncertain,cases,passed:cases.filter(c=>c.status==='passed').length,failed:cases.filter(c=>c.status==='failed').length,notes:['No mock provider, no credential or raw page payload in this report.','Original request ids and private owner contexts are retained on uncertainty.']},null,2)+'\n');
 }
}
async function main(){const args=process.argv.slice(2);if(args[0]!=='--config'||!args[1]||args[2]!=='--report'||!args[3]||args.length!==4)throw new Fault('INVALID_ARGUMENTS');await runMcpLive(args[1],args[3]);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{process.stderr.write('MCP_LIVE_TEST_FAILED\n');process.exitCode=1;});
