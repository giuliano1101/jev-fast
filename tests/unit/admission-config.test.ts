import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadNetworkConfig} from '../../src/network/config.js';
test('manual profiles require no public caller tokens and reject hidden legacy credential setup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-admission-config-'));
 try{
  const file=join(dir,'connector.json'),config={accessMode:'manual',name:'My Mac',url:'https://relay.invalid',deviceId:'d',agentId:'a',journalDir:join(dir,'journal'),credentialFile:join(dir,'client-a.json')};
  await writeFile(file,JSON.stringify(config),{mode:0o600});
  const loaded=loadNetworkConfig('connector',file) as unknown as Record<string,unknown>;assert.equal(loaded.accessMode,'manual');assert.equal('token' in loaded,false);
  await writeFile(file,JSON.stringify({...config,tokenFile:join(dir,'token.json')}));assert.throws(()=>loadNetworkConfig('connector',file),/INVALID_NETWORK_CONFIG/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('private operator profile preserves explicit auto AI admission policy and nullable AI expiry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-auto-config-'));
 try{const file=join(dir,'server.json'),key=join(dir,'key.pem'),cert=join(dir,'cert.pem');await writeFile(key,'operator key',{mode:0o600});await writeFile(cert,'operator cert',{mode:0o600});
  const config={accessMode:'manual',host:'127.0.0.1',port:8443,publicHost:'relay.invalid',allowedOrigins:[],deviceId:'d',agentId:'a',storeDir:join(dir,'store'),tlsKeyFile:key,tlsCertFile:cert,autoAdmitAi:true,allowContinuations:true,sessionTtlMs:null};
  await writeFile(file,JSON.stringify(config),{mode:0o600});const loaded=loadNetworkConfig('server',file);assert.ok('autoAdmitAi' in loaded);assert.equal(loaded.autoAdmitAi,true);assert.equal(loaded.allowContinuations,true);assert.equal(loaded.sessionTtlMs,null);
  await writeFile(file,JSON.stringify({...config,leaseMs:30000}));const lease=loadNetworkConfig('server',file);assert.ok('leaseMs' in lease);assert.equal(lease.leaseMs,30000);
  await writeFile(file,JSON.stringify({...config,autoAdmitAi:'true'}));assert.throws(()=>loadNetworkConfig('server',file),/INVALID_NETWORK_CONFIG/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
