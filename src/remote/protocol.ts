import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { candidateSchema, decisionSchema, idSchema, taskSchema, validateDecision, type Candidate, type Decision } from '../core/contracts.js';
import { Fault } from '../core/errors.js';
import {fixtureProjectionSchema,richCandidateDescriptions,taskInstructions} from '../browser/projection.js';

export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ttlSchema = z.number().int().positive().max(2000);
const nonceSchema = z.string().regex(/^[a-f0-9]{32,64}$/);
export const identitySchema = z.strictObject({ owner_id:idSchema, device_id:idSchema, agent_id:idSchema });
export type AuthenticatedIdentity = z.infer<typeof identitySchema>;
export const executionContextSchema = z.strictObject({ session_id:idSchema, goal_id:idSchema, lease_epoch:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), policy_version:z.literal('p0-v1'), adapter_version:z.literal('fixture-v1') });
const legacySummarySchema = z.strictObject({task:taskSchema,step:z.number().int().min(0).max(1),submitted:z.number().int().min(0).max(100),cancelled:z.boolean(),loaded:z.boolean(),scrolled:z.boolean(),error:z.boolean()});
const summarySchema=z.union([legacySummarySchema,legacySummarySchema.extend({projection:fixtureProjectionSchema})]).refine(value=>!('projection' in value)||value.projection.instruction===taskInstructions[value.task]);
const descriptions = new Set(['wait loaded','back back',...richCandidateDescriptions]);
for (const action of ['fill name','fill email','fill query','select category','click cancel','click detail','click load','click submit','click next','scroll bottom']) {
    for (const label of ['synthetic action','模拟操作']) descriptions.add(`${action} (${label})`);
}
const inputSchema = z.strictObject({ synthetic:z.literal(true), snapshot_id:idSchema,
    summary:z.string().max(1024).refine(value => {
        try { const parsed=summarySchema.parse(JSON.parse(value)); return JSON.stringify(parsed)===value; } catch { return false; }
    }),
    goal:z.strictObject({task:taskSchema,language:z.enum(['en','zh'])}),
    candidates:z.array(z.strictObject({candidate_id:idSchema,description:z.string().max(160).refine(value=>descriptions.has(value))})).min(1).max(64)
}).superRefine((value,ctx)=>{
    if(new Set(value.candidates.map(c=>c.candidate_id)).size!==value.candidates.length) ctx.addIssue({code:'custom',message:'Duplicate candidate'});
    try { if(JSON.parse(value.summary).task!==value.goal.task) ctx.addIssue({code:'custom',message:'Task mismatch'}); } catch { /* The summary refinement rejects invalid JSON. */ }
});
export const decisionRequestSchema = z.strictObject({
    schema_version:z.literal('decision-v1'),request_id:idSchema,idempotency_key:idSchema,nonce:nonceSchema,
    execution_context:executionContextSchema,
    snapshot:z.strictObject({id:idSchema,digest:digestSchema,valid_for_ms:ttlSchema}),
    input:inputSchema,candidate_set_digest:digestSchema,deadline_ms:ttlSchema
}).refine(value=>value.input.snapshot_id===value.snapshot.id);
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
const responseBodySchema=z.strictObject({schema_version:z.literal('decision-v1'),request_id:idSchema,decision_id:idSchema,route:z.enum(['jev','mock']),outcome:z.literal('ALLOW_CANDIDATE'),policy_version:z.literal('p0-v1'),snapshot_id:idSchema,candidate_set_digest:digestSchema,decision:decisionSchema,valid_for_ms:ttlSchema});
export const responseSchema=responseBodySchema.extend({receipt:z.string().min(1).max(48000)});
export type DecisionResponse=z.infer<typeof responseSchema>;
const receiptSchema=z.strictObject({schema_version:z.literal('receipt-v1'),issuer:idSchema,audience:idSchema,identity:identitySchema,nonce:nonceSchema,execution_context:executionContextSchema,snapshot_digest:digestSchema,request_digest:digestSchema,response_digest:digestSchema,decision_id:idSchema,candidate_id:idSchema,issued_at_ms:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),expires_at_ms:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
const bindingSchema=z.strictObject({candidate_id:idSchema,target_digest:digestSchema,params_digest:digestSchema});
export type CandidateCommitment=z.infer<typeof bindingSchema>;

/** Canonical JSON only: reject values JSON would silently omit or coerce. Array order is significant. */
export function canonicalJson(value:unknown, depth=0):string {
    if(depth>32) throw new Fault('INVALID_PROTOCOL');
    if(value===null||typeof value==='boolean'||typeof value==='string') return JSON.stringify(value);
    if(typeof value==='number'&&Number.isFinite(value)) return JSON.stringify(value);
    if(Array.isArray(value)) {
        const keys=Reflect.ownKeys(value).filter(key=>key!=='length');
        if(keys.length!==value.length||keys.some((key,index)=>key!==String(index))) throw new Fault('INVALID_PROTOCOL');
        return '['+value.map(v=>canonicalJson(v,depth+1)).join(',')+']';
    }
    if(typeof value==='object'&&value!==null&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)) {
        if(Object.getOwnPropertySymbols(value).length) throw new Fault('INVALID_PROTOCOL');
        return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalJson((value as Record<string,unknown>)[k],depth+1)).join(',')+'}';
    }
    throw new Fault('INVALID_PROTOCOL');
}
export function canonicalDigest(value:unknown):string {return 'sha256:'+createHash('sha256').update(canonicalJson(value)).digest('hex');}
function parse<T>(schema:z.ZodType<T>, value:unknown, code='INVALID_PROTOCOL'):T {
    const parsed=schema.safeParse(value);if(!parsed.success) throw new Fault(code);return parsed.data;
}
function boundBytes(value:unknown,limit:number) {if(Buffer.byteLength(canonicalJson(value),'utf8')>limit) throw new Fault('REQUEST_TOO_LARGE');}
export function parseDecisionRequest(value:unknown):DecisionRequest {
    boundBytes(value,24000);return parse(decisionRequestSchema,value);
}
/** This digest stays local except for its hash. Commitments must be produced by the trusted adapter, with local random salts. */
export function createCandidateSetDigest(candidates:readonly Candidate[], commitments:readonly CandidateCommitment[]):string {
    const parsed=parse(z.array(candidateSchema).min(1).max(64),candidates);
    const bindings=parse(z.array(bindingSchema).min(1).max(64),commitments);
    const ids=new Set(parsed.map(c=>c.candidate_id));
    if(ids.size!==parsed.length||bindings.length!==parsed.length||new Set(bindings.map(b=>b.candidate_id)).size!==ids.size||bindings.some(b=>!ids.has(b.candidate_id))) throw new Fault('INVALID_CANDIDATE_BINDING');
    const byId=new Map(bindings.map(b=>[b.candidate_id,b]));
    return canonicalDigest({schema_version:'candidate-set-v1',candidates:[...parsed].sort((a,b)=>a.candidate_id<b.candidate_id?-1:a.candidate_id>b.candidate_id?1:0).map(candidate=>({candidate,commitment:byId.get(candidate.candidate_id)}))});
}
export interface SigningOptions {
    privateKey:KeyObject;issuer:string;audience:string;identity:AuthenticatedIdentity;decisionId:string;
    issuedAtMs:number;validForMs:number;route:'jev'|'mock';
}
function permittedDecision(value:unknown,request:DecisionRequest,route:string):Decision {
    const decision=validateDecision(value,request.snapshot.id,request.input.candidates.map(c=>c.candidate_id));
    if(decision.provider!==route||decision.confidence<0.9) throw new Fault('INVALID_DECISION');
    return decision;
}
/** Gateway signs only after authenticating identity and authorizing a route; this function does not authenticate callers. */
export function signDecisionResponse(requestValue:unknown,decisionValue:unknown,options:SigningOptions):DecisionResponse {
    const request=parseDecisionRequest(requestValue);
    if(options.privateKey.asymmetricKeyType!=='ed25519'||options.privateKey.type!=='private') throw new Fault('INVALID_RECEIPT_KEY');
    if(options.validForMs>Math.min(request.deadline_ms,request.snapshot.valid_for_ms)) throw new Fault('STALE_SNAPSHOT');
    const decision=permittedDecision(decisionValue,request,options.route);
    const body=parse(responseBodySchema,{schema_version:'decision-v1',request_id:request.request_id,decision_id:options.decisionId,route:options.route,outcome:'ALLOW_CANDIDATE',policy_version:request.execution_context.policy_version,snapshot_id:request.snapshot.id,candidate_set_digest:request.candidate_set_digest,decision,valid_for_ms:options.validForMs});
    const claims=parse(receiptSchema,{schema_version:'receipt-v1',issuer:options.issuer,audience:options.audience,identity:options.identity,nonce:request.nonce,execution_context:request.execution_context,snapshot_digest:request.snapshot.digest,request_digest:canonicalDigest(request),response_digest:canonicalDigest(body),decision_id:body.decision_id,candidate_id:decision.candidate_id,issued_at_ms:options.issuedAtMs,expires_at_ms:options.issuedAtMs+options.validForMs});
    const payload=Buffer.from(canonicalJson(claims)).toString('base64url');
    return {...body,receipt:payload+'.'+sign(null,Buffer.from(payload),options.privateKey).toString('base64url')};
}
export interface VerificationOptions {
    request:DecisionRequest;publicKey:KeyObject;issuer:string;audience:string;identity:AuthenticatedIdentity;
    enforcementMode:'required_jev'|'test_mock';requestStartedMonotonicMs:number;
    snapshotDeadlineMonotonicMs:number;goalDeadlineMonotonicMs:number;nowMonotonicMs:number;nowWallMs:number;
}
export interface VerifiedDecisionReceipt {decision:Decision;decision_id:string;nonce:string;route:'jev'|'mock';expires_at_monotonic_ms:number;receipt_digest:string;}
/** Stateless verification only. The Engine MUST verify again and atomically consume nonce + action in its durable ledger before execution. */
export function verifyDecisionResponse(value:unknown,options:VerificationOptions):VerifiedDecisionReceipt {
    const request=parseDecisionRequest(options.request);
    boundBytes(value,64000);
    const response=parse(responseSchema,value,'INVALID_RECEIPT');
    if(options.publicKey.asymmetricKeyType!=='ed25519'||options.publicKey.type!=='public') throw new Fault('INVALID_RECEIPT_KEY');
    const parts=response.receipt.split('.');
    if(parts.length!==2||!parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p))) throw new Fault('INVALID_RECEIPT');
    const [payload,signature]=parts as [string,string];
    const decoded=Buffer.from(payload,'base64url'),sig=Buffer.from(signature,'base64url');
    if(decoded.toString('base64url')!==payload||sig.toString('base64url')!==signature||sig.length!==64||!verify(null,Buffer.from(payload),options.publicKey,sig)) throw new Fault('INVALID_RECEIPT');
    let raw:unknown;try{raw=JSON.parse(decoded.toString('utf8'));}catch{throw new Fault('INVALID_RECEIPT');}
    const claims=parse(receiptSchema,raw,'INVALID_RECEIPT');
    const {receipt:_receipt,...body}=response;
    if(claims.issuer!==options.issuer||claims.audience!==options.audience||canonicalDigest(claims.identity)!==canonicalDigest(parse(identitySchema,options.identity))||claims.nonce!==request.nonce||canonicalDigest(claims.execution_context)!==canonicalDigest(request.execution_context)||claims.snapshot_digest!==request.snapshot.digest||claims.request_digest!==canonicalDigest(request)||claims.response_digest!==canonicalDigest(body)||claims.decision_id!==response.decision_id||claims.candidate_id!==response.decision.candidate_id||response.request_id!==request.request_id||response.snapshot_id!==request.snapshot.id||response.candidate_set_digest!==request.candidate_set_digest||response.policy_version!==request.execution_context.policy_version) throw new Fault('RECEIPT_BINDING_MISMATCH');
    if(!['required_jev','test_mock'].includes(options.enforcementMode)||(options.enforcementMode==='required_jev'&&response.route!=='jev')) throw new Fault('ROUTE_DENIED');
    const decision=permittedDecision(response.decision,request,response.route);
    const signedTtl=claims.expires_at_ms-claims.issued_at_ms;
    const clocks=[options.requestStartedMonotonicMs,options.nowMonotonicMs,options.snapshotDeadlineMonotonicMs,options.goalDeadlineMonotonicMs,options.nowWallMs];
    if(clocks.some(n=>!Number.isFinite(n)||n<0)||options.nowMonotonicMs<options.requestStartedMonotonicMs||signedTtl!==response.valid_for_ms||signedTtl<=0||signedTtl>Math.min(request.deadline_ms,request.snapshot.valid_for_ms)) throw new Fault('STALE_RECEIPT');
    const expires=Math.min(options.requestStartedMonotonicMs+Math.min(request.deadline_ms,request.snapshot.valid_for_ms,response.valid_for_ms,signedTtl),options.snapshotDeadlineMonotonicMs,options.goalDeadlineMonotonicMs);
    // A wall-clock jump may shorten authorization, but can never extend this monotonic deadline.
    if(options.nowMonotonicMs>=expires||options.nowWallMs>=claims.expires_at_ms) throw new Fault('STALE_RECEIPT');
    return {decision,decision_id:response.decision_id,nonce:claims.nonce,route:response.route,expires_at_monotonic_ms:expires,receipt_digest:canonicalDigest(response.receipt)};
}
