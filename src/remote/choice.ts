import {sign,verify,randomUUID,type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {choiceArgsSchema,choiceDecisionSchema,type ChoiceArgs,type ChoiceDecision} from '../choice/contracts.js';
import {Fault} from '../core/errors.js';
import {canonicalJson,canonicalDigest,digestSchema,identitySchema,type AuthenticatedIdentity} from './protocol.js';
export const choiceRequestSchema=z.strictObject({caller_scope:z.string().min(1),args:choiceArgsSchema});
export const choiceProofPayloadSchema=z.strictObject({protocol:z.literal('choice-v1'),issuer:z.string().min(1),audience:z.string().min(1),identity:identitySchema,caller_scope:z.string().min(1),request_digest:digestSchema,response_digest:digestSchema,provider:z.literal('jev'),model:z.literal('jev-1.14.0'),selected_id:z.string().min(1),decision_id:z.uuid(),issued_at_ms:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
export const choiceResponseSchema=choiceDecisionSchema.extend({proof:z.strictObject({payload:choiceProofPayloadSchema,signature:z.string().regex(/^[A-Za-z0-9_-]+$/)})});
export type ChoiceResponse=z.infer<typeof choiceResponseSchema>;
export type ChoiceOwner={identity:AuthenticatedIdentity;caller_scope:string};
export function signChoiceResponse(args:ChoiceArgs,value:ChoiceDecision,options:ChoiceOwner&{privateKey:KeyObject;issuer:string;audience:string}):ChoiceResponse{
 if(options.privateKey.type!=='private'||options.privateKey.asymmetricKeyType!=='ed25519')throw new Fault('INVALID_RECEIPT_KEY');
 const request=choiceArgsSchema.parse(args),decision=choiceDecisionSchema.parse(value);if(!request.actions.some(action=>action.id===decision.selected_id))throw new Fault('INVALID_RESPONSE');
 const payload=choiceProofPayloadSchema.parse({protocol:'choice-v1',issuer:options.issuer,audience:options.audience,identity:options.identity,caller_scope:options.caller_scope,request_digest:canonicalDigest(request),response_digest:canonicalDigest(decision),provider:decision.provider,model:decision.model,selected_id:decision.selected_id,decision_id:randomUUID(),issued_at_ms:Date.now()});
 return {...decision,proof:{payload,signature:sign(null,Buffer.from(canonicalJson(payload)),options.privateKey).toString('base64url')}};
}
/** Evidence of a decision only: no UI effect, execution authorization, or reusable action permit. */
export function verifyChoiceResponse(value:unknown,options:ChoiceOwner&{args:ChoiceArgs;publicKey:KeyObject;issuer:string;audience:string}):ChoiceResponse{
 const parsed=choiceResponseSchema.safeParse(value);if(!parsed.success)throw new Fault('INVALID_RECEIPT');const response=parsed.data,{proof,...decision}=response,p=proof.payload;
 if(options.publicKey.type!=='public'||options.publicKey.asymmetricKeyType!=='ed25519')throw new Fault('INVALID_RECEIPT_KEY');
 const signature=Buffer.from(proof.signature,'base64url');if(signature.length!==64||signature.toString('base64url')!==proof.signature||!verify(null,Buffer.from(canonicalJson(p)),options.publicKey,signature))throw new Fault('INVALID_RECEIPT');
 if(p.issuer!==options.issuer||p.audience!==options.audience||p.caller_scope!==options.caller_scope||canonicalDigest(p.identity)!==canonicalDigest(options.identity)||p.request_digest!==canonicalDigest(choiceArgsSchema.parse(options.args))||p.response_digest!==canonicalDigest(decision)||p.provider!==decision.provider||p.model!==decision.model||p.selected_id!==decision.selected_id||!options.args.actions.some(action=>action.id===decision.selected_id))throw new Fault('RECEIPT_BINDING_MISMATCH');
 return response;
}
