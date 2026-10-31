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
