import {randomUUID,type KeyObject} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {BrowserPort,Goal,Snapshot,DecisionInput} from '../core/contracts.js';
import {Fault} from '../core/errors.js';
import {canonicalDigest,createCandidateSetDigest,parseDecisionRequest,verifyDecisionResponse,type AuthenticatedIdentity,type DecisionRequest} from './protocol.js';
export interface RemoteExecutionPolicy {publicKey:KeyObject;issuer:string;audience:string;identity:AuthenticatedIdentity;enforcementMode:'required_jev'|'test_mock'}
export interface ExecutionRequest {request:DecisionRequest;started:number;snapshotDeadline:number;goalDeadline:number}
export async function prepareExecutionRequest(browser:BrowserPort,snapshot:Snapshot,goal:Goal,goalId:string,epoch:number,input:DecisionInput,snapshotStarted:number,goalDeadline:number,signal:AbortSignal):Promise<ExecutionRequest>{
 if(!browser.commitments)throw new Fault('REMOTE_BINDING_REQUIRED');
 const snapshotDeadline=snapshotStarted+Math.min(2000,snapshot.expires_at-snapshot.created_at);
 // An unbounded goal still authorizes each action only while its snapshot is fresh.
 const receiptGoalDeadline=Math.min(snapshotDeadline,goalDeadline);
 const commitments=await browser.commitments(snapshot.session_id,snapshot,goal,signal);
 const started=performance.now(),remaining=Math.floor(Math.min(snapshotDeadline-started,receiptGoalDeadline-started,2000));
 if(remaining<=0)throw new Fault('STALE_SNAPSHOT');
 const request=parseDecisionRequest({schema_version:'decision-v1',request_id:randomUUID(),idempotency_key:randomUUID(),nonce:randomUUID().replaceAll('-',''),execution_context:{session_id:snapshot.session_id,goal_id:goalId,lease_epoch:epoch,policy_version:'p0-v1',adapter_version:'fixture-v1'},snapshot:{id:snapshot.snapshot_id,digest:canonicalDigest({session_id:snapshot.session_id,snapshot_id:snapshot.snapshot_id,document_epoch:snapshot.document_epoch,mutation_version:snapshot.mutation_version,fingerprint:snapshot.fingerprint,origin:snapshot.origin,url:snapshot.url}),valid_for_ms:remaining},input,candidate_set_digest:createCandidateSetDigest(snapshot.candidates,commitments),deadline_ms:remaining});
 return {request,started,snapshotDeadline,goalDeadline:receiptGoalDeadline};
}
export function verifyExecutionReceipt(response:unknown,binding:ExecutionRequest,policy:RemoteExecutionPolicy){return verifyDecisionResponse(response,{request:binding.request,...policy,requestStartedMonotonicMs:binding.started,snapshotDeadlineMonotonicMs:binding.snapshotDeadline,goalDeadlineMonotonicMs:binding.goalDeadline,nowMonotonicMs:performance.now(),nowWallMs:Date.now()});}
export async function revalidateExecutionBinding(browser:BrowserPort,snapshot:Snapshot,goal:Goal,binding:ExecutionRequest,signal:AbortSignal){
 if(!browser.commitments)throw new Fault('REMOTE_BINDING_REQUIRED');
 const current=await browser.commitments(snapshot.session_id,snapshot,goal,signal);
 if(createCandidateSetDigest(snapshot.candidates,current)!==binding.request.candidate_set_digest)throw new Fault('REMOTE_BINDING_CHANGED');
}
