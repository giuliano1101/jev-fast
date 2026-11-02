import {parseArgs} from 'node:util';
import {homedir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type Tool,type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {localBackendConfig,selectBrowser,type LocalBrowserOptions} from './config.js';
import {PublicJevCloud} from './cloud.js';
import {LocalBrowserService,localActSchema} from './service.js';
export const localToolDefinitions:Tool[]=[
 {name:'jev.local_status',description:'Read actual local platform, configured browser mode and public Jev readiness. Does not select a paid action.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'jev.local_tools',description:'List actual schemas from the locally installed official Playwright MCP backend.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'jev.local_observe',description:'Read a local browser observation using verified read-only backend methods and arguments. Does not accept tabs, JavaScript evaluation, input, navigation or file output.',inputSchema:{type:'object',properties:{tool:{type:'string'},arguments:{type:'object'}},required:['tool'],additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'jev.local_act',description:'Ask the existing public real Jev to choose an action, then execute the selected backend call on THIS machine. Arguments stay local; only task, state and candidate descriptions go to Jev. Keep the idempotency key on uncertain responses; unknown is never permission to replay. Returned execution is a tool result, not task completion.',inputSchema:z.toJSONSchema(localActSchema) as Tool['inputSchema']}
];
export function defaultLocalStateDir(){return process.platform==='win32'?join(process.env.LOCALAPPDATA??join(homedir(),'AppData','Local'),'Jev','local-browser'):join(homedir(),'.jev','local-browser');}
export function parseLocalOptions(args:string[]):{browser:LocalBrowserOptions;endpoint?:string;help:boolean}{
 const {values}=parseArgs({args,strict:true,allowPositionals:false,options:{mode:{type:'string'},browser:{type:'string'},'state-dir':{type:'string'},'cdp-endpoint':{type:'string'},'executable-path':{type:'string'},'jev-endpoint':{type:'string'},headless:{type:'boolean'},help:{type:'boolean'}}});
 const mode=values.mode??'launch';if(!['launch','attach','extension'].includes(mode))throw Error('INVALID_LOCAL_BROWSER_MODE');
 const browser=values.browser??(values.help?'chrome':selectBrowser());if(!['chrome','msedge','chromium'].includes(browser))throw Error('INVALID_LOCAL_BROWSER_CHANNEL');
 if(browser==='chromium'&&mode!=='launch')throw Error('CHROMIUM_REQUIRES_LAUNCH');
 const stateDir=values['state-dir']??defaultLocalStateDir();if(!isAbsolute(stateDir)||values['executable-path']&&!isAbsolute(values['executable-path']))throw Error('ABSOLUTE_LOCAL_PATH_REQUIRED');
 if(values['cdp-endpoint']&&mode!=='attach')throw Error('CDP_REQUIRES_ATTACH');
 const options:LocalBrowserOptions={mode:mode as LocalBrowserOptions['mode'],browser:browser as LocalBrowserOptions['browser'],stateDir:resolve(stateDir),headless:values.headless??false,...(values['cdp-endpoint']?{endpoint:values['cdp-endpoint']}:{}),...(values['executable-path']?{executablePath:values['executable-path']}:{})};
 localBackendConfig(options);return {browser:options,endpoint:values['jev-endpoint'],help:values.help??false};
}
function safeCode(error:unknown){const code=error instanceof Error?error.message:'';return /^[A-Z][A-Z0-9_]*$/.test(code)?code:'LOCAL_BROWSER_OPERATION_FAILED';}
export async function localBrowserMain(args:string[]=process.argv.slice(2)){
 const options=parseLocalOptions(args);if(options.help){process.stdout.write('Jev local browser MCP\n--mode launch|attach|extension --browser chrome|msedge|chromium --state-dir ABSOLUTE_PATH\nLaunch is visible and isolated by default. Attach borrows an existing local CDP browser; extension uses the official Playwright extension and user permission prompt. --headless is explicit.\n');return;}
 const service=new LocalBrowserService({stateDir:options.browser.stateDir,backend:localBackendConfig(options.browser),cloud:new PublicJevCloud({stateDir:options.browser.stateDir,endpoint:options.endpoint})});
 const server=new Server({name:'jev-local-browser',version:'1.0.0'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:localToolDefinitions}));
 server.setRequestHandler(CallToolRequestSchema,async request=>{
  try{
   const args=request.params.arguments??{};let value:unknown;
   switch(request.params.name){
    case 'jev.local_status':z.strictObject({}).parse(args);value={...await service.status(),mode:options.browser.mode,browser_channel:options.browser.browser,headed:options.browser.mode==='launch'?!options.browser.headless:'existing-browser',profile:options.browser.mode==='launch'?'isolated':'existing',browser_connection:'verified by subsequent local observation'};break;
    case 'jev.local_tools':z.strictObject({}).parse(args);value=await service.tools();break;
    case 'jev.local_observe':return await service.observe(args);
    case 'jev.local_act':value=await service.act(args);break;
    default:throw Error('LOCAL_TOOL_UNAVAILABLE');
   }
   return {content:[{type:'text',text:JSON.stringify(value)}]} as CallToolResult;
  }catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({code:safeCode(error),task_complete:false})}]};}
 });
 server.onerror=()=>{};let closing:Promise<void>|undefined;const close=()=>closing??=(async()=>{await service.close();await server.close();})();
 process.stdin.once('end',()=>{void close();});for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void close();});
 await server.connect(new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:16*1024*1024}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void localBrowserMain().catch(error=>{process.stderr.write(safeCode(error)+'\n');process.exitCode=1;});
