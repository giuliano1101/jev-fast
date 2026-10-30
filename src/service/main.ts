import {parseArgs} from 'node:util';
import {join} from 'node:path';
import {FixtureServer} from '../../fixtures/server.js';
import {BrowserAdapter} from '../browser/adapter.js';
import {Engine} from '../core/engine.js';
import {Fault} from '../core/errors.js';
import {loadServiceProfile} from './config.js';
import {Coordinator} from './coordinator.js';
import {cleanupAll} from './cleanup.js';
import {safeCode} from './ipc.js';
import {defaultRuntime,privateRuntime} from './runtime.js';
async function main(){
 let args;try{args=parseArgs({options:{runtime:{type:'string'},config:{type:'string'},'share-a-with-b':{type:'boolean'}},strict:true,allowPositionals:false});}catch{throw new Fault('INVALID_ARGUMENTS');}
 const profile=await loadServiceProfile(args.values.config,args.values['share-a-with-b']??false);
 const runtimeDir=await privateRuntime(args.values.runtime??defaultRuntime());
 const fixture=await FixtureServer.start();const browser=new BrowserAdapter(fixture.origin);let engine:Engine|undefined;
 try{
  engine=await Engine.create({storageDir:join(runtimeDir,'ledger'),browser,provider:profile.provider,clients:profile.clients,sharedAccess:profile.sharedAccess,remotePolicy:profile.remotePolicy});
  const service=await Coordinator.start({runtimeDir,engine,clients:profile.clients,health:profile.health,onStop:()=>cleanupAll([()=>browser.shutdown(),()=>fixture.close()])});
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void service.close().catch(()=>{process.stderr.write('SERVICE_SHUTDOWN_FAILED\n');process.exitCode=1;});});
  process.stdout.write(JSON.stringify({ready:true,provider:profile.mode,pid:process.pid})+'\n');
 }catch(error){await cleanupAll([async()=>engine?.shutdown(),()=>browser.shutdown(),()=>fixture.close()]).catch(()=>{});throw error;}
}
void main().catch(error=>{process.stderr.write(safeCode(error)+'\n');process.exitCode=1;});
