import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {makeRemoteCertificates} from '../helpers/remote-fixture.js';
import {startManualNetworkServer} from '../../src/network/manual-server.js';
import {until} from '../helpers/network-fixture.js';
test('private device capability resumes the same device, while a new journal cannot inherit admission',async()=>{
 const path='../../src/network/manual-connector.js',api=await import(path).catch(()=>({}));assert.equal(typeof api.startManualConnector,'function','manual connector missing');
 const root=await mkdtemp(join(tmpdir(),'jev-admission-connector-')),certs=makeRemoteCertificates();
 const relay=await startManualNetworkServer({host:'127.0.0.1',port:0,allowedOrigins:[],deviceId:'d',agentId:'a',storeDir:join(root,'relay'),tls:certs.server});
 const options={url:relay.url,name:'my Mac',deviceId:'d',agentId:'a',journalDir:join(root,'connector'),credentialFile:join(root,'missing','client-a.json'),ca:certs.ca,pollMs:25};
 await mkdir(join(root,'missing'),{mode:0o700});
 let connector=await api.startManualConnector(options);
 try{
  const first=await until<string>(async()=>connector.registrationId()??'',Boolean);assert.equal(relay.registry.get(first).enabled,false);
  relay.registry.setEnabled(first,true);await connector.stop();connector=await api.startManualConnector(options);
  const next=await until<string>(async()=>connector.registrationId()??'',Boolean);assert.equal(next,first);assert.equal(relay.registry.get(next).enabled,true);await connector.stop();connector=await api.startManualConnector({...options,journalDir:join(root,'new-journal')});const fresh=await until<string>(async()=>connector.registrationId()??'',Boolean);assert.notEqual(fresh,first);assert.equal(relay.registry.get(fresh).enabled,false);
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
test('manual connector reuses its owned TLS connection for heartbeats instead of a fresh handshake for every poll',async()=>{
 const {startManualConnector}=await import('../../src/network/manual-connector.js');
 const root=await mkdtemp(join(tmpdir(),'jev-keepalive-')),certs=makeRemoteCertificates();await mkdir(join(root,'runtime'),{mode:0o700});
 const relay=await startManualNetworkServer({host:'127.0.0.1',port:0,allowedOrigins:[],deviceId:'d',agentId:'a',storeDir:join(root,'relay'),tls:certs.server});
 let connections=0,syncs=0;relay.server.on('secureConnection',()=>connections++);relay.server.on('request',req=>{if(req.url==='/connector/sync')syncs++;});
 const connector=await startManualConnector({url:relay.url,name:'keepalive proof',deviceId:'d',agentId:'a',journalDir:join(root,'journal'),credentialFile:join(root,'runtime','client-a.json'),ca:certs.ca,pollMs:25});
 try{await until(async()=>syncs,value=>value>=5);assert.equal(connections,1,'repeated heartbeat polls should share one verified TLS transport');}
 finally{await connector.stop();await relay.close();certs.close();await rm(root,{recursive:true,force:true});}
});

test('running connector resumes exact registration after relay restart and preserves manual off across another restart',async()=>{
 const {startManualConnector}=await import('../../src/network/manual-connector.js');const {Engine}=await import('../../src/core/engine.js');const {Coordinator}=await import('../../src/service/coordinator.js');const {MockProvider}=await import('../../src/providers/mock.js');
 const root=await mkdtemp('/tmp/jev-resume-'),runtime=join(root,'runtime'),certs=makeRemoteCertificates();
 const browser={async open(){return {allowed_origin:'http://127.0.0.1:7777'};},async close(){},async observe():Promise<never>{throw Error('unexpected');},async validate():Promise<boolean>{throw Error('unexpected');},async execute(){throw Error('unexpected');},async check():Promise<boolean>{throw Error('unexpected');}};
 const engine=await Engine.create({storageDir:join(root,'ledger'),browser,provider:new MockProvider(),clients:['a']});const coordinator=await Coordinator.start({runtimeDir:runtime,engine,clients:['a']});
 const base={host:'127.0.0.1',port:0,allowedOrigins:[],deviceId:'d',agentId:'a',storeDir:join(root,'relay'),tls:certs.server};let relay=await startManualNetworkServer(base);const port=Number(new URL(relay.url).port);
 const connector=await startManualConnector({url:relay.url,name:'resume proof',deviceId:'d',agentId:'a',journalDir:join(root,'journal'),credentialFile:join(runtime,'client-a.json'),ca:certs.ca,pollMs:25});
 try{
  const device=await until(async()=>relay.registry.list().find(row=>row.type==='device'&&row.localInstance!==null),Boolean);const id=device!.id;relay.registry.setEnabled(id,true);await until(async()=>relay.store.status(),row=>row.local_ready);
  const ai=relay.registry.register('ai','old AI');relay.registry.setEnabled(ai.id,true);const owner=relay.registry.get(ai.id).owner;
  await relay.close();relay=await startManualNetworkServer({...base,port});
  await until(async()=>relay.store.status(),row=>row.local_ready);assert.equal(connector.registrationId(),id);assert.equal(relay.registry.list().filter(row=>row.type==='device').length,1);assert.equal(relay.registry.get(ai.id).owner,null);assert.equal(relay.registry.get(ai.id).enabled,false);assert.notEqual(owner,null);
  relay.registry.setEnabled(id,false);await until(async()=>relay.store.status(),row=>!row.local_ready);await relay.close();relay=await startManualNetworkServer({...base,port});
  await until(async()=>relay.registry.get(id),row=>row.localInstance!==null&&row.state!=='offline');await new Promise(resolve=>setTimeout(resolve,100));assert.equal(relay.registry.get(id).desiredEnabled,false);assert.equal(relay.registry.get(id).enabled,false);assert.equal(relay.store.status().local_ready,false);assert.equal(connector.registrationId(),id);
 }finally{await connector.stop();await relay.close();await coordinator.close();certs.close();await rm(root,{recursive:true,force:true});}
});

test('invalid persisted device handle is terminal and cannot create a replacement identity',async()=>{const {startManualConnector}=await import('../../src/network/manual-connector.js');const {DeviceRegistrationStore}=await import('../../src/network/device-registration.js');const root=await mkdtemp('/tmp/jev-invalid-resume-'),certs=makeRemoteCertificates();await mkdir(join(root,'runtime'),{mode:0o700});const relay=await startManualNetworkServer({host:'127.0.0.1',port:0,allowedOrigins:[],deviceId:'d',agentId:'a',storeDir:join(root,'relay'),tls:certs.server});const options={url:relay.url,name:'invalid resume',deviceId:'d',agentId:'a',journalDir:join(root,'journal'),credentialFile:join(root,'runtime','client-a.json'),ca:certs.ca,pollMs:25};new DeviceRegistrationStore(join(options.journalDir,'manual'),{url:relay.url,device_id:'d',agent_id:'a',credentialFile:options.credentialFile}).save('99999999-9999-4999-8999-999999999999');const connector=await startManualConnector(options);try{await connector.done;assert.equal(connector.failureCode(),'DEVICE_RESUME_INVALID');assert.equal(relay.registry.list().length,0);}finally{await connector.stop();await relay.close();certs.close();await rm(root,{recursive:true,force:true});}});

test('transient HTML proxy error and empty expired-handle response recover without replacement identity',async()=>{const {createServer}=await import('node:https');const {startManualConnector}=await import('../../src/network/manual-connector.js');const root=await mkdtemp('/tmp/jev-proxy-resume-'),certs=makeRemoteCertificates();await mkdir(join(root,'runtime'),{mode:0o700});let registrations=0,syncs=0;const handles:string[]=[];const handle='11111111-1111-4111-8111-111111111111';const server=createServer(certs.server,(req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const args=JSON.parse(body);if(req.url==='/connector/register'){registrations++;if(registrations===1){res.writeHead(503,{'content-type':'text/html'});res.end('<h1>Temporarily unavailable</h1>');return;}handles.push(args.resume_handle??'new');res.end(JSON.stringify({handle,enabled:false}));}else{syncs++;if(syncs===1){res.writeHead(410);res.end();return;}res.end(JSON.stringify({owners:[],revocations:[],enabled:false,acks:[],job:null}));}});});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const connector=await startManualConnector({url:`https://127.0.0.1:${address.port}`,name:'proxy proof',deviceId:'d',agentId:'a',journalDir:join(root,'journal'),credentialFile:join(root,'runtime','client-a.json'),ca:certs.ca,pollMs:25});try{await until(async()=>syncs,value=>value>=3);assert.equal(connector.failureCode(),undefined);assert.deepEqual(handles,['new',handle]);assert.equal(connector.registrationId(),handle);}finally{await connector.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));certs.close();await rm(root,{recursive:true,force:true});}});
