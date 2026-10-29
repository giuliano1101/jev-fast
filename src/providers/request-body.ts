import {zstdCompressSync} from 'node:zlib';
import {Fault} from '../core/errors.js';

/** The plaintext limit applies before compression; encoded bytes never expand a request. */
export function encodeRequestBody(json:string):{body:string|Uint8Array<ArrayBuffer>;encoding?:'zstd'}{
 const bytes=Buffer.byteLength(json);
 if(bytes>16384)throw new Fault('PAYLOAD_LIMIT');
 if(bytes<1024)return {body:json};
 const compressed=zstdCompressSync(Buffer.from(json));
 return compressed.byteLength<bytes?{body:new Uint8Array(compressed),encoding:'zstd'}:{body:json};
}
