import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mintAgentToken, verifyAgentToken } from '../../src/remote/credentials.js';
import { RemoteDecisionProvider } from '../../src/remote/client.js';
const keys=generateKeyPairSync('ed25519');
const identity={owner_id:'owner',device_id:'device',agent_id:'agent'};
const certificateSha256='a'.repeat(64);
const claims=()=>({issuer:'gateway',audience:'executor',identity,certificate_sha256:certificateSha256,issued_at_ms:Date.now()-10,expires_at_ms:Date.now()+60000,scope:'decide:synthetic' as const});
const verifyOptions=()=>({publicKey:keys.publicKey,issuer:'gateway',audience:'executor',certificateSha256,nowMs:Date.now()});
test('agent tokens bind certificate, principal, issuer, audience, scope, expiry and Ed25519 signer',()=>{
 const token=mintAgentToken(claims(),keys.privateKey);
 assert.deepEqual(verifyAgentToken(token,verifyOptions()),identity);
 for(const options of [{certificateSha256:'b'.repeat(64)},{issuer:'elsewhere'},{audience:'elsewhere'},{nowMs:Date.now()+60001},{publicKey:generateKeyPairSync('ed25519').publicKey}])assert.throws(()=>verifyAgentToken(token,{...verifyOptions(),...options}));
 for(const malformed of [token+'=',token+'x','x.y.z',token.replace(/^./,token[0]==='a'?'b':'a'),'a'.repeat(9000)])assert.throws(()=>verifyAgentToken(malformed,verifyOptions()));
});
test('mint rejects excessive lifetime, unexpected claims and non-Ed25519 signing keys',()=>{
 for(const change of [{expires_at_ms:Date.now()+3600001},{scope:'admin'},{identity:{...identity,role:'admin'}},{extra:true},{issued_at_ms:Date.now()+10000},{expires_at_ms:Date.now()-1}])assert.throws(()=>mintAgentToken({...claims(),...change},keys.privateKey));
 assert.throws(()=>mintAgentToken(claims(),generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey));
});
test('remote transport constructor rejects non-HTTPS, credentials in URL, paths and fragments',()=>{
 for(const url of ['http://localhost','https://u:p@localhost','https://localhost/path','https://localhost?query','https://localhost#hash'])assert.throws(()=>new RemoteDecisionProvider({url,cert:'cert',key:'key',ca:'ca',token:'token'}));
});
