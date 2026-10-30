import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../../src/session/ledger.js';
import type {LedgerState} from '../../src/core/contracts.js';
const state=():LedgerState=>({version:2,sessions:{s:{owner:'a',fixture_id:'standard',allowed_origin:'http://127.0.0.1:1234',epoch:1,quarantined:false,closed:false}},goals:{'s:g':{session_id:'s',goal_id:'g',idempotency_key:'k',request_hash:'hash',status:'SUCCEEDED',steps:1,elapsed_ms:1,reason:null,evidence:['POSTCONDITION_VERIFIED'],action_ids:['a']}},actions:{a:{action_id:'a',session_id:'s',goal_id:'g',lease_epoch:1,idempotency_key:'k',request_hash:'hash',snapshot_id:'snap',candidate_id:'c',policy_version:'p0-v1',status:'SUCCEEDED',created_at:1,updated_at:2}}});
async function withDir(fn:(dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'jev-ledger-validation-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('persisted malformed record and missing references fail closed without replacing evidence',async()=>{
 const corruptions:Array<(s:LedgerState)=>void>=[s=>{s.sessions.s!.closed='false' as unknown as boolean;},s=>{s.goals['s:g']!.status='INVENTED' as never;},s=>{delete s.sessions.s;},s=>{s.goals['s:g']!.action_ids=['missing'];},s=>{s.actions.a!.goal_id='missing';},s=>{s.actions.a!.request_hash='different';},s=>{s.actions.a!.action_id='different';},s=>{s.goals.other={...s.goals['s:g']!,goal_id:'other',action_ids:[]};}];
 for(const corrupt of corruptions)await withDir(async dir=>{const value=state();corrupt(value);const text=JSON.stringify(value);await writeFile(join(dir,'ledger.json'),text);let opened:Ledger|undefined;try{await assert.rejects(async()=>{opened=await Ledger.open(dir);},/STORAGE_CORRUPT/);assert.equal(await readFile(join(dir,'ledger.json'),'utf8'),text);}finally{await opened?.close();}});
});
test('truncation, unexpected fields and future versions fail closed',async()=>{
 for(const text of ['{',JSON.stringify({...state(),version:99}),JSON.stringify({...state(),unexpected:'private'})])await withDir(async dir=>{await writeFile(join(dir,'ledger.json'),text);let opened:Ledger|undefined;try{await assert.rejects(async()=>{opened=await Ledger.open(dir);},/STORAGE_CORRUPT/);}finally{await opened?.close();}});
});
test('invalid transaction cannot mutate persisted state or in-memory state',async()=>withDir(async dir=>{const ledger=await Ledger.open(dir);try{const before=await readFile(join(dir,'ledger.json'),'utf8');await assert.rejects(ledger.transaction(s=>{s.actions.a=state().actions.a!;}),/STORAGE_CORRUPT/);assert.deepEqual(ledger.state.actions,{});assert.equal(await readFile(join(dir,'ledger.json'),'utf8'),before);}finally{await ledger.close();}}));
test('idempotency index survives transactions and reopen without leaking mutable records',async()=>withDir(async dir=>{
 let ledger=await Ledger.open(dir);
 const lookup=(value:Ledger)=>(value as Ledger&{findGoal?:(session:string,key:string)=>LedgerState['goals'][string]}).findGoal;
 try{assert.equal(typeof lookup(ledger),'function');await ledger.transaction(s=>Object.assign(s,state()));const found=lookup(ledger)!.call(ledger,'s','k');assert.equal(found?.goal_id,'g');found!.status='UNKNOWN';assert.equal(ledger.state.goals['s:g']!.status,'SUCCEEDED');await ledger.close();ledger=await Ledger.open(dir);assert.equal(lookup(ledger)!.call(ledger,'s','k')?.goal_id,'g');assert.equal(lookup(ledger)!.call(ledger,'other','k'),undefined);}finally{await ledger.close();}
}));
test('goal dictionary keys must match the public session and goal lookup identity',async()=>withDir(async dir=>{const value=state();value.goals.arbitrary=value.goals['s:g']!;delete value.goals['s:g'];const text=JSON.stringify(value);await writeFile(join(dir,'ledger.json'),text);let opened:Ledger|undefined;try{await assert.rejects(async()=>{opened=await Ledger.open(dir);},/STORAGE_CORRUPT/);assert.equal(await readFile(join(dir,'ledger.json'),'utf8'),text);}finally{await opened?.close();}}));
test('ambiguous post-rename fsync failure fences subsequent writes',async t=>withDir(async dir=>{
 const {open}=await import('node:fs/promises');const ledger=await Ledger.open(dir);const probe=await open(join(dir,'probe'),'w');
 const prototype=Object.getPrototypeOf(probe) as {sync:()=>Promise<void>};const sync=prototype.sync;
 const mocked=t.mock.method(prototype,'sync',async function(this:import('node:fs/promises').FileHandle){if((await this.stat()).isDirectory())throw Error('injected directory sync failure');await sync.call(this);});
 try{await assert.rejects(ledger.transaction(s=>Object.assign(s,state())));mocked.mock.restore();const persisted=await readFile(join(dir,'ledger.json'),'utf8');await assert.rejects(ledger.transaction(s=>{s.sessions={};s.goals={};s.actions={};}),/STORAGE_WRITE_UNCERTAIN/);assert.equal(await readFile(join(dir,'ledger.json'),'utf8'),persisted);}finally{mocked.mock.restore();await probe.close();await ledger.close();}
}));
test('ledger close retries lock removal after partial cleanup failure',{skip:process.getuid?.()===0},async()=>withDir(async dir=>{
 const {chmod,stat}=await import('node:fs/promises');const ledger=await Ledger.open(dir);
 try{await chmod(dir,0o500);await assert.rejects(ledger.close());await chmod(dir,0o700);await ledger.close();await assert.rejects(stat(join(dir,'owner.lock')),{code:'ENOENT'});}finally{await chmod(dir,0o700);await ledger.close();}
}));
test('legacy ledger upgrades atomically to receipt-aware version and preserves idempotency',async()=>withDir(async dir=>{await writeFile(join(dir,'ledger.json'),JSON.stringify({...state(),version:1}));const ledger=await Ledger.open(dir);try{assert.equal(ledger.state.version,2);assert.equal(ledger.findGoal('s','k')?.goal_id,'g');assert.equal(JSON.parse(await readFile(join(dir,'ledger.json'),'utf8')).version,2);}finally{await ledger.close();}}));
