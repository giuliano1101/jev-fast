import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RealBrowserJournal} from '../../src/browser/real-journal.js';
import {RealBrowserService} from '../../src/browser/real.js';
import {canonicalDigest} from '../../src/remote/protocol.js';
import {realBrowserSchemas} from '../../src/browser/real-contracts.js';
test('pending physical execution survives process recovery as UNKNOWN without replay',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-real-journal-'));const args={session_id:'lost-session',snapshot_id:'snap',idempotency_key:'key',task:'Navigate',actions:[{id:'go',operation:'navigate',url:'https://example.org/arbitrary'}]},key=canonicalDigest({client:'owner',session_id:args.session_id,idempotency_key:args.idempotency_key});
 const journal=await RealBrowserJournal.open(dir);await journal.begin(key,{owner:'owner',session_id:args.session_id,digest:canonicalDigest(args)});await journal.close();
 const service=new RealBrowserService({storageDir:dir,chooseAction:async()=>{throw new Error('must not choose');}});
 try{assert.deepEqual(await service.act('owner',args),{execution:'unknown',reason:'PROCESS_RESTART'});await assert.rejects(service.act('owner',{...args,task:'Different task'}),/IDEMPOTENCY_CONFLICT/);}finally{await service.shutdown();await rm(dir,{recursive:true,force:true});}
});
test('real browser contract accepts arbitrary normal URLs and uncapped caller timeouts but never code/selector execution',()=>{
 assert.equal(realBrowserSchemas.browser_open.safeParse({url:'https://arbitrary.example.net/not-a-fixture?x=1#section'}).success,true);
 for(const url of ['file:///etc/passwd','javascript:alert(1)','data:text/html,unsafe'])assert.equal(realBrowserSchemas.browser_open.safeParse({url}).success,false);
 const base={session_id:'s',snapshot_id:'snap',idempotency_key:'k',task:'Any real task',actions:[{id:'x',operation:'fill',control_id:'bound',value:'completely arbitrary value'}],timeout_ms:Number.MAX_SAFE_INTEGER};
 assert.equal(realBrowserSchemas.browser_act.safeParse(base).success,true);assert.equal(realBrowserSchemas.browser_act.safeParse({...base,selector:'button'}).success,false);assert.equal(realBrowserSchemas.browser_act.safeParse({...base,actions:[{id:'x',operation:'evaluate',code:'anything'}]}).success,false);
});
