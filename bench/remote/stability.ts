/** Expanded synthetic stability matrix. Hosted mode requires an existing, exact budget. */
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {mkdirSync,lstatSync,mkdtempSync,writeFileSync,renameSync,openSync,closeSync,unlinkSync,existsSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer as createTcpServer} from 'node:net';
import {z} from 'zod';
import type {Page} from 'playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {FixtureServer} from '../../fixtures/server.js';
import {BrowserAdapter} from '../../src/browser/adapter.js';
import {Engine,type EngineEvent} from '../../src/core/engine.js';
import {Coordinator} from '../../src/service/coordinator.js';
import {MockProvider} from '../../src/providers/mock.js';
import {taskSchema,idSchema,type Goal,type DecisionProvider} from '../../src/core/contracts.js';
import {GatewayStore} from '../../src/remote/store.js';
import {createDecisionGateway} from '../../src/remote/gateway.js';
import {RemoteDecisionProvider} from '../../src/remote/client.js';
import {certificateSha256,mintAgentToken} from '../../src/remote/credentials.js';
import {readPrivateJson,readPrivateFile} from '../../src/service/config.js';
import {canonicalJson} from '../../src/remote/protocol.js';
import {createAttemptObserver} from './pilot.js';
import {makeRemoteCertificates} from '../../tests/helpers/remote-fixture.js';
export type Entry='direct'|'cli'|'mcp';
export const scenarios=['low_confidence','model_delay','dom_replace','stale_validation','cancel_pending','duplicate','lost_response','gateway_unreachable'] as const;
export type Scenario=typeof scenarios[number];
export interface Trial {id:string;task:Goal['task'];seed:number;entry:Entry;language:'en'|'zh';max_steps:8;time_budget_ms:15000;scenario?:Scenario;}
const entries:Entry[]=['direct','cli','mcp'];
export function normalPlan():Trial[]{
 const plan:Trial[]=[];for(const [taskIndex,task] of taskSchema.options.entries())for(const [seedIndex,seed] of [801,802,803].entries()){
  const rotate=(taskIndex+seedIndex)%3;for(const entry of [...entries.slice(rotate),...entries.slice(0,rotate)])plan.push({id:`${task}-${seed}-${entry}`,task,seed,entry,language:seedIndex===1?'zh':'en',max_steps:8,time_budget_ms:15000});
 }return plan;
}
export function faultPlan():Trial[]{return scenarios.flatMap((scenario,i)=>[811,812].flatMap((seed,j)=>{const rotate=(i+j)%3;return [...entries.slice(rotate),...entries.slice(0,rotate)].map(entry=>({id:`fault-${scenario}-${seed}-${entry}`,task:'select' as const,seed,entry,language:seed===812?'zh' as const:'en' as const,max_steps:8 as const,time_budget_ms:15000 as const,scenario}));}));}
interface VerdictInput {status:unknown;steps?:unknown;actions?:Array<{status?:unknown}>;physical_actions?:number;idempotency?:{same_result?:boolean;no_extra_actions?:boolean;before_decisions?:number;after_decisions?:number};new_key_error?:unknown;}
export function faultVerdict(scenario:Scenario,row:VerdictInput):boolean{
 const zero=row.steps===0&&row.actions?.length===0&&row.physical_actions===0;
 const replaySafe=row.idempotency?.same_result===true&&row.idempotency.no_extra_actions===true&&Number.isInteger(row.idempotency.before_decisions)&&row.idempotency.before_decisions===row.idempotency.after_decisions;
 if(['low_confidence','model_delay','gateway_unreachable'].includes(scenario))return row.status==='FALLBACK'&&zero;
 if(scenario==='cancel_pending')return row.status==='CANCELLED'&&zero;
 if(scenario==='lost_response')return row.status==='UNKNOWN'&&row.steps===1&&row.physical_actions===1&&row.actions?.length===1&&row.actions[0]?.status==='UNKNOWN'&&replaySafe&&row.new_key_error==='QUARANTINED';
 if(scenario==='duplicate')return row.status==='SUCCEEDED'&&row.steps===1&&row.physical_actions===1&&row.actions?.length===1&&row.actions[0]?.status==='SUCCEEDED'&&replaySafe;
 return row.status==='SUCCEEDED'&&row.steps===1&&row.physical_actions===1&&row.actions?.length===1&&row.actions[0]?.status==='SUCCEEDED';
}
const common={approval_id:idSchema,expires_at:z.number().int().positive(),max_requests:z.literal(300),max_cost_usd:z.literal(1)};
const approvalSchema=z.object({authorization:z.strictObject({...common,synthetic_only:z.literal(true)}),approval:z.strictObject({...common,reservation_usd:z.literal(.003)}),authorized_at:z.string().optional()}).passthrough();
export function validateStabilityApproval(value:unknown,now=Date.now()){
 const parsed=approvalSchema.parse(value),a=parsed.authorization,b=parsed.approval;
 const start=parsed.authorized_at?Date.parse(parsed.authorized_at):now;
 if(!Number.isFinite(start)||start>now||now-start>86400000||a.expires_at<=now||a.expires_at>start+86400000||a.approval_id!==b.approval_id||a.expires_at!==b.expires_at)throw Error('INVALID_STABILITY_APPROVAL');
 return parsed;
}
function safeError(error:unknown){const code=error instanceof Error?error.message:'';return /^[A-Z][A-Z0-9_]{1,80}$/.test(code)?code:'STABILITY_ERROR';}
function save(path:string,value:unknown){writeFileSync(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);}
function privateExisting(path:string,directory:boolean){const s=lstatSync(path);if(s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||(directory?!s.isDirectory():!s.isFile()))throw Error('PRIVATE_EXISTING_STATE_REQUIRED');}
async function bounded<T>(operation:Promise<T>,ms=25000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('OPERATION_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}}
function cli(credential:string,name:string,args:Record<string,unknown>):Promise<Record<string,unknown>>{
 return new Promise((done,fail)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../../src/cli/index.js',import.meta.url)),name,'--credential',credential,'--args',JSON.stringify(args),'--json'],{stdio:['ignore','pipe','pipe']});let stdout='',failure:string|undefined;
  const kill=()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),750);};let killTimer:ReturnType<typeof setTimeout>|undefined;
  const timer=setTimeout(()=>{failure='CLI_TIMEOUT';kill();},25000);
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>262144&&!failure){failure='CLI_OUTPUT_LIMIT';kill();}});child.stderr.resume();
  child.once('error',()=>{clearTimeout(timer);clearTimeout(killTimer);fail(Error('CLI_START_FAILED'));});
  child.once('close',code=>{clearTimeout(timer);clearTimeout(killTimer);try{if(failure)throw Error(failure);const data=JSON.parse(stdout);if(data.error)throw Error(String(data.error.code));if(code)throw Error('CLI_EXIT_FAILED');done(data);}catch(error){fail(Error(safeError(error)));}});
 });
}
class FaultBrowser extends BrowserAdapter{
 scenario?:Scenario;injected=false;physicalCalls=0;readonly pages=new Map<string,Page>();
 constructor(origin:string){const pages=new Map<string,Page>();super(origin,{projection:'rich',onPage:(id,page)=>pages.set(id,page)});this.pages=pages;}
 override async validate(...args:Parameters<BrowserAdapter['validate']>){
  if(!this.injected&&['dom_replace','stale_validation'].includes(this.scenario??'')){
   this.injected=true;
   if(this.scenario==='stale_validation')return false;
   await this.pages.get(args[0])!.locator(`[data-ref="${args[2].target_ref}"]`).evaluate(el=>el.replaceWith(el.cloneNode(true)));
  }
  return super.validate(...args);
 }
 override async execute(...args:Parameters<BrowserAdapter['execute']>){await super.execute(...args);this.physicalCalls++;if(this.scenario==='lost_response')throw Error('LOST_RESPONSE_AFTER_EXECUTION');}
 override async close(id:string){try{await super.close(id);}finally{this.pages.delete(id);}}
}
export async function runStability(argv:string[]){
 const wallStart=performance.now();
 const {values}=parseArgs({args:argv,options:{out:{type:'string'},state:{type:'string'},approval:{type:'string'},'key-file':{type:'string'},live:{type:'boolean'},mock:{type:'boolean'},faults:{type:'boolean'},smoke:{type:'boolean'}},strict:true});
 if(!values.out||[values.live,values.mock,values.faults].filter(Boolean).length!==1)throw Error('EXPLICIT_MODE_REQUIRED');
 const live=values.live===true,faults=values.faults===true;
 if((live&&(!values.state||!values.approval||!values['key-file']))||(!live&&(values.approval||values['key-file']))||(faults&&values.smoke))throw Error('STABILITY_ARGUMENTS_INVALID');
 const out=resolve(values.out);if(existsSync(out))throw Error('OUTPUT_ALREADY_EXISTS');
 const state=values.state?resolve(values.state):mkdtempSync(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'jev-stability-'));
 if(state===out||state.startsWith(out+'/'))throw Error('STATE_MUST_BE_PRIVATE');
 let approval:ReturnType<typeof validateStabilityApproval>|undefined;
 if(live){privateExisting(state,true);privateExisting(join(state,'gateway.sqlite'),false);privateExisting(resolve(values.approval!),false);if(realpathSync(dirname(resolve(values.approval!)))!==realpathSync(state))throw Error('APPROVAL_STATE_MISMATCH');approval=validateStabilityApproval(await readPrivateJson(resolve(values.approval!)));}
 const plan=faults?faultPlan():normalPlan();const rows:Array<Record<string,unknown>>=plan.map(item=>({...item,scenario:item.scenario??'normal',projection:'rich',status:'NOT_RUN'}));
 let portProbe:ReturnType<typeof createTcpServer>|undefined;
 let lock:number|undefined,store:GatewayStore|undefined,server:ReturnType<typeof createDecisionGateway>|undefined,certs:ReturnType<typeof makeRemoteCertificates>|undefined,fixture:FixtureServer|undefined,browser:FaultBrowser|undefined,engine:Engine|undefined,service:Coordinator|undefined,mcp:Client|undefined;
 let active='setup',scenario:Scenario|undefined,stopReason:string|undefined,outputCreated=false,providerStarted:undefined|(()=>void),budgetBefore:unknown,budgetAfter:unknown,revoked=false;
 const cleanup:Record<string,boolean>={},traces:Record<string,unknown[]>={},events:Record<string,EngineEvent[]>={},calls:number[]=[];
 const observer=createAttemptObserver(fetch,()=>{if(outputCreated)save(join(out,'attempts.json'),observer.attempts);},()=>active,code=>{if(code!=='UPSTREAM_TRANSPORT_UNKNOWN')stopReason??=code;});
 const persist=()=>{save(join(out,'rows.json'),rows);save(join(out,'traces.json'),traces);save(join(out,'events.json'),events);};
 const identity={owner_id:'stability-owner',device_id:'local-mac',agent_id:'stability-agent'};
 try{
  if(!live){mkdirSync(out,{mode:0o700});outputCreated=true;mkdirSync(state,{recursive:true,mode:0o700});}
  lock=openSync(join(state,'stability.lock'),'wx',0o600);
  if(existsSync(join(state,'stability-started.json')))throw Error('STABILITY_ALREADY_STARTED');
  store=new GatewayStore(state);
  if(live){budgetBefore=store.budget(approval!.approval.approval_id);if(canonicalJson((budgetBefore as {approval:unknown}).approval)!==canonicalJson(approval!.approval))throw Error('APPROVAL_MISMATCH');}
  if(live){mkdirSync(out,{mode:0o700});outputCreated=true;}
  writeFileSync(join(state,'stability-started.json'),JSON.stringify({started_at:new Date().toISOString(),mode:live?'live':faults?'faults':'mock',approval_id:approval?.approval.approval_id??null,output:out}),{mode:0o600,flag:'wx'});
  persist();save(join(out,'attempts.json'),[]);
  const keys=generateKeyPairSync('ed25519');certs=makeRemoteCertificates();
  const expiresAt=Math.min(approval?.authorization.expires_at??Date.now()+3500000,Date.now()+3500000);
  store.enroll({...identity,certificate_sha256:certificateSha256(certs.a.cert),expires_at:expiresAt});
  const baseline=new MockProvider();const controlled:DecisionProvider={decide:async(input,context)=>{
   const fault=scenario;providerStarted?.();
   if(fault==='model_delay'||fault==='cancel_pending')await delay(2300,undefined,{signal:context.signal});
   const result=await baseline.decide(input,context);if(fault==='low_confidence')result.confidence=.6;return result;
  }};
  server=createDecisionGateway({tls:{...certs.server,ca:certs.ca},store,receiptPrivateKey:keys.privateKey,tokenPublicKey:keys.publicKey,issuer:'stability',audience:'executor',...(live?{live:{key:(await readPrivateFile(resolve(values['key-file']!))).toString().trim(),authorization:approval!.authorization,approval:approval!.approval,transport:observer.transport}}:{mockProvider:controlled})});
  server.listen(0,'127.0.0.1');await bounded(once(server,'listening'),5000);const port=(server.address() as {port:number}).port;
  const token=mintAgentToken({issuer:'stability',audience:'executor',identity,certificate_sha256:certificateSha256(certs.a.cert),scope:'decide:synthetic',issued_at_ms:Date.now()-10,expires_at_ms:expiresAt},keys.privateKey);
  const remote=new RemoteDecisionProvider({url:`https://127.0.0.1:${port}`,...certs.a,ca:certs.ca,token});
  const closedPortServer=portProbe=createTcpServer();closedPortServer.listen(0,'127.0.0.1');await once(closedPortServer,'listening');const closedPort=(closedPortServer.address() as {port:number}).port;await new Promise<void>((done,fail)=>closedPortServer.close(error=>error?fail(error):done()));
  const unreachable=new RemoteDecisionProvider({url:`https://127.0.0.1:${closedPort}`,...certs.a,ca:certs.ca,token});
  const provider:DecisionProvider={decide:async(input,context)=>{
   calls.push(Date.now());const normalized={goal:input.goal,summary:JSON.parse(input.summary),candidates:input.candidates.map((candidate,index)=>({index,description:candidate.description}))};
   traces[active]!.push({sequence:traces[active]!.length+1,sha256:createHash('sha256').update(canonicalJson(normalized)).digest('hex'),input:normalized});
   const response=await (scenario==='gateway_unreachable'?unreachable:remote).decide(input,context);
   return response;
  }};
  fixture=await FixtureServer.start();browser=new FaultBrowser(fixture.origin);const runtime=join(state,'runtime');
  engine=await Engine.create({storageDir:join(runtime,'ledger'),browser,provider,clients:['a'],confidenceThreshold:.9,onEvent:event=>events[active]?.push(event),remotePolicy:{publicKey:keys.publicKey,issuer:'stability',audience:'executor',identity,enforcementMode:live?'required_jev':'test_mock'}});
  service=await Coordinator.start({runtimeDir:runtime,engine,clients:['a']});
  mcp=new Client({name:'stability-matrix',version:'1'});await bounded(mcp.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../src/mcp/index.js',import.meta.url)),'--credential',join(runtime,'client-a.json')],stderr:'ignore'})),10000);
  async function call(entry:Entry,name:string,args:Record<string,unknown>):Promise<Record<string,unknown>>{
   if(entry==='direct')switch(name){case'open_session':return engine!.openSession('a',args);case'run_goal':return {...await engine!.runGoal('a',args)};case'status':return {...await engine!.status('a',args)};case'cancel':return engine!.cancel('a',args);case'close_session':return engine!.closeSession('a',args);}
   if(entry==='cli')return cli(join(runtime,'client-a.json'),name,args);
   const result=await mcp!.callTool({name:'jev.'+name,arguments:args},undefined,{timeout:25000});const data=JSON.parse((result.content as Array<{text:string}>)[0]!.text);if(result.isError)throw Error(String(data.code));return data;
  }
  for(const [index,item] of plan.entries()){
   if(stopReason||(values.smoke&&index>=3))break;
   if(live){const budget=store.budget(approval!.approval.approval_id);if(Date.now()>=approval!.authorization.expires_at){stopReason='AUTHORIZATION_EXPIRED';break;}if(budget.requests>=300||budget.reserved_usd+.003>1){stopReason='BUDGET_EXHAUSTED';break;}}
   // The production gateway admits 60 requests/min/principal. Reserve room for
   // an entire eight-step goal and stale recovery before opening its snapshot.
   const pauseStart=performance.now();
   while(calls.filter(time=>Date.now()-time<60000).length>44){await delay(Math.min(1000,Math.max(1,60010-(Date.now()-calls.find(time=>Date.now()-time<60000)!))));if(live&&Date.now()>=approval!.authorization.expires_at){stopReason='AUTHORIZATION_EXPIRED';break;}}
   if(stopReason)break;
   active=item.id;scenario=item.scenario;browser.scenario=scenario;browser.injected=false;providerStarted=undefined;traces[active]=[];events[active]=[];
   const row:Record<string,unknown>={...item,scenario:item.scenario??'normal',projection:'rich',status:'ERROR',started_at:new Date().toISOString(),attempts_before:observer.attempts.length};const started=performance.now();row.pace_wait_ms=performance.now()-pauseStart;let sid:string|undefined,duplicateMs=0;
   const actions=()=>Object.values(engine!.ledger.state.actions).filter(action=>action.session_id===sid).map(action=>({status:action.status,route:action.receipt?.route??null}));
   const physicalBefore=browser.physicalCalls;
   try{
    const opened=performance.now();sid=String((await call(item.entry,'open_session',{fixture_id:'standard'})).session_id);row.open_ms=performance.now()-opened;
    const request={session_id:sid,goal_id:item.id,idempotency_key:item.id,goal:{task:item.task,language:item.language,seed:item.seed},success:{kind:'task_complete'},max_steps:item.max_steps,time_budget_ms:item.time_budget_ms};
    let pendingStarted:Promise<void>|undefined;if(scenario==='cancel_pending')pendingStarted=new Promise<void>(done=>{providerStarted=done;});
    const goalStart=performance.now(),running=call(item.entry,'run_goal',request);void running.catch(()=>{});
    if(pendingStarted){await bounded(pendingStarted,5000);row.cancel=await call(item.entry,'cancel',{session_id:sid,goal_id:item.id});}
    const result=await running;row.run_goal_ms=performance.now()-goalStart;row.result=result;row.status=result.status;row.steps=result.steps;
    const statusStart=performance.now();row.durable_status=await call(item.entry,'status',{session_id:sid,goal_id:item.id});row.status_ms=performance.now()-statusStart;
    if(scenario==='duplicate'||scenario==='lost_response'){
     const dupStart=performance.now(),beforeActions=actions().length,beforeCalls=browser.physicalCalls,beforeDecisions=store.stats().decisions;
     const repeated=await call(item.entry,'run_goal',request);duplicateMs=performance.now()-dupStart;
     row.idempotency={same_result:canonicalJson(result)===canonicalJson(repeated),no_extra_actions:actions().length===beforeActions&&browser.physicalCalls===beforeCalls,before_decisions:beforeDecisions,after_decisions:store.stats().decisions};
     if(scenario==='lost_response')try{await call(item.entry,'run_goal',{...request,goal_id:item.id+'-new',idempotency_key:item.id+'-new'});row.new_key_error='UNEXPECTED_SUCCESS';}catch(error){row.new_key_error=safeError(error);}
    }
    row.actions=actions();row.physical_actions=browser.physicalCalls-physicalBefore;
    if(!faults&&result.status==='UNKNOWN')stopReason='UNKNOWN_PHYSICAL_ACTION';
    if(!faults&&(row.actions as Array<{route:string}>).some(action=>action.route!==(live?'jev':'mock')))stopReason='UNEXPECTED_ACTION_ROUTE';
    if(!faults&&/UNAUTHENTICATED|FORBIDDEN|LIVE_NOT_AUTHORIZED|BUDGET_EXHAUSTED/.test(String(result.reason??'')))stopReason=String(result.reason);
   }catch(error){row.error=safeError(error);if(!faults)stopReason??=safeError(error);}
   finally{
    providerStarted=undefined;
    if(sid){const closeStart=performance.now();try{row.close=await call(item.entry,'close_session',{session_id:sid});}catch(error){row.close_error=safeError(error);stopReason??='SESSION_CLOSE_FAILED';}row.close_ms=performance.now()-closeStart;}
    row.actions??=actions();row.physical_actions??=browser.physicalCalls-physicalBefore;
    row.e2e_ms=performance.now()-started-duplicateMs;row.elapsed_ms=row.e2e_ms;
    const telemetryStart=performance.now();await observer.settle();row.telemetry_wait_ms=performance.now()-telemetryStart;row.attempts_after=observer.attempts.length;row.duplicate_ms=duplicateMs;row.phase_events=events[active];row.finished_at=new Date().toISOString();
    row.phase_ms=Object.fromEntries(['observe','candidate','policy','provider','execute','verify'].map(phase=>[phase,events[active]!.filter(event=>event.phase===phase).reduce((sum,event)=>sum+event.elapsed_ms,0)]));
    if(faults){row.expected_safe=true;row.safe_pass=faultVerdict(item.scenario!,row as unknown as VerdictInput);row.expected_pass=row.safe_pass;if(row.safe_pass!==true)stopReason??='FAULT_SAFETY_PROOF_FAILED';}
    rows[index]=row;persist();
   }
  }
 }catch(error){stopReason??=safeError(error);}
 finally{
  // Setup failures and cleanup failures cannot bypass any later release.
  const release=async(name:string,fn:()=>unknown)=>{try{await bounded(Promise.resolve().then(fn),10000);cleanup[name]=true;}catch{cleanup[name]=false;stopReason??=name.toUpperCase()+'_CLEANUP_FAILED';}};
  if(mcp)await release('mcp',()=>mcp!.close());
  if(service)await release('coordinator',()=>service!.close());
  else if(engine)await release('engine',()=>engine!.shutdown());
  if(browser)await release('browser',()=>browser!.shutdown());
  if(portProbe)await release('port_probe',()=>new Promise<void>(done=>portProbe!.close(()=>done())));
  if(fixture)await release('fixture',()=>fixture!.close());
  if(server)await release('gateway',()=>{server!.closeAllConnections();return new Promise<void>(done=>server!.close(()=>done()));});
  await release('observer',()=>observer.settle());
  if(store){try{if(live)budgetAfter=store.budget(approval!.approval.approval_id);store.revoke(identity);revoked=true;}catch{/* Enrollment might not exist after partial setup. */}await release('store',()=>store!.close());}
  if(certs)await release('certificates',()=>certs!.close());
  if(outputCreated){persist();save(join(out,'attempts.json'),observer.attempts);save(join(out,'summary.json'),{mode:live?'live':faults?'faults':'mock',projection:'rich',smoke:values.smoke===true,formal_planned:faults?0:108,formal_success_denominator:faults||values.smoke?0:108,reported_full_sample:!faults&&!values.smoke,formal_attempted:faults?0:rows.filter(row=>row.status!=='NOT_RUN').length,formal_succeeded:faults?0:rows.filter(row=>row.status==='SUCCEEDED').length,fault_planned:faults?48:0,fault_attempted:faults?rows.filter(row=>row.status!=='NOT_RUN').length:0,fault_safe_passed:faults?rows.filter(row=>row.safe_pass===true).length:0,stop_reason:stopReason??null,hosted_attempts_observed:observer.attempts.length,budget_before:budgetBefore??null,budget_after:budgetAfter??null,private_ledger_retained:existsSync(join(state,'runtime','ledger','ledger.json')),credentials_revoked:revoked,cleanup,total_wall_ms:performance.now()-wallStart,finished_at:new Date().toISOString()});}
  if(lock!==undefined){closeSync(lock);unlinkSync(join(state,'stability.lock'));}
 }
 if(stopReason)throw Error(stopReason);
 return {mode:live?'live':faults?'faults':'mock',attempted:rows.filter(row=>row.status!=='NOT_RUN').length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void runStability(process.argv.slice(2)).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(safeError(error)+'\n');process.exitCode=1;});
