import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {Fault} from '../core/errors.js';
import {parseTool,toolDefinitions} from '../service/contracts.js';
import {ipcCall,readCredential,safeCode,MAX_FRAME_BYTES} from '../service/ipc.js';
async function main(){
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--credential')throw new Fault('INVALID_ARGUMENTS');
 const credential=await readCredential(args[1]!);await ipcCall(credential,'service.health',{});
 const server=new Server({name:'jev-local-mock',version:'0.1.0'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:toolDefinitions}));
 server.setRequestHandler(CallToolRequestSchema,async request=>{
  try{const params=parseTool(request.params.name,request.params.arguments??{});const result=await ipcCall(credential,request.params.name,params);return {content:[{type:'text',text:JSON.stringify(result)}]};}
  catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({code:safeCode(error)})}]};}
 });
 server.onerror=()=>{process.stderr.write('MCP_PROTOCOL_ERROR\n');};
 const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:MAX_FRAME_BYTES});
 await server.connect(transport);
 process.stdin.once('end',()=>{void server.close();});
}
void main().catch(error=>{process.stderr.write(safeCode(error)+'\n');process.exitCode=1;});
