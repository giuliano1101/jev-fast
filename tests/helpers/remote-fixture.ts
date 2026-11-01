import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {request as httpsRequest} from 'node:https';
import {once} from 'node:events';
import {GatewayStore} from '../../src/remote/store.js';
import {createDecisionGateway,type DecisionGatewayOptions} from '../../src/remote/gateway.js';
import {certificateSha256,mintAgentToken} from '../../src/remote/credentials.js';
import {RemoteDecisionProvider} from '../../src/remote/client.js';
import type {DecisionRequest,AuthenticatedIdentity} from '../../src/remote/protocol.js';
export function remoteRequest(suffix=''):DecisionRequest {return {schema_version:'decision-v1',request_id:'req'+suffix,idempotency_key:'idem'+suffix,nonce:'0123456789abcdef0123456789abcdef',execution_context:{session_id:'sess'+suffix,goal_id:'goal'+suffix,lease_epoch:1,policy_version:'p0-v1',adapter_version:'fixture-v1'},snapshot:{id:'snap',digest:'sha256:'+'a'.repeat(64),valid_for_ms:2000},input:{synthetic:true,snapshot_id:'snap',summary:JSON.stringify({task:'form',step:0,submitted:0,cancelled:false,loaded:false,scrolled:false,error:false}),goal:{task:'form',language:'en'},candidates:[{candidate_id:'c',description:'fill name (synthetic action)'}]},candidate_set_digest:'sha256:'+'b'.repeat(64),deadline_ms:2000};}
export function makeRemoteCertificates(){
 const dir=mkdtempSync(join(tmpdir(),'jev-tls-'));
 const openssl=(args:string[])=>execFileSync('/usr/bin/openssl',args,{cwd:dir,stdio:'ignore'});
 openssl(['req','-sha256','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=jev-test-ca']);
 for(const name of ['server','a','b']){
  openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+name]);
  writeFileSync(join(dir,name+'.ext'),name==='server'?'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n':'extendedKeyUsage=clientAuth\n');
  openssl(['x509','-sha256','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out',name+'.pem','-days','1','-extfile',name+'.ext']);
 }
 const read=(name:string)=>readFileSync(join(dir,name));
 return {ca:read('ca.pem'),server:{cert:read('server.pem'),key:read('server.key')},a:{cert:read('a.pem'),key:read('a.key')},b:{cert:read('b.pem'),key:read('b.key')},close:()=>rmSync(dir,{recursive:true,force:true})};
}
export type RemoteCertificates=ReturnType<typeof makeRemoteCertificates>;
export async function remoteFixture(certs:RemoteCertificates,extra:Partial<Pick<DecisionGatewayOptions,'mockProvider'|'live'|'choiceStore'>>={}){
 const dir=mkdtempSync(join(tmpdir(),'jev-gateway-'));const store=new GatewayStore(dir);const keys=generateKeyPairSync('ed25519');
 const identities={a:{owner_id:'owner',device_id:'device-a',agent_id:'agent'},b:{owner_id:'owner',device_id:'device-b',agent_id:'agent'}};
 for(const id of ['a','b'] as const)store.enroll({...identities[id],certificate_sha256:certificateSha256(certs[id].cert),expires_at:Date.now()+3600000});
 const token=(id:'a'|'b',identity:AuthenticatedIdentity=identities[id],expiresAt=Date.now()+60000)=>mintAgentToken({issuer:'gateway',audience:'executor',identity,certificate_sha256:certificateSha256(certs[id].cert),scope:'decide:synthetic',issued_at_ms:Date.now()-10,expires_at_ms:expiresAt},keys.privateKey);
 const server=createDecisionGateway({tls:{...certs.server,ca:certs.ca},store,receiptPrivateKey:keys.privateKey,tokenPublicKey:keys.publicKey,issuer:'gateway',audience:'executor',...extra});server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();if(!address||typeof address==='string')throw new Error('no address');const url=`https://127.0.0.1:${address.port}`;
 const client=(id:'a'|'b'='a',bearer=token(id))=>new RemoteDecisionProvider({url,...certs[id],ca:certs.ca,token:bearer});
 const raw=(body:unknown=remoteRequest(),options:{id?:'a'|'b';token?:string;headers?:Record<string,string>;method?:string;path?:string}={})=>new Promise<{status:number;text:string;body:Record<string,unknown>}>((resolve,reject)=>{
  const data=typeof body==='string'?body:JSON.stringify(body),id=options.id??'a';
  const req=httpsRequest(url+(options.path??'/v1/decisions'),{...certs[id],ca:certs.ca,agent:false,method:options.method??'POST',headers:{authorization:'Bearer '+(options.token??token(id)),'content-type':'application/json','content-length':Buffer.byteLength(data),...options.headers}},res=>{const chunks:Buffer[]=[];res.on('data',(c:Buffer)=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode!,text,body:JSON.parse(text)});});res.on('error',reject);});req.on('error',reject);req.end(data);
 });
 return {store,keys,identities,url,server,token,client,raw,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));store.close();rmSync(dir,{recursive:true,force:true});}};
}
