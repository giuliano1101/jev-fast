import {parseArgs} from 'node:util';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {desktopToolDefinitions,parseDesktopTool} from './contracts.js';
import {NativeDesktopDriver,nativeLaunchSpec} from './driver.js';

function code(error:unknown){const value=error instanceof Error?error.message:'';return /^[A-Z][A-Z0-9_]*$/.test(value)?value:'DESKTOP_OPERATION_FAILED';}
export function desktopResult(result:Record<string,unknown>):CallToolResult {
 const {image,...metadata}=result;const content:CallToolResult['content']=[{type:'text',text:JSON.stringify(metadata)}];
 if(image!==undefined){
  if(!image||typeof image!=='object'||typeof (image as Record<string,unknown>).data!=='string'||(image as Record<string,unknown>).mimeType!=='image/png')throw new Error('DESKTOP_INVALID_IMAGE');
  const {data,mimeType,...mapping}=image as {data:string;mimeType:string;[key:string]:unknown};
  content[0]={type:'text',text:JSON.stringify({...metadata,image_metadata:{...(metadata.image_metadata as Record<string,unknown>??{}),...mapping}})};
  content.push({type:'image',data,mimeType});
 }
 return {content};
}
export async function desktopMain(args:string[]=process.argv.slice(2)){
 const {values}=parseArgs({args,strict:true,allowPositionals:false,options:{'native-command':{type:'string'},'native-arg':{type:'string',multiple:true},call:{type:'string'},help:{type:'boolean'}}});
 if(values.help){process.stdout.write('Jev native desktop MCP (macOS / Windows)\nRun without arguments for stdio MCP. --call JSON invokes one native diagnostic/tool locally without Jev. Build macOS driver with npm run desktop:build.\n');return;}
 if(values['native-arg']&&!values['native-command']||values['native-command']&&!isAbsolute(values['native-command']))throw new Error('INVALID_NATIVE_CONFIGURATION');
 const driver=new NativeDesktopDriver(values['native-command']?{command:values['native-command'],args:values['native-arg']??[]}:nativeLaunchSpec());
 const call=async(name:string,input:unknown)=>desktopResult(await driver.call(name.replace(/^desktop_/,''),parseDesktopTool(name,input)));
 if(values.call){try{const request=JSON.parse(values.call) as {name:string;arguments?:unknown};process.stdout.write(JSON.stringify(await call(request.name,request.arguments??{}))+'\n');}finally{await driver.close();}return;}
 const server=new Server({name:'jev-native-desktop',version:'1.0.0'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:desktopToolDefinitions}));
 server.setRequestHandler(CallToolRequestSchema,async request=>{try{return await call(request.params.name,request.params.arguments??{});}catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({code:code(error),task_complete:false})}]};}});
 server.onerror=()=>{};let closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{await driver.close();await server.close();})();
 process.stdin.once('end',()=>{void close();});for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{void close();});
 await server.connect(new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:16*1024*1024}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void desktopMain().catch(error=>{process.stderr.write(code(error)+'\n');process.exitCode=1;});
