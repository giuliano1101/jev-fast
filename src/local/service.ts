import {join} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ChoiceArgs,ChoiceResponse} from '../choice/contracts.js';
import {HostService,createHostMcpClient,type HostConfig,type HostServiceOptions,type HostMcpClient} from '../host/service.js';
import {hostSchemas} from '../host/contracts.js';
import {preparePrivateDirectory,assertPrivateFile} from '../service/private-directory.js';
import {readOnlyObservation} from './config.js';
export interface DecisionPort {status():Promise<{ready:boolean;[key:string]:unknown}>;choose(args:ChoiceArgs,signal:AbortSignal):Promise<ChoiceResponse>;close():Promise<void>}
export interface LocalBrowserServiceOptions{stateDir:string;backend:HostConfig;decision:DecisionPort;clientFactory?:HostServiceOptions['clientFactory']}
const observeSchema=z.strictObject({tool:z.string().min(1),arguments:z.record(z.string(),z.json()).default({})});
const {host:_host,...actShape}=hostSchemas.host_act.shape;
export const localActSchema=z.strictObject(actShape);
/** Private journal scopes stay stable across process restart. Uncertain old actions can never be replayed. */
export class LocalBrowserService {
 private readonly host:HostService;private readonly owner:string;private backend?:Promise<HostMcpClient>;
 constructor(private readonly options:LocalBrowserServiceOptions){
  const ownerPath=join(preparePrivateDirectory(options.stateDir),'local-owner');
  try{writeFileSync(ownerPath,randomUUID()+'\n',{mode:0o600,flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  assertPrivateFile(ownerPath);const owner=readFileSync(ownerPath,'utf8').trim();if(!z.uuid().safeParse(owner).success)throw Error('LOCAL_OWNER_CORRUPT');this.owner=owner;
  this.host=new HostService({storageDir:options.stateDir,hosts:{browser:options.backend},chooseAction:async(_owner,args,signal)=>{
   await this.requireReady();const decision=await options.decision.choose(args,signal);await this.requireReady();return decision;
  },clientFactory:(config,host,signal)=>this.backend??=(options.clientFactory??createHostMcpClient)(config,host,signal)});
 }
 private async requireReady(){const status=await this.options.decision.status();if(!status.ready)throw Error('DECISION_NOT_READY');}
 async status(){let decision:{ready:boolean;[key:string]:unknown};try{decision=await this.options.decision.status();}catch{decision={ready:false,code:'DECISION_UNAVAILABLE'};}return {platform:process.platform,execution_host:'local',backend:'@playwright/mcp',decision};}
 async tools(){return this.host.tools(this.owner,{host:'browser'});}
 async act(input:unknown){await this.requireReady();return this.host.act(this.owner,{...localActSchema.parse(input),host:'browser'});}
 async observe(input:unknown){const args=observeSchema.parse(input),listed=await this.tools(),tool=listed.tools.find(tool=>tool.name===args.tool);if(!tool||!readOnlyObservation(tool,args.arguments))throw Error('OBSERVATION_NOT_READ_ONLY');const client=await this.backend!;return client.callTool({name:args.tool,arguments:args.arguments});}
 async close(){await this.host.shutdown();await this.options.decision.close();}
}
