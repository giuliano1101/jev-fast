/** Controlled facade comparison: one Engine/adapter/provider, only entry changes. */
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {FixtureServer} from '../../fixtures/server.js';
import {BrowserAdapter,type BrowserOptions} from '../../src/browser/adapter.js';
import {Engine} from '../../src/core/engine.js';
import {Coordinator} from '../../src/service/coordinator.js';
import {MockProvider} from '../../src/providers/mock.js';
import type {DecisionProvider,DecisionInput,Goal} from '../../src/core/contracts.js';
import {validateLedgerState} from '../../src/session/schema.js';
import {GatewayStore} from '../../src/remote/store.js';
import {createDecisionGateway} from '../../src/remote/gateway.js';
import {RemoteDecisionProvider} from '../../src/remote/client.js';
import {certificateSha256,mintAgentToken} from '../../src/remote/credentials.js';
import {readPrivateJson,readPrivateFile} from '../../src/service/config.js';
import {createAttemptObserver} from './pilot.js';
import {makeRemoteCertificates} from '../../tests/helpers/remote-fixture.js';
const {values}=parseArgs({options:{out:{type:'string'},projection:{type:'string'},live:{type:'boolean'},approval:{type:'string'},'key-file':{type:'string'},state:{type:'string'},'confidence-trace':{type:'boolean'},'medium-only':{type:'boolean'},'remaining-from':{type:'string'}},strict:true});
if(!values.out||!['legacy','rich'].includes(values.projection??''))throw Error('ARGUMENTS_REQUIRED');
const out=resolve(values.out),projection=values.projection!,live=values.live===true;
mkdirSync(out,{recursive:false,mode:0o700});
const root=live?resolve(values.state!):mkdtempSync(join(tmpdir(),'jev-parity-'));const certs=makeRemoteCertificates(),keys=generateKeyPairSync('ed25519');
const identity={owner_id:'parity-owner',device_id:'local-mac',agent_id:'entry-test'};
const store=new GatewayStore(root);let active='',callIndex=0;let fatal:string|undefined;
const rows:Array<Record<string,unknown>>=[];const traces:Record<string,unknown[]>={};
const save=()=>writeFileSync(join(out,'rows.json'),JSON.stringify(rows,null,2)+'\n');
const observer=createAttemptObserver(fetch,()=>writeFileSync(join(out,'attempts.json'),JSON.stringify(observer.attempts,null,2)+'\n'),()=>active,code=>{if(code!=='UPSTREAM_TRANSPORT_UNKNOWN'||!values['remaining-from'])fatal??=code;});
let approval:undefined|{authorization:import('../../src/providers/jev.js').LiveAuthorization;approval:import('../../src/remote/store.js').GatewayApproval};
const skipped=new Set<string>();
if(values['remaining-from']){
 if(!live)throw Error('LIVE_REQUIRED');
 const prior=JSON.parse(readFileSync(join(root,`parity-${projection}-started.json`),'utf8'));
 if(resolve(values['remaining-from'])!==join(prior.out,'rows.json'))throw Error('SOURCE_MISMATCH');
 const previous=JSON.parse(readFileSync(values['remaining-from'],'utf8')) as Array<{id:string;status:string}>;
 for(const row of previous){if(!/^(cancel|correction|form)-(direct|cli|mcp)$/.test(row.id)||row.status==='UNKNOWN'||skipped.has(row.id))throw Error('UNSAFE_PREVIOUS_RESULT');skipped.add(row.id);}
 const ledger=JSON.parse(readFileSync(join(root,'r-'+projection,'ledger','ledger.json'),'utf8'));
 validateLedgerState(ledger);
 if(Object.values(ledger.sessions).some(v=>!v.closed||v.quarantined)||Object.values(ledger.goals).some(v=>['UNKNOWN','RUNNING'].includes((v as {status:string}).status)))throw Error('UNSAFE_LEDGER');
}
if(live){
 if(!values.approval||!values['key-file']||!values.state)throw Error('LIVE_APPROVAL_REQUIRED');
 approval=await readPrivateJson(resolve(values.approval)) as typeof approval;
 if(!approval||approval.authorization.expires_at<=Date.now())throw Error('LIVE_NOT_AUTHORIZED');
 const previous=store.budget(approval.approval.approval_id);if(JSON.stringify(previous.approval)!==JSON.stringify(approval.approval))throw Error('APPROVAL_MISMATCH');
 writeFileSync(join(root,`parity-${projection}${values['remaining-from']?'-remaining':''}-started.json`),JSON.stringify({out,started_at:new Date().toISOString()}),{flag:'wx',mode:0o600});
}
const baseline=new MockProvider();
const controlled:DecisionProvider={decide:async(input,context)=>{const d=await baseline.decide(input,context);if(values['confidence-trace']){const sequence=input.goal.task==='cancel'?[1]:input.goal.task==='correction'?[.94,.70]:[.96,.94,.98,.74];d.confidence=sequence[Math.min(callIndex++,sequence.length-1)]!;}return d;}};
store.enroll({...identity,certificate_sha256:certificateSha256(certs.a.cert),expires_at:Date.now()+3600000});
const server=createDecisionGateway({tls:{...certs.server,ca:certs.ca},store,receiptPrivateKey:keys.privateKey,tokenPublicKey:keys.publicKey,issuer:'parity',audience:'executor',...(live?{live:{key:(await readPrivateFile(resolve(values['key-file']!))).toString().trim(),...approval!,transport:observer.transport}}:{mockProvider:controlled})});
server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as {port:number};
const token=mintAgentToken({issuer:'parity',audience:'executor',identity,certificate_sha256:certificateSha256(certs.a.cert),scope:'decide:synthetic',issued_at_ms:Date.now()-10,expires_at_ms:Date.now()+3500000},keys.privateKey);
const remote=new RemoteDecisionProvider({url:`https://127.0.0.1:${address.port}`,...certs.a,ca:certs.ca,token});
const provider:DecisionProvider={decide:async(input,context)=>{traces[active]!.push({goal:input.goal,summary:JSON.parse(input.summary),candidates:input.candidates.map((c:DecisionInput['candidates'][number])=>c.description)});return remote.decide(input,context);}};
const fixture=await FixtureServer.start(),browser=new BrowserAdapter(fixture.origin,{projection} as BrowserOptions);
const runtime=join(root,'r-'+projection+(values['confidence-trace']?'-trace':''));
const engine=await Engine.create({storageDir:join(runtime,'ledger'),browser,provider,clients:['a'],remotePolicy:{publicKey:keys.publicKey,issuer:'parity',audience:'executor',identity,enforcementMode:live?'required_jev':'test_mock'}});
const service=await Coordinator.start({runtimeDir:runtime,engine,clients:['a']});
const mcp=new Client({name:'entry-parity',version:'1'});await mcp.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/src/mcp/index.js'),'--credential',join(runtime,'client-a.json')],stderr:'ignore'}));
async function call(entry:string,name:string,args:Record<string,unknown>):Promise<Record<string,unknown>>{
 if(entry==='direct')switch(name){case'open_session':return engine.openSession('a',args);case'run_goal':return {...await engine.runGoal('a',args)};case'status':return {...await engine.status('a',args)};case'close_session':return engine.closeSession('a',args);}
 if(entry==='mcp'){const r=await mcp.callTool({name:'jev.'+name,arguments:args});const data=JSON.parse((r.content as Array<{text:string}>)[0]!.text);if(r.isError)throw Error(data.code);return data;}
 return new Promise((done,fail)=>{const child=spawn(process.execPath,[resolve('dist/src/cli/index.js'),name,'--credential',join(runtime,'client-a.json'),'--args',JSON.stringify(args),'--json'],{stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',d=>text+=d);child.stderr.resume();child.on('error',fail);child.on('close',code=>{try{const value=JSON.parse(text);if(code||value.error)throw Error('CLI_ERROR');done(value);}catch(e){fail(e);}});});
}
try{
 const tasks:Goal['task'][]=values['medium-only']?['correction']:['cancel','correction','form'];
 const entries=['direct','cli','mcp'];
 trials: for(const [taskIndex,task] of tasks.entries())for(const entry of [...entries.slice(taskIndex%3),...entries.slice(0,taskIndex%3)]){
  if(fatal)break trials;
  active=task+'-'+entry;if(skipped.has(active))continue;callIndex=0;traces[active]=[];const start=performance.now();let sid:string|undefined;
  const row:Record<string,unknown>={id:active,task,entry,projection,seed:707};
  try{
   sid=String((await call(entry,'open_session',{fixture_id:'standard'})).session_id);
   const result=await call(entry,'run_goal',{session_id:sid,goal_id:active,idempotency_key:active,goal:{task,language:'en',seed:707},success:{kind:'task_complete'},max_steps:task==='cancel'?1:task==='correction'?3:4,time_budget_ms:15000});
   row.result=result;row.status=result.status;if(result.status==='UNKNOWN')fatal='UNKNOWN_ACTION';row.actions=Object.values(engine.ledger.state.actions).filter(a=>a.session_id===sid).map(a=>({status:a.status,route:a.receipt?.route}));
  }catch(e){row.status='ERROR';row.error=e instanceof Error&&/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:'ERROR';fatal??=String(row.error);}
  finally{if(sid)try{await call(entry,'close_session',{session_id:sid});}catch{fatal??='CLOSE_FAILED';row.cleanup_error='CLOSE_FAILED';}await observer.settle();row.elapsed_ms=performance.now()-start;rows.push(row);save();}
 }
}finally{
 const cleanupErrors:string[]=[];for(const [name,fn] of [['mcp',()=>mcp.close()],['service',()=>service.close()],['browser',()=>browser.shutdown()],['fixture',()=>fixture.close()],['gateway',async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}],['revoke',async()=>{store.revoke(identity);}] ] as const){try{await fn();}catch{cleanupErrors.push(name);}}
 writeFileSync(join(out,'traces.json'),JSON.stringify(traces,null,2)+'\n');
 writeFileSync(join(out,'summary.json'),JSON.stringify({skipped_previous:[...skipped],planned:values['medium-only']?3:9,live,projection,stop_reason:fatal??null,cleanup_errors:cleanupErrors,confidence_trace:values['confidence-trace']??false,success:rows.filter(r=>r.status==='SUCCEEDED').length,total:rows.length,budget:live?store.budget(approval!.approval.approval_id):null,attempts:observer.attempts.length},null,2)+'\n');
 store.close();certs.close();if(!live)rmSync(root,{recursive:true,force:true});
}
console.log(JSON.stringify(rows.map(r=>({id:r.id,status:r.status}))));
