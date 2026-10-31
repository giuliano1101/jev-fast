import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {makeRemoteCertificates} from '../helpers/remote-fixture.js';
import {startManualNetworkServer} from '../../src/network/manual-server.js';
import {until} from '../helpers/network-fixture.js';
test('manual connector registers a fresh disabled handle and reconnecting process cannot inherit its admission',async()=>{
 const path='../../src/network/manual-connector.js',api=await import(path).catch(()=>({}));assert.equal(typeof api.startManualConnector,'function','manual connector missing');
 const root=await mkdtemp(join(tmpdir(),'jev-admission-connector-')),certs=makeRemoteCertificates();
 const relay=await startManualNetworkServer({host:'127.0.0.1',port:0,allowedOrigins:[],deviceId:'d',agentId:'a',storeDir:join(root,'relay'),tls:certs.server});
 const options={url:relay.url,name:'my Mac',deviceId:'d',agentId:'a',journalDir:join(root,'connector'),credentialFile:join(root,'missing','client-a.json'),ca:certs.ca,pollMs:25};
 await mkdir(join(root,'missing'),{mode:0o700});
 let connector=await api.startManualConnector(options);
 try{
  const first=await until<string>(async()=>connector.registrationId()??'',Boolean);assert.equal(relay.registry.get(first).enabled,false);
  relay.registry.setEnabled(first,true);await connector.stop();connector=await api.startManualConnector(options);
  const next=await until<string>(async()=>connector.registrationId()??'',Boolean);assert.notEqual(next,first);assert.equal(relay.registry.get(next).enabled,false);
 }finally{await connector.stop();await relay.close();certs.close();await rm(root,{recursive:true,force:true});}
});
test('one manual connector per local runtime prevents a second journal from revoking the active owner',async()=>{
 const path='../../src/network/manual-connector.js',{startManualConnector}=await import(path);const {Engine}=await import('../../src/core/engine.js');const {Coordinator}=await import('../../src/service/coordinator.js');const {MockProvider}=await import('../../src/providers/mock.js');
 const root=await mkdtemp('/tmp/jev-lock-'),runtime=join(root,'runtime'),certs=makeRemoteCertificates();
 const browser={async open(){return {allowed_origin:'http://127.0.0.1:7777'};},async close(){},async observe():Promise<never>{throw new Error('unexpected observe');},async validate():Promise<boolean>{throw new Error('unexpected validate');},async execute(){throw new Error('unexpected execute');},async check():Promise<boolean>{throw new Error('unexpected check');}};
 const engine=await Engine.create({storageDir:join(root,'ledger'),browser,provider:new MockProvider(),clients:['a']});const coordinator=await Coordinator.start({runtimeDir:runtime,engine,clients:['a']});
 const relay=await startManualNetworkServer({host:'127.0.0.1',port:0,allowedOrigins:[],deviceId:'d',agentId:'a',storeDir:join(root,'relay'),tls:certs.server});
 const options={url:relay.url,name:'first process',deviceId:'d',agentId:'a',journalDir:join(root,'first-journal'),credentialFile:join(runtime,'client-a.json'),ca:certs.ca,pollMs:25};
 const first=await startManualConnector(options);let second:Awaited<ReturnType<typeof startManualConnector>>|undefined;
 try{
  const device=await until(async()=>relay.registry.list().find(row=>row.type==='device'&&row.localInstance!==null),Boolean);relay.registry.setEnabled(device!.id,true);await until(async()=>relay.store.status(),row=>row.local_ready);
  const ai=relay.registry.register('ai','AI');relay.registry.setEnabled(ai.id,true);const owner=relay.registry.get(ai.id).owner!;
  const opened=await until(async()=>{try{return await engine.openSession(owner,{fixture_id:'standard'});}catch(error){if(String(error).includes('UNAUTHORIZED'))return null;throw error;}},Boolean);const session_id=opened!.session_id;
  await assert.rejects(async()=>{second=await startManualConnector({...options,name:'second process',journalDir:join(root,'second-journal')});},/CONNECTOR_ALREADY_RUNNING/);
  assert.equal(relay.registry.list().filter(row=>row.type==='device').length,1);assert.equal((await engine.status(owner,{session_id}) as {closed:boolean}).closed,false);
 }finally{await second?.stop();await first.stop();await relay.close();await coordinator.close();certs.close();await rm(root,{recursive:true,force:true});}
});
test('failed connector startup releases its own runtime lock and stale locks remain fail closed',async()=>{
 const path='../../src/network/manual-connector.js',{startManualConnector}=await import(path);const {writeFile,access}=await import('node:fs/promises');const root=await mkdtemp(join(tmpdir(),'jev-admission-lock-'));
 const runtime=join(root,'runtime'),bad=join(root,'bad','manual');await mkdir(runtime,{mode:0o700});await mkdir(bad,{recursive:true,mode:0o700});await writeFile(join(bad,'network.sqlite'),'corrupt',{mode:0o600});
 const options={url:'https://127.0.0.1:1',name:'Mac',deviceId:'d',agentId:'a',journalDir:join(root,'bad'),credentialFile:join(runtime,'client-a.json'),pollMs:25};
 try{
  await assert.rejects(startManualConnector(options),/STORAGE_CORRUPT/);await assert.rejects(access(join(runtime,'network-connector.lock')));
  await writeFile(join(runtime,'network-connector.lock'),JSON.stringify({pid:999999999})+'\n',{mode:0o600});await assert.rejects(startManualConnector({...options,journalDir:join(root,'fresh')}),/CONNECTOR_ALREADY_RUNNING/);await access(join(runtime,'network-connector.lock'));
 }finally{await rm(root,{recursive:true,force:true});}
});
