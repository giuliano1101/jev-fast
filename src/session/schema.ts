import {z} from 'zod';
import {idSchema,type LedgerState} from '../core/contracts.js';
import {Fault} from '../core/errors.js';

export const LEDGER_CAPACITY=100000;
const timestamp=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash=z.string().min(1).max(128);
const receiptSchema=z.strictObject({decision_id:idSchema,nonce:z.string().regex(/^[a-f0-9]{32,64}$/),receipt_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),route:z.enum(['jev','mock']),owner_id:idSchema,device_id:idSchema,agent_id:idSchema});
const sessionSchema=z.strictObject({owner:idSchema,fixture_id:z.literal('standard'),allowed_origin:z.string().max(200).refine(value=>{try{const u=new URL(value);return u.origin===value&&u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!!u.port;}catch{return false;}}),epoch:timestamp,quarantined:z.boolean(),closed:z.boolean()});
const goalSchema=z.strictObject({session_id:idSchema,goal_id:idSchema,idempotency_key:idSchema,request_hash:hash,status:z.enum(['RUNNING','SUCCEEDED','FALLBACK','CANCELLED','UNKNOWN']),steps:z.number().int().min(0).max(64),elapsed_ms:z.number().finite().nonnegative(),reason:z.string().max(200).nullable(),evidence:z.array(z.string().max(200)).max(128),action_ids:z.array(idSchema).max(64)});
const actionSchema=z.strictObject({action_id:idSchema,session_id:idSchema,goal_id:idSchema,lease_epoch:timestamp,idempotency_key:idSchema,request_hash:hash,snapshot_id:idSchema,candidate_id:idSchema,policy_version:z.literal('p0-v1'),status:z.enum(['VALIDATED','EXECUTING','VERIFYING','SUCCEEDED','FAILED','UNKNOWN','REJECTED']),created_at:timestamp,updated_at:timestamp,validated_at:timestamp.optional(),execution_started_at:timestamp.optional(),verification_started_at:timestamp.optional(),completed_at:timestamp.optional(),receipt:receiptSchema.optional()});
const records=<T extends z.ZodType>(schema:T)=>z.record(z.string().min(1).max(201).refine(k=>!['__proto__','prototype','constructor'].includes(k)),schema).refine(value=>Object.keys(value).length<=LEDGER_CAPACITY);
const stateSchema=z.strictObject({version:z.union([z.literal(1),z.literal(2)]),sessions:records(sessionSchema),goals:records(goalSchema),actions:records(actionSchema)});

/** Validate before recovery and before every durable mutation. Never repair corrupt evidence. */
export function validateLedgerState(value:unknown):asserts value is LedgerState {
 const parsed=stateSchema.safeParse(value);if(!parsed.success)throw new Fault('STORAGE_CORRUPT');
 const state=parsed.data,goals=new Map<string,typeof state.goals[string]>(),keys=new Set<string>(),referenced=new Set<string>();
 for(const [sessionId] of Object.entries(state.sessions))if(!idSchema.safeParse(sessionId).success)throw new Fault('STORAGE_CORRUPT');
 for(const [mapKey,goal] of Object.entries(state.goals)){
  const identity=`${goal.session_id}:${goal.goal_id}`,key=`${goal.session_id}:${goal.idempotency_key}`;
  if(mapKey!==identity||!Object.hasOwn(state.sessions,goal.session_id)||goals.has(identity)||keys.has(key)||new Set(goal.action_ids).size!==goal.action_ids.length)throw new Fault('STORAGE_CORRUPT');
  goals.set(identity,goal);keys.add(key);
  for(const actionId of goal.action_ids){const action=state.actions[actionId];if(!action||referenced.has(actionId)||action.session_id!==goal.session_id||action.goal_id!==goal.goal_id)throw new Fault('STORAGE_CORRUPT');referenced.add(actionId);}
 }
 const consumedNonces=new Set<string>(),consumedDecisions=new Set<string>();
 for(const [actionId,action] of Object.entries(state.actions)){
  const goal=goals.get(`${action.session_id}:${action.goal_id}`),session=state.sessions[action.session_id];
  if(actionId!==action.action_id||!goal||!session||!referenced.has(actionId)||action.idempotency_key!==goal.idempotency_key||action.request_hash!==goal.request_hash||action.lease_epoch>session.epoch)throw new Fault('STORAGE_CORRUPT');
  if(action.receipt){if(state.version!==2)throw new Fault('STORAGE_CORRUPT');if(consumedNonces.has(action.receipt.nonce)||consumedDecisions.has(action.receipt.decision_id))throw new Fault('RECEIPT_ALREADY_CONSUMED');consumedNonces.add(action.receipt.nonce);consumedDecisions.add(action.receipt.decision_id);}
 }
}
