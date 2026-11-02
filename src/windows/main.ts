import {pathToFileURL} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {Fault} from '../core/errors.js';
import {safeCode} from '../service/ipc.js';
import {WindowsEngine} from './engine.js';
import {loadWindowsConfig} from './config.js';
import {startWindowsMcp} from './protocol.js';
import {startWindowsCoordinator,ensureWindowsCoordinator,connectWindowsCoordinator} from './coordinator.js';

async function main(){
 const args=process.argv.slice(2);if(args.includes('--help')){console.log('Jev Windows: node dist/src/windows/main.js --config /absolute/private/windows.json [--status|--start|--serve|--direct]');return;}
 if(args[0]!=='--config'||!args[1]||args.length>3||(args[2]&&!['--status','--start','--serve','--direct'].includes(args[2])))throw new Fault('INVALID_ARGUMENTS');
 const config=await loadWindowsConfig(args[1]);
 if(args[2]==='--serve'){
  const coordinator=await startWindowsCoordinator(config);console.log(JSON.stringify({ready:true,pid:coordinator.pid}));
  const stop=()=>{void coordinator.close().then(()=>{process.exitCode=0;}).catch(()=>{process.stderr.write('UNRESOLVED_CONTEXT_RETAINED\n');process.exitCode=1;});};process.once('SIGTERM',stop);process.once('SIGINT',stop);return;
 }
 if(args[2]==='--direct'){
  const engine=new WindowsEngine(config);await engine.initialize();const server=await startWindowsMcp(engine);process.stdin.once('end',()=>{engine.stopAccepting();void server.close().then(()=>engine.drain()).finally(()=>engine.close());});return;
 }
 const location=await ensureWindowsCoordinator(config,args[1],args[2]==='--start');
 if(args[2]==='--start'){console.log(JSON.stringify({ready:true,pid:location.pid}));return;}
 const connection=await connectWindowsCoordinator(location);
 if(args[2]==='--status'){try{const result=await connection.client.callTool({name:'jev_windows.status',arguments:{}});console.log(JSON.stringify(result));}finally{await connection.close();}return;}
 const server=new Server({name:'jev-windows-facade',version:'0.3.0'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>await connection.client.listTools());
 server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>await connection.client.callTool(request.params,undefined,{signal:extra.signal,timeout:180000}));
 server.onerror=()=>process.stderr.write('WINDOWS_FACADE_PROTOCOL_ERROR\n');await server.connect(new StdioServerTransport());
 process.stdin.once('end',()=>{void server.close().finally(()=>connection.close()).catch(()=>process.stderr.write('WINDOWS_CONTEXT_RELEASE_UNCONFIRMED\n'));});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(error=>{process.stderr.write(safeCode(error)+'\n');process.exitCode=1;});
