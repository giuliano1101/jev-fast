import {createHash,sign,verify,X509Certificate,type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {idSchema} from '../core/contracts.js';
import {Fault} from '../core/errors.js';
import {canonicalJson,identitySchema,type AuthenticatedIdentity} from './protocol.js';
const claimsSchema=z.strictObject({issuer:idSchema,audience:idSchema,identity:identitySchema,certificate_sha256:z.string().regex(/^[a-f0-9]{64}$/),scope:z.enum(['decide:synthetic','decide:actions']),issued_at_ms:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),expires_at_ms:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)});
export type AgentTokenClaims=z.infer<typeof claimsSchema>;
function claims(value:unknown,now:number):AgentTokenClaims {
 const parsed=claimsSchema.safeParse(value);if(!parsed.success||!Number.isFinite(now))throw new Fault('UNAUTHENTICATED');
 const c=parsed.data;if(c.issued_at_ms>now||c.expires_at_ms<=now||c.expires_at_ms<=c.issued_at_ms||c.expires_at_ms-c.issued_at_ms>3600000)throw new Fault('UNAUTHENTICATED');return c;
}
/** Operator-only minting primitive; never exposed through ordinary MCP/agent tools. */
export function mintAgentToken(value:unknown,privateKey:KeyObject):string {
 if(privateKey.type!=='private'||privateKey.asymmetricKeyType!=='ed25519')throw new Fault('INVALID_CREDENTIAL_KEY');
 const payload=Buffer.from(canonicalJson(claims(value,Date.now()))).toString('base64url');
 return payload+'.'+sign(null,Buffer.from(payload),privateKey).toString('base64url');
}
export function verifyAgentToken(token:string,options:{publicKey:KeyObject;issuer:string;audience:string;certificateSha256:string;requiredScope?:'decide:synthetic'|'decide:actions';nowMs?:number}):AuthenticatedIdentity {
 if(typeof token!=='string'||token.length>8192||options.publicKey.type!=='public'||options.publicKey.asymmetricKeyType!=='ed25519')throw new Fault('UNAUTHENTICATED');
 const parts=token.split('.');if(parts.length!==2||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)))throw new Fault('UNAUTHENTICATED');
 const [payload,signature]=parts as [string,string];const bytes=Buffer.from(payload,'base64url'),sig=Buffer.from(signature,'base64url');
 if(bytes.toString('base64url')!==payload||sig.toString('base64url')!==signature||sig.length!==64||!verify(null,Buffer.from(payload),options.publicKey,sig))throw new Fault('UNAUTHENTICATED');
 let raw:unknown;try{raw=JSON.parse(bytes.toString('utf8'));}catch{throw new Fault('UNAUTHENTICATED');}
 const c=claims(raw,options.nowMs??Date.now());
 if(canonicalJson(c)!==bytes.toString('utf8')||c.issuer!==options.issuer||c.audience!==options.audience||c.certificate_sha256!==options.certificateSha256)throw new Fault('UNAUTHENTICATED');
 if(options.requiredScope==='decide:actions'&&c.scope!=='decide:actions')throw new Fault('FORBIDDEN');
 return c.identity;
}
export function certificateSha256(certificate:string|Buffer):string {return createHash('sha256').update(new X509Certificate(certificate).raw).digest('hex');}
