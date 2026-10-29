import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile,chmod,mkdir,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {Engine} from '../../src/core/engine.js';
import {MockProvider} from '../../src/providers/mock.js';
import type {BrowserPort} from '../../src/core/contracts.js';
import {Coordinator} from '../../src/service/coordinator.js';
import {ipcCall,readCredential} from '../../src/service/ipc.js';

const browser:BrowserPort={async open(){return {allowed_origin:'http://127.0.0.1:9999'};},async observe(){throw new Error('SECRET_CANARY');},async validate(){return false;},async execute(){},async check(){return false;},async close(){}};
async function fixture(options:{transportTimeoutMs?:number;onStop?:()=>Promise<void>}={}){
 const dir=await mkdtemp('/tmp/jev-ipc-');const engine=await Engine.create({storageDir:join(dir,'ledger'),browser,provider:new MockProvider(),clients:['a','b']});
 let service:Coordinator|undefined;
 try{await assert.doesNotReject(async()=>{service=await Coordinator.start({runtimeDir:join(dir,'run'),engine,clients:['a','b'],...options});},'coordinator must start');}
 catch(error){await engine.shutdown();await rm(dir,{recursive:true,force:true});throw error;}
 return {dir,engine,service:service!,a:await readCredential(join(dir,'run/client-a.json')),b:await readCredential(join(dir,'run/client-b.json')),async cleanup(){await service!.close();await rm(dir,{recursive:true,force:true});}};
}
test('private IPC credentials bind identities and prevent cross-client reads and operator escalation',async()=>{
 const f=await fixture();try{
  for(const [path,mode] of [['run',0o700],['run/coordinator.sock',0o600],['run/client-a.json',0o600],['run/client-b.json',0o600],['run/operator.json',0o600]] as const)assert.equal((await stat(join(f.dir,path))).mode&0o777,mode);
  assert.notEqual(f.a.token,f.b.token);assert.match(f.a.token,/^[0-9a-f]{64}$/);
  await assert.rejects(ipcCall({...f.a,token:'0'.repeat(64)},'jev.open_session',{fixture_id:'standard'}),/UNAUTHORIZED/);
  const opened=await ipcCall(f.a,'jev.open_session',{fixture_id:'standard'}) as {session_id:string};
  await assert.rejects(ipcCall(f.b,'jev.observe',{session_id:opened.session_id}),/UNAUTHORIZED/);
  await assert.rejects(ipcCall(f.a,'service.stop',{}),/UNAUTHORIZED/);
  await assert.rejects(ipcCall(f.a,'jev.open_session',{fixture_id:'standard',client_id:'b'}),/INVALID_ARGUMENTS/);
  await assert.rejects(ipcCall(f.a,'jev.observe',{session_id:opened.session_id}),/^Fault: INTERNAL_FAILURE$/);
  await assert.rejects(ipcCall(f.a,'jev.shell',{}),/UNKNOWN_METHOD/);
  assert.equal((await ipcCall(f.a,'jev.status',{session_id:opened.session_id}) as {closed:boolean}).closed,false);
  assert.equal((await ipcCall(f.a,'jev.close_session',{session_id:opened.session_id}) as {closed:boolean}).closed,true);
  const ledger=await readFile(join(f.dir,'ledger/ledger.json'),'utf8');assert.ok(!ledger.includes(f.a.token));assert.ok(!ledger.includes('SECRET_CANARY'));
 }finally{await f.cleanup();}
});
test('oversized frames are rejected before JSON parsing and credential permissions are checked',async()=>{
 const f=await fixture();try{
  await assert.rejects(ipcCall(f.a,'jev.open_session',{padding:'x'.repeat(65536)}),/FRAME_TOO_LARGE/);
  const reply=await new Promise<string>((resolve,reject)=>{const socket=createConnection(f.a.socket);let text='';socket.setTimeout(2000,()=>socket.destroy(new Error('TIMEOUT')));socket.on('connect',()=>socket.write('x'.repeat(65537)));socket.on('data',chunk=>text+=chunk.toString());socket.on('end',()=>resolve(text));socket.on('error',reject);});
  assert.equal(JSON.parse(reply).error.code,'FRAME_TOO_LARGE');
  await chmod(join(f.dir,'run/client-a.json'),0o644);await assert.rejects(readCredential(join(f.dir,'run/client-a.json')),/UNSAFE_CREDENTIAL/);
 }finally{await f.cleanup();}
});
test('a second coordinator cannot rotate active credentials or unlink the running socket',async()=>{
 const f=await fixture();try{await assert.rejects(Coordinator.start({runtimeDir:join(f.dir,'run'),engine:f.engine,clients:['a','b']}),/SERVICE_ALREADY_RUNNING/);assert.deepEqual(await readCredential(join(f.dir,'run/client-a.json')),f.a);assert.equal((await ipcCall(f.a,'service.health',{}) as {ready:boolean}).ready,true);}finally{await f.cleanup();}
});

test('failed startup preserves pre-existing credential files and removes only files it created',async()=>{
 const f=await fixture();const runtime=join(f.dir,'stale');try{
  await mkdir(runtime,{mode:0o700});await writeFile(join(runtime,'client-b.json'),'sentinel',{mode:0o600});
  await assert.rejects(Coordinator.start({runtimeDir:runtime,engine:f.engine,clients:['a','b']}));
  assert.equal(await readFile(join(runtime,'client-b.json'),'utf8'),'sentinel');
  await assert.rejects(access(join(runtime,'client-a.json')));await assert.rejects(access(join(runtime,'service.lock')));
 }finally{await f.cleanup();}
});

test('an absolute connection deadline bounds slow incomplete frames',async()=>{
 const f=await fixture({transportTimeoutMs:100});try{
  const elapsed=await new Promise<number>((resolve,reject)=>{
   const start=Date.now();const socket=createConnection(f.a.socket);
   const trickle=setInterval(()=>socket.write(' '),20);const watchdog=setTimeout(()=>socket.destroy(),450);
   socket.on('error',reject);socket.on('close',()=>{clearInterval(trickle);clearTimeout(watchdog);resolve(Date.now()-start);});
  });assert.ok(elapsed<350,`deadline exceeded: ${elapsed}ms`);
 }finally{await f.cleanup();}
});
test('shutdown still releases browser/fixture resources when engine shutdown fails',async()=>{
 let cleaned=false;const f=await fixture({onStop:async()=>{cleaned=true;}});const shutdown=f.engine.shutdown.bind(f.engine);
 f.engine.shutdown=async()=>{await shutdown();throw new Error('synthetic shutdown failure');};
 try{await assert.rejects(f.service.close(),/synthetic shutdown failure/);assert.equal(cleaned,true);await assert.rejects(access(join(f.dir,'run/service.lock')));}
 finally{await rm(f.dir,{recursive:true,force:true});}
});
