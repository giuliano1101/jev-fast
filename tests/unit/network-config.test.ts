import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
test('deployment configuration requires explicit private files and keeps import/help inert',async()=>{
 const path='../../src/network/config.js';const api=await import(path).catch(()=>({}));assert.equal(typeof api.loadNetworkConfig,'function','private network profiles are missing');
 const dir=mkdtempSync(join(tmpdir(),'network-config-'));
 const token={token:randomBytes(32).toString('hex'),expiresAt:Date.now()+60000};
 const config={url:'https://relay.invalid',deviceId:'d',agentId:'a',journalDir:join(dir,'journal'),credentialFile:join(dir,'client-a.json'),tokenFile:join(dir,'token.json')};
 const write=(file:string,value:unknown)=>writeFileSync(join(dir,file),JSON.stringify(value),{mode:0o600});
 try{
  write('token.json',token);write('config.json',config);
  const loaded=api.loadNetworkConfig('connector',join(dir,'config.json'));assert.equal(loaded.token.token,token.token);
  chmodSync(join(dir,'token.json'),0o644);assert.throws(()=>api.loadNetworkConfig('connector',join(dir,'config.json')),/PRIVATE_FILE_REQUIRED/);chmodSync(join(dir,'token.json'),0o600);
  symlinkSync(join(dir,'config.json'),join(dir,'link.json'));assert.throws(()=>api.loadNetworkConfig('connector',join(dir,'link.json')),/PRIVATE_FILE_REQUIRED/);
  write('config.json',{...config,shell:'echo hi'});assert.throws(()=>api.loadNetworkConfig('connector',join(dir,'config.json')));
  const text=execFileSync(process.execPath,['dist/src/network/main.js','--help'],{encoding:'utf8'});assert.match(text,/--config/);assert.ok(!text.includes(token.token));
  const imported=execFileSync(process.execPath,['--input-type=module','-e',"await import('./dist/src/network/main.js')"],{encoding:'utf8'});assert.equal(imported,'');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('connector CLI reports terminal authorization and fencing with safe nonzero exits',async()=>{
 const {createServer}=await import('node:https');const {spawn}=await import('node:child_process');const {makeRemoteCertificates}=await import('../helpers/remote-fixture.js');
 const certs=makeRemoteCertificates(),dir=mkdtempSync(join(tmpdir(),'network-cli-fatal-'));let status=401;
 const secretBody='PRIVATE_RESPONSE_MUST_NOT_BE_LOGGED';const server=createServer(certs.server,(_req,res)=>res.writeHead(status).end(secretBody));
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address!=='string');
 const token={token:randomBytes(32).toString('hex'),expiresAt:Date.now()+60000};
 const run=()=>new Promise<{code:number|null;stdout:string;stderr:string}>((done,fail)=>{
  const child=spawn(process.execPath,['dist/src/network/main.js','connector','--config',join(dir,'config.json')],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');fail(new Error('CLI_FATAL_EXIT_TIMEOUT'));},8000);
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',fail);child.once('exit',code=>{clearTimeout(timer);done({code,stdout,stderr});});
 });
 try{
  writeFileSync(join(dir,'ca.pem'),certs.ca,{mode:0o600});writeFileSync(join(dir,'token.json'),JSON.stringify(token),{mode:0o600});
  for(const [httpStatus,errorCode] of [[401,'NETWORK_UNAUTHORIZED'],[409,'CONNECTOR_FENCED']] as const){
   status=httpStatus;writeFileSync(join(dir,'config.json'),JSON.stringify({url:`https://127.0.0.1:${address.port}`,deviceId:'d',agentId:'a',journalDir:join(dir,'journal-'+httpStatus),credentialFile:join(dir,'client-a.json'),tokenFile:join(dir,'token.json'),caFile:join(dir,'ca.pem')}),{mode:0o600});
   const result=await run();assert.equal(result.code,1);assert.equal(result.stdout,'');assert.equal(result.stderr,errorCode+'\n');assert.ok(!result.stderr.includes(token.token));assert.ok(!result.stderr.includes(secretBody));
  }
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));certs.close();rmSync(dir,{recursive:true,force:true});}
});
