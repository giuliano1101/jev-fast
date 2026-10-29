import test from 'node:test';
import assert from 'node:assert/strict';
import {zstdDecompressSync} from 'node:zlib';
import {encodeRequestBody} from '../../src/providers/request-body.js';

test('compression uses UTF-8 bytes at the threshold and preserves exact Unicode JSON',()=>{
 const small=JSON.stringify({summary:'a'.repeat(900)});
 assert.deepEqual(encodeRequestBody(small),{body:small});
 const unicode=JSON.stringify({summary:'模拟表单'.repeat(200)});
 const encoded=encodeRequestBody(unicode);
 assert.equal(encoded.encoding,'zstd');
 assert.equal(zstdDecompressSync(encoded.body).toString('utf8'),unicode);
});
test('plaintext size limit cannot be bypassed by a highly compressible body',()=>{
 assert.throws(()=>encodeRequestBody('a'.repeat(16385)),/PAYLOAD_LIMIT/);
 assert.throws(()=>encodeRequestBody('模拟'.repeat(3000)),/PAYLOAD_LIMIT/);
 assert.doesNotThrow(()=>encodeRequestBody('a'.repeat(16384)));
});
