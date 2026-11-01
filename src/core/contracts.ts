import { z } from 'zod';
import { Fault } from './errors.js';
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const taskSchema = z.enum(['form', 'filter', 'detail', 'back', 'cancel', 'correction', 'duplicate', 'async', 'scroll', 'select', 'wait', 'navigation']);
export const goalSchema = z.strictObject({ task: taskSchema, language: z.enum(['en', 'zh']), seed: z.number().int().min(0).max(1000000), values: z.strictObject({ name: z.string().max(80).optional(), email: z.string().max(80).optional(), category: z.enum(['alpha', 'beta', 'gamma']).optional(), query: z.string().max(80).optional() }).optional() });
export const predicateSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('task_complete') }),
    z.strictObject({ kind: z.literal('field'), field: z.enum(['name', 'email', 'category', 'query']), value: z.string().max(80) }),
    z.strictObject({ kind: z.literal('page'), path: z.enum(['/form', '/list', '/detail', '/done']) }),
    z.strictObject({ kind: z.literal('step'), value: z.number().int().min(0).max(2) }),
    z.strictObject({ kind: z.literal('count'), value: z.number().int().min(0).max(100) }),
    z.strictObject({ kind: z.literal('flag'), name: z.enum(['cancelled', 'loaded', 'scrolled', 'error']), value: z.boolean() })
]);
export const schemas = {
    open_session: z.strictObject({ fixture_id: z.literal('standard') }),
    observe: z.strictObject({ session_id: idSchema }),
    run_goal: z.strictObject({ session_id: idSchema, goal_id: idSchema, idempotency_key: idSchema, goal: goalSchema, success: predicateSchema, max_steps: z.number().int().positive().safe().optional(), time_budget_ms: z.number().int().positive().safe().optional() }),
    cancel: z.strictObject({ session_id: idSchema, goal_id: idSchema }),
    status: z.strictObject({ session_id: idSchema, goal_id: idSchema.optional(), action_id: idSchema.optional() }).refine(x => !(x.goal_id && x.action_id)),
    close_session: z.strictObject({ session_id: idSchema })
};
export type Goal = z.infer<typeof goalSchema>;
export type Predicate = z.infer<typeof predicateSchema>;
export type RunGoalRequest = z.infer<typeof schemas.run_goal>;
export const operations = ['click', 'fill', 'select', 'scroll', 'back', 'wait'] as const;
export const candidateSchema = z.strictObject({ candidate_id: idSchema, snapshot_id: idSchema, operation: z.enum(operations), target_ref: idSchema, params_ref: idSchema, risk_class: z.literal('fixture'), preconditions: z.array(predicateSchema).max(8), expected_postcondition: predicateSchema, policy_version: z.literal('p0-v1'), description: z.string().max(160) });
export type Candidate = z.infer<typeof candidateSchema>;
export interface Snapshot {
    session_id: string;
    snapshot_id: string;
    document_epoch: number;
    mutation_version: number;
    url: string;
    origin: string;
    created_at: number;
    expires_at: number;
    fingerprint: string;
    safe_summary: string;
    synthetic: boolean;
    nodes: ReadonlyArray<{
        role: string;
        name: string;
    }>;
    candidates: Candidate[];
}
export const usageSchema = z.strictObject({ input_tokens: z.number().int().nonnegative().max(1e9), output_tokens: z.number().int().nonnegative().max(1e9) });
export const decisionSchema = z.strictObject({ provider: z.enum(['mock', 'jev', 'scripted']), model: z.enum(['mock-v1', 'scripted-v1', 'jev-1.14.0']), snapshot_id: idSchema, candidate_id: idSchema, confidence: z.number().finite().min(0).max(1), usage: usageSchema.nullable(), elapsed_ms: z.number().finite().nonnegative(), request_count: z.number().int().min(0).max(2).default(1), retry_count: z.number().int().min(0).max(1).default(0), unknown_usage_requests: z.number().int().min(0).max(2).default(0), probabilities: z.record(z.string(), z.number().finite().min(0).max(1)).optional() });
export type Decision = z.infer<typeof decisionSchema>;
export function validateDecision(value: unknown, snapshot: string, candidates: string[]): Decision {
    const result = decisionSchema.safeParse(value);
    if (!result.success)
        throw new Fault('INVALID_DECISION');
    const d = result.data;
    const models = { mock: 'mock-v1', scripted: 'scripted-v1', jev: 'jev-1.14.0' };
    if (models[d.provider] !== d.model || d.snapshot_id !== snapshot || !candidates.includes(d.candidate_id))
        throw new Fault('INVALID_DECISION');
    if (d.probabilities) {
        const keys = Object.keys(d.probabilities);
        if (keys.length !== candidates.length || keys.some(k => !candidates.includes(k)) || Math.abs(Object.values(d.probabilities).reduce((a, b) => a + b, 0) - 1) > 1e-6)
            throw new Fault('INVALID_PROBABILITIES');
    }
    return d;
}
export interface DecisionInput {
    snapshot_id: string;
    synthetic: true;
    summary: string;
    goal: Pick<Goal, 'task' | 'language'>;
    candidates: ReadonlyArray<{
        candidate_id: string;
        description: string;
    }>;
}
export interface DecisionContext {
    remoteRequest?: import('../remote/protocol.js').DecisionRequest;
    signal: AbortSignal;
    deadline: number;
}
export interface DecisionProvider {
    decide(input: DecisionInput, context: DecisionContext): Promise<unknown>;
}
export interface BrowserPort {
    /** Trusted local commitments; required by remote profiles. No target or value leaves the host. */
    commitments?(sessionId:string,snapshot:Snapshot,goal:Goal,signal:AbortSignal):Promise<readonly import('../remote/protocol.js').CandidateCommitment[]>;
    open(sessionId: string, fixtureId: 'standard'): Promise<{
        allowed_origin: string;
    }>;
    observe(sessionId: string, goal?: Goal, signal?: AbortSignal): Promise<Snapshot>;
    validate(sessionId: string, snapshot: Snapshot, candidate: Candidate, goal: Goal, signal: AbortSignal): Promise<boolean>;
    execute(sessionId: string, candidate: Candidate, goal: Goal, signal: AbortSignal, authorization?:ExecutionAuthorization): Promise<void>;
    check(sessionId: string, predicate: Predicate, signal?: AbortSignal): Promise<boolean>;
    close(sessionId: string): Promise<void>;
}
export interface ExecutionAuthorization {expiresAtMonotonic:number;assertAuthorized:()=>void}
export type GoalStatus = 'RUNNING' | 'SUCCEEDED' | 'FALLBACK' | 'CANCELLED' | 'UNKNOWN';
export interface GoalResult {
    session_id: string;
    goal_id: string;
    idempotency_key: string;
    request_hash: string;
    status: GoalStatus;
    steps: number;
    elapsed_ms: number;
    reason: string | null;
    evidence: string[];
    action_ids: string[];
}
export type ActionStatus = 'VALIDATED' | 'EXECUTING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'REJECTED';
export interface ActionRecord {
    receipt?:{decision_id:string;nonce:string;receipt_digest:string;route:'jev'|'mock';owner_id:string;device_id:string;agent_id:string};
    action_id: string;
    session_id: string;
    goal_id: string;
    lease_epoch: number;
    idempotency_key: string;
    request_hash: string;
    snapshot_id: string;
    candidate_id: string;
    policy_version: string;
    status: ActionStatus;
    created_at: number;
    updated_at: number;
    validated_at?: number;
    execution_started_at?: number;
    verification_started_at?: number;
    completed_at?: number;
}
export interface SessionRecord {
    owner: string;
    fixture_id: 'standard';
    allowed_origin: string;
    epoch: number;
    quarantined: boolean;
    closed: boolean;
}
export interface LedgerState {
    version: 1 | 2;
    sessions: Record<string, SessionRecord>;
    goals: Record<string, GoalResult>;
    actions: Record<string, ActionRecord>;
}
