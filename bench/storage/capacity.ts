import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {Ledger} from '../../src/session/ledger.js';
import {validateLedgerState} from '../../src/session/schema.js';
import type {LedgerState} from '../../src/core/contracts.js';
const samples=[];
for(const n of [10000,100000]){
 const state:LedgerState={version:2,sessions:{s:{owner:'benchmark',fixture_id:'standard',allowed_origin:'http://127.0.0.1:1234',epoch:1,quarantined:false,closed:false}},goals:{},actions:{}};
 for(let i=0;i<n;i++){const goal=`g${i}`,action=`a${i}`,key=`k${i}`;state.goals[`s:${goal}`]={session_id:'s',goal_id:goal,idempotency_key:key,request_hash:'a'.repeat(64),status:'SUCCEEDED',steps:1,elapsed_ms:10,reason:null,evidence:['POSTCONDITION_VERIFIED'],action_ids:[action]};state.actions[action]={action_id:action,session_id:'s',goal_id:goal,lease_epoch:1,idempotency_key:key,request_hash:'a'.repeat(64),snapshot_id:`snap${i}`,candidate_id:`candidate${i}`,policy_version:'p0-v1',status:'SUCCEEDED',created_at:1,updated_at:2};}
 const directory=await mkdtemp(join(tmpdir(),'jev-capacity-'));let ledger:Ledger|undefined;
 try{
  const started=performance.now();validateLedgerState(state);const validate_ms=performance.now()-started;
  await writeFile(join(directory,'ledger.json'),JSON.stringify(state));const bytes=(await stat(join(directory,'ledger.json'))).size;
  const opening=performance.now();ledger=await Ledger.open(directory);const open_recovery_ms=performance.now()-opening;
  const transaction=performance.now();await ledger.transaction(s=>{s.sessions.s!.closed=true;});const transaction_ms=performance.now()-transaction;
  const lookup=performance.now();for(let i=0;i<10000;i++)if(!ledger.findGoal('s',`k${i%n}`))throw Error('INDEX_MISSING');const lookup_10000_ms=performance.now()-lookup;
  const result={history_actions:n,bytes,validate_ms,open_recovery_ms,transaction_ms,lookup_10000_ms,rss_bytes:process.memoryUsage().rss};samples.push(result);console.log(JSON.stringify(result));
 }finally{await ledger?.close();await rm(directory,{recursive:true,force:true});}
}
await writeFile('artifacts/cross-machine/ledger-capacity.json',JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,method:'One validation, one reopen/recovery transaction, one mutation, 10000 indexed reads per size. No paid API. RSS includes prior samples; not isolated peak.',samples},null,2)+'\n');
