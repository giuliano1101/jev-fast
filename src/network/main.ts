import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {Fault} from '../core/errors.js';
import {safeCode} from '../service/ipc.js';
import {loadNetworkConfig} from './config.js';
import {startNetworkServer} from './server.js';
import {startConnector} from './connector.js';
export async function runNetworkMain(args:string[]){
 if(args.length===1&&args[0]==='--help'||args.length===2&&['server','connector'].includes(args[0]!)&&args[1]==='--help'){
  process.stdout.write('Usage: network <server|connector> --config /absolute/private/profile.json\nPrivate provisioned HTTPS Bearer profiles only. No OAuth discovery or automatic local service start.\n');return;
 }
 if(args.length!==3||!['server','connector'].includes(args[0]!)||args[1]!=='--config')throw new Fault('INVALID_ARGUMENTS');
 const instance=args[0]==='server'?await startNetworkServer(loadNetworkConfig('server',args[2]!)):await startConnector(loadNetworkConfig('connector',args[2]!));
 const stop=async()=>{if('stop' in instance)await instance.stop();else await instance.close();};
 const handler=()=>{void stop().catch(()=>{process.stderr.write('NETWORK_SHUTDOWN_FAILED\n');process.exitCode=1;});};process.once('SIGINT',handler);process.once('SIGTERM',handler);
 if('done' in instance){await instance.done;const failure=instance.failureCode();if(failure)throw new Fault(failure);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void runNetworkMain(process.argv.slice(2)).catch(error=>{process.stderr.write(safeCode(error)+'\n');process.exitCode=1;});
