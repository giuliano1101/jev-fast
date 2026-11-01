import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { schemas, operations, candidateSchema, validateDecision, type BrowserPort, type DecisionProvider, type GoalResult, type Snapshot, type RunGoalRequest } from './contracts.js';
import { Fault, reason, ExecutionNotStarted } from './errors.js';
import { Ledger } from '../session/ledger.js';
import {prepareExecutionRequest,verifyExecutionReceipt,revalidateExecutionBinding,type RemoteExecutionPolicy} from '../remote/execution.js';
interface Lease {
    epoch: number;
    goal_id: string;
    controller: AbortController;
    deadline: number;
    inFlight: boolean;
    done: Promise<void>;
    resolveDone: () => void;
}
export interface EngineEvent {
    phase: 'observe' | 'candidate' | 'policy' | 'provider' | 'execute' | 'verify';
    elapsed_ms: number;
    session_id: string;
    goal_id: string;
    action_id?: string;
    provider?: string;
    model?: string;
    usage?: {
        input_tokens: number;
        output_tokens: number;
    } | null;
    requests?: number;
    retries?: number;
    unknown_usage_requests?: number;
}
export interface EngineOptions {
    storageDir: string;
    remotePolicy?:RemoteExecutionPolicy;
    browser: BrowserPort;
    provider: DecisionProvider;
    clients: readonly string[];
    sharedAccess?: Readonly<Record<string, readonly string[]>>;
    confidenceThreshold?: number;
    onEvent?: (event: EngineEvent) => void;
    onOwnerRevoked?: (owner:string) => Promise<void>;
}
/** The transport supplies a configured identity; no public request accepts client_id. */
export class Engine {
    readonly ledger: Ledger;
    private readonly leases = new Map<string, Lease>();
    private readonly opened = new Set<string>();
    private readonly pendingOpens = new Set<Promise<unknown>>();
    private readonly closing = new Set<string>();
    private readonly networkOwners = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly revokedOwners = new Set<string>();
    private readonly revokingOwners = new Map<string,Promise<void>>();
    private readonly pendingOwnerRevocations = new Set<string>();
    private readonly ownerOpens = new Map<Promise<unknown>,string>();
    private readonly failedOpenCloses = new Map<string,string>();
    private readonly observations = new Map<string,Promise<unknown>>();
    private readonly pendingCloses = new Map<string, Promise<{closed:boolean;quarantined:boolean}>>();
    private shutdownPromise?: Promise<void>;
    private killed = false;
    private stopped = false;
    private constructor(private readonly options: EngineOptions, ledger: Ledger) { this.ledger = ledger; }
    static async create(options: EngineOptions): Promise<Engine> { if (options.clients.length === 0)
        throw new Fault('NO_CLIENTS'); const threshold = options.confidenceThreshold ?? .9; if (!Number.isFinite(threshold) || threshold < .9 || threshold > 1)
        throw new Fault('INVALID_THRESHOLD'); return new Engine(options, await Ledger.open(options.storageDir)); }
    private auth(client: string, sessionId?: string) { if (this.revokedOwners.has(client)||(!this.options.clients.includes(client)&&!this.networkOwners.has(client)))
        throw new Fault('UNAUTHORIZED'); if (!sessionId)
        return; const session = this.ledger.state.sessions[sessionId]; if (!session || (session.owner !== client && !this.options.sharedAccess?.[session.owner]?.includes(client)))
        throw new Fault('UNAUTHORIZED'); return session; }
    /** Authorize coordinator extensions against the same configured identity boundary. */
    authorizeClient(client:string):void {this.auth(client);}
    /** Trusted coordinator capability; never exposed as an MCP argument. */
    grantNetworkOwner(owner:string) {
        if(!/^network-[a-f0-9]{64}$/.test(owner))throw new Fault('INVALID_NETWORK_OWNER');
        if(this.revokedOwners.has(owner))throw new Fault('OWNER_REVOKED');
        this.live();
        clearTimeout(this.networkOwners.get(owner));
        const timer=setTimeout(()=>{void this.revokeNetworkOwner(owner).catch(()=>{});},5000);timer.unref();this.networkOwners.set(owner,timer);
    }
    async revokeNetworkOwner(owner:string) {
        if(!/^network-[a-f0-9]{64}$/.test(owner))throw new Fault('INVALID_NETWORK_OWNER');
        const existing=this.revokingOwners.get(owner);if(existing)return existing;
        clearTimeout(this.networkOwners.get(owner));this.networkOwners.delete(owner);this.revokedOwners.add(owner);this.pendingOwnerRevocations.add(owner);
        const pending=(async()=>{
        const sessions=Object.entries(this.ledger.state.sessions).filter(([,s])=>s.owner===owner).map(([id])=>id);
        for(const id of sessions)this.leases.get(id)?.controller.abort();
        await this.options.onOwnerRevoked?.(owner);
        await Promise.allSettled([...this.ownerOpens].filter(([,o])=>o===owner).map(([p])=>p));
        for(const [id,allocatedOwner] of this.failedOpenCloses)if(allocatedOwner===owner)await this.retryOpenCleanup(id);
        for(const [id,session] of Object.entries(this.ledger.state.sessions))if(session.owner===owner)await this.closeOwnedSession(id);
        })();this.revokingOwners.set(owner,pending);
        try{await pending;this.pendingOwnerRevocations.delete(owner);}finally{if(this.revokingOwners.get(owner)===pending)this.revokingOwners.delete(owner);}
    }
    async reconcileNetworkOwners(owners:readonly string[]) {
        if(new Set(owners).size!==owners.length)throw new Fault('OWNER_CAPACITY');
        for(const owner of owners)if(!/^network-[a-f0-9]{64}$/.test(owner)||this.revokedOwners.has(owner))throw new Fault('OWNER_REVOKED');
        // Revoke admission synchronously, then drain every removed owner's work before granting.
        await Promise.all([...new Set([...this.networkOwners.keys()].filter(owner=>!owners.includes(owner)).concat([...this.pendingOwnerRevocations]))].map(owner=>this.revokeNetworkOwner(owner)));
        await Promise.all([...this.revokingOwners.values()]);
        for(const owner of owners)this.grantNetworkOwner(owner);
        return {owners:[...this.networkOwners.keys()]};
    }
    private emit(event: EngineEvent) { try {
        this.options.onEvent?.(event);
    }
    catch { /* Telemetry is observational and cannot change action state. */ } }
    private live() { if (this.killed || this.stopped)
        throw new Fault('KILLED'); }
    async openSession(client: string, input: unknown) {
        this.auth(client);
        this.live();
        const request=schemas.open_session.parse(input);
        const session_id=randomUUID();
        const pending=(async()=>{
            let allocated=false;
            try {
                const opened=await this.options.browser.open(session_id,request.fixture_id);
                allocated=true;
                this.live();this.auth(client);
                const url=new URL(opened.allowed_origin);
                if(url.origin!==opened.allowed_origin||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port)throw new Fault('OUT_OF_SCOPE');
                await this.ledger.transaction(state=>{state.sessions[session_id]={owner:client,fixture_id:request.fixture_id,allowed_origin:opened.allowed_origin,epoch:0,quarantined:false,closed:false};});
                this.live();this.auth(client);
                this.opened.add(session_id);
                return {session_id,capabilities:[...operations],allowed_origin:opened.allowed_origin};
            }catch(error){
                if(allocated){try{await this.options.browser.close(session_id);}catch(cleanupError){this.failedOpenCloses.set(session_id,client);throw cleanupError;}}
                throw error;
            }
        })();
        this.pendingOpens.add(pending);this.ownerOpens.set(pending,client);
        try{return await pending;}finally{this.pendingOpens.delete(pending);this.ownerOpens.delete(pending);}
    }
    async observe(client:string,input:unknown) {
        const {session_id}=schemas.observe.parse(input);
        if(this.stopped)throw new Fault('KILLED');
        const session=this.auth(client,session_id)!;
        if(session.closed||this.closing.has(session_id)||!this.opened.has(session_id))throw new Fault('SESSION_UNAVAILABLE');
        if(this.leases.has(session_id)||this.observations.has(session_id))throw new Fault('BUSY');
        const pending=(async()=>{
            const snap=await this.options.browser.observe(session_id);
            this.auth(client,session_id);this.snapshotSafe(session_id,snap);
            return {snapshot_id:snap.snapshot_id,document_epoch:snap.document_epoch,mutation_version:snap.mutation_version,expires_at:snap.expires_at,summary:snap.safe_summary,candidates:snap.candidates.map(c=>({candidate_id:c.candidate_id,operation:c.operation,description:c.description}))};
        })();
        this.observations.set(session_id,pending);
        try{return await pending;}finally{this.observations.delete(session_id);}
    }
    private snapshotSafe(sessionId: string, snapshot: Snapshot) { const session = this.ledger.state.sessions[sessionId]; let url: URL; try {
        url = new URL(snapshot.url);
    }
    catch {
        throw new Fault('OUT_OF_SCOPE');
    } if (!snapshot.synthetic || snapshot.session_id !== sessionId || snapshot.origin !== session?.allowed_origin || url.origin !== snapshot.origin || url.search || url.hash)
        throw new Fault('UNSAFE_OBSERVATION'); if (!Number.isFinite(snapshot.created_at) || !Number.isFinite(snapshot.expires_at) || snapshot.expires_at - snapshot.created_at > 2000 || snapshot.created_at > Date.now() + 10)
        throw new Fault('STALE_SNAPSHOT'); const ids = new Set<string>(); for (const c of snapshot.candidates) {
        if (!candidateSchema.safeParse(c).success || c.snapshot_id !== snapshot.snapshot_id || ids.has(c.candidate_id))
            throw new Fault('INVALID_CANDIDATE');
        ids.add(c.candidate_id);
    } }
    private fence(sessionId: string, lease: Lease) { this.live(); if (lease.controller.signal.aborted)
        throw new Fault('CANCELLED'); if (performance.now() >= lease.deadline)
        throw new Fault('TIME_BUDGET'); const session = this.ledger.state.sessions[sessionId]; if (this.leases.get(sessionId) !== lease || session?.epoch !== lease.epoch)
        throw new Fault('FENCED'); if (session.quarantined || session.closed)
        throw new Fault('QUARANTINED'); }
    private async bounded<T>(promise:Promise<T>,lease:Lease):Promise<T> {
        if(lease.deadline<=performance.now())throw new Fault('TIME_BUDGET');
        return new Promise<T>((resolve,reject)=>{
            let timer:ReturnType<typeof setTimeout>|undefined;
            const cleanup=()=>{
                clearTimeout(timer);
                lease.controller.signal.removeEventListener('abort',abort);
            };
            const abort=()=>{cleanup();reject(new Fault('CANCELLED'));};
            // Node clamps overflowed delays to 1 ms. Schedule long caller limits in
            // chunks and leave an omitted deadline unscheduled, with abort active.
            const schedule=()=>{
                const remaining=lease.deadline-performance.now();
                if(remaining<=0){cleanup();reject(new Fault('TIME_BUDGET'));}
                else if(Number.isFinite(remaining))timer=setTimeout(schedule,Math.min(remaining,2147483647));
            };
            lease.controller.signal.addEventListener('abort',abort,{once:true});
            if(lease.controller.signal.aborted)abort();else schedule();
            promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
        });
    }
    private goalKey(sessionId: string, goalId: string) { return `${sessionId}:${goalId}`; }
    async runGoal(client: string, input: unknown): Promise<GoalResult> {
        const request = schemas.run_goal.parse(input);
        const session = this.auth(client, request.session_id)!;
        const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
        const prior = this.ledger.findGoal(request.session_id, request.idempotency_key);
        if (prior) {
            if (prior.request_hash !== hash)
                throw new Fault('IDEMPOTENCY_CONFLICT');
            return structuredClone(prior);
        }
        this.live();
        if (session.closed || this.closing.has(request.session_id) || !this.opened.has(request.session_id))
            throw new Fault('SESSION_UNAVAILABLE');
        if (session.quarantined)
            throw new Fault('QUARANTINED');
        if (this.leases.has(request.session_id)||this.observations.has(request.session_id))
            throw new Fault('BUSY');
        const key = this.goalKey(request.session_id, request.goal_id);
        if (this.ledger.state.goals[key])
            throw new Fault('GOAL_CONFLICT');
        const start = performance.now();
        let resolveDone!: () => void;
        const done = new Promise<void>(resolve => { resolveDone = resolve; });
        const lease: Lease = { epoch: session.epoch + 1, goal_id: request.goal_id, controller: new AbortController(), deadline: request.time_budget_ms === undefined ? Infinity : start + request.time_budget_ms, inFlight: false, done, resolveDone };
        this.leases.set(request.session_id, lease);
        try {
            await this.ledger.transaction(s => { s.sessions[request.session_id]!.epoch = lease.epoch; s.goals[key] = { session_id: request.session_id, goal_id: request.goal_id, idempotency_key: request.idempotency_key, request_hash: hash, status: 'RUNNING', steps: 0, elapsed_ms: 0, reason: null, evidence: [], action_ids: [] }; });
            await this.run(request, lease, key, start);
        }
        catch (e) {
            const current: GoalResult | undefined = Object.values(this.ledger.state.goals).find(g => g.session_id === request.session_id && g.goal_id === request.goal_id);
            if (!current)
                throw e;
            if (current.status === 'RUNNING') {
                await this.finish(key, lease.inFlight ? 'UNKNOWN' : reason(e) === 'CANCELLED' ? 'CANCELLED' : 'FALLBACK', reason(e), start);
            }
        }
        finally {
            lease.controller.abort();
            if (this.leases.get(request.session_id) === lease)
                this.leases.delete(request.session_id);
            lease.resolveDone();
        }
        return structuredClone(this.ledger.state.goals[key]!);
    }
    private async finish(key: string, status: GoalResult['status'], why: string | null, start: number) { await this.ledger.transaction(s => { const g = s.goals[key]!; g.status = status; g.reason = why; g.elapsed_ms = performance.now() - start; if(status==='CANCELLED'||status==='UNKNOWN')s.sessions[g.session_id]!.epoch++; if (status === 'UNKNOWN') {
        s.sessions[g.session_id]!.quarantined = true;
        for (const id of g.action_ids) {
            const a = s.actions[id]!;
            if (a.status === 'EXECUTING' || a.status === 'VERIFYING') {
                a.status = 'UNKNOWN';
                a.updated_at = Date.now();
                a.completed_at = Date.now();
            }
        }
    } }); }
    private async run(req: RunGoalRequest, lease: Lease, key: string, start: number) {
        let noops = 0;let staleRetries=0;
        const signal = lease.controller.signal;
        for (let step = 0; step < (req.max_steps ?? Infinity); step++) {
            this.fence(req.session_id, lease);
            const before = performance.now();
            const snapshotStarted=performance.now();
            const snapshot = await this.bounded(this.options.browser.observe(req.session_id, req.goal, signal), lease);
            this.emit({ phase: 'observe', elapsed_ms: performance.now() - before, session_id: req.session_id, goal_id: req.goal_id });
            const candidateStart = performance.now();
            this.snapshotSafe(req.session_id, snapshot);
            this.emit({ phase: 'candidate', elapsed_ms: performance.now() - candidateStart, session_id: req.session_id, goal_id: req.goal_id });
            this.fence(req.session_id, lease);
            if (await this.bounded(this.options.browser.check(req.session_id, req.success, signal), lease)) {
                await this.finish(key, 'SUCCEEDED', null, start);
                return;
            }
            if (!snapshot.candidates.length)
                throw new Fault('NO_CANDIDATES');
            const decidedAt = performance.now();
            const input={snapshot_id:snapshot.snapshot_id,synthetic:true as const,summary:snapshot.safe_summary,goal:{task:req.goal.task,language:req.goal.language},candidates:snapshot.candidates.map(c=>({candidate_id:c.candidate_id,description:c.description}))};
            const remote=this.options.remotePolicy?await this.bounded(prepareExecutionRequest(this.options.browser,snapshot,req.goal,req.goal_id,lease.epoch,input,snapshotStarted,lease.deadline,signal),lease):undefined;
            const raw=await this.bounded(this.options.provider.decide(structuredClone(input),{signal,deadline:Math.min(snapshot.expires_at,Date.now()+Math.max(0,lease.deadline-performance.now())),...(remote?{remoteRequest:structuredClone(remote.request)}:{})}),lease);
            const response=remote?structuredClone(raw):raw;
            const permission=remote?verifyExecutionReceipt(response,remote,this.options.remotePolicy!):undefined;
            const decision=validateDecision(permission?.decision??response,snapshot.snapshot_id,snapshot.candidates.map(c=>c.candidate_id));
            this.emit({ phase: 'provider', elapsed_ms: performance.now() - decidedAt, session_id: req.session_id, goal_id: req.goal_id, provider: decision.provider, model: decision.model, usage: decision.usage, requests: decision.request_count, retries: decision.retry_count, unknown_usage_requests: decision.unknown_usage_requests });
            const policyStart = performance.now();
            if (decision.confidence < (this.options.confidenceThreshold ?? .9))
                throw new Fault('LOW_CONFIDENCE');
            this.fence(req.session_id, lease);
            if (Date.now() >= snapshot.expires_at)
                throw new Fault('STALE_SNAPSHOT');
            const candidate = snapshot.candidates.find(c => c.candidate_id === decision.candidate_id)!;
            for (const predicate of candidate.preconditions)
                if (!await this.bounded(this.options.browser.check(req.session_id, predicate, signal), lease))
                    throw new Fault('PRECONDITION_FAILED');
            if (!await this.bounded(this.options.browser.validate(req.session_id, snapshot, candidate, req.goal, signal), lease)){if(staleRetries++<2){step--;continue;}throw new Fault('STALE_SNAPSHOT');}
            this.fence(req.session_id, lease);
            if (Date.now() >= snapshot.expires_at)
                throw new Fault('STALE_SNAPSHOT');
            if(remote){await this.bounded(revalidateExecutionBinding(this.options.browser,snapshot,req.goal,remote,signal),lease);verifyExecutionReceipt(response,remote,this.options.remotePolicy!);}
            this.emit({ phase: 'policy', elapsed_ms: performance.now() - policyStart, session_id: req.session_id, goal_id: req.goal_id });
            const action_id = randomUUID();
            await this.ledger.transaction(s => { s.actions[action_id] = { action_id, session_id: req.session_id, goal_id: req.goal_id, lease_epoch: lease.epoch, idempotency_key: req.idempotency_key, request_hash: s.goals[key]!.request_hash, snapshot_id: snapshot.snapshot_id, candidate_id: candidate.candidate_id, policy_version: candidate.policy_version, status: 'VALIDATED', created_at: Date.now(), updated_at: Date.now(), validated_at: Date.now() }; s.goals[key]!.action_ids.push(action_id); });
            this.fence(req.session_id, lease);
            await this.ledger.transaction(s => { if(remote){const permit=verifyExecutionReceipt(response,remote,this.options.remotePolicy!);s.actions[action_id]!.receipt={decision_id:permit.decision_id,nonce:permit.nonce,receipt_digest:permit.receipt_digest,route:permit.route,...this.options.remotePolicy!.identity};} s.actions[action_id]!.status = 'EXECUTING'; s.actions[action_id]!.updated_at = Date.now(); s.actions[action_id]!.execution_started_at = Date.now(); s.goals[key]!.steps++; });
            lease.inFlight = true;
            this.fence(req.session_id, lease);
            const executionStart = performance.now();
            try {
                if(Date.now()>=snapshot.expires_at)throw new ExecutionNotStarted();
                let authorization;
                if(remote){try{const permit=verifyExecutionReceipt(response,remote,this.options.remotePolicy!);authorization={expiresAtMonotonic:permit.expires_at_monotonic_ms,assertAuthorized:()=>{this.fence(req.session_id,lease);verifyExecutionReceipt(response,remote,this.options.remotePolicy!);}};}catch{throw new ExecutionNotStarted();}}
                await this.bounded(this.options.browser.execute(req.session_id,candidate,req.goal,signal,authorization),lease);
            } catch(error) {
                if(!(error instanceof ExecutionNotStarted))throw error;
                await this.ledger.transaction(state=>{const action=state.actions[action_id]!;action.status='REJECTED';action.completed_at=Date.now();action.updated_at=Date.now();state.goals[key]!.steps--;state.goals[key]!.evidence.push('REJECTED_BEFORE_EXECUTION');});
                lease.inFlight=false;
                // A proven non-dispatch consumes a stale retry, never a physical action step.
                if(staleRetries++<2){step--;continue;}
                throw new Fault('STALE_SNAPSHOT');
            }
            this.emit({ phase: 'execute', elapsed_ms: performance.now() - executionStart, session_id: req.session_id, goal_id: req.goal_id, action_id });
            const verifyStart = performance.now();
            this.fence(req.session_id, lease);
            await this.ledger.transaction(s => { s.actions[action_id]!.status = 'VERIFYING'; s.actions[action_id]!.updated_at = Date.now(); s.actions[action_id]!.verification_started_at = Date.now(); });
            const after = await this.bounded(this.options.browser.observe(req.session_id, req.goal, signal), lease);
            this.snapshotSafe(req.session_id, after);
            const verified = await this.bounded(this.options.browser.check(req.session_id, candidate.expected_postcondition, signal), lease);
            this.fence(req.session_id, lease);
            await this.ledger.transaction(s => { s.actions[action_id]!.status = verified ? 'SUCCEEDED' : 'FAILED'; s.actions[action_id]!.updated_at = Date.now(); s.actions[action_id]!.completed_at = Date.now(); s.goals[key]!.evidence.push(verified ? 'POSTCONDITION_VERIFIED' : 'POSTCONDITION_FAILED'); });
            lease.inFlight = false;
            this.emit({ phase: 'verify', elapsed_ms: performance.now() - verifyStart, session_id: req.session_id, goal_id: req.goal_id, action_id });
            if (verified && await this.bounded(this.options.browser.check(req.session_id, req.success, signal), lease)) {
                await this.finish(key, 'SUCCEEDED', null, start);
                return;
            }
            noops = after.fingerprint === snapshot.fingerprint ? noops + 1 : 0;
            if (noops >= 2)
                throw new Fault('NO_PROGRESS');
            if (!verified && noops === 0)
                throw new Fault('POSTCONDITION_FAILED');
        }
        throw new Fault('STEP_BUDGET');
    }
    async cancel(client:string,input:unknown) {
        const request=schemas.cancel.parse(input);
        this.auth(client,request.session_id);
        const key=this.goalKey(request.session_id,request.goal_id);
        const lease=this.leases.get(request.session_id);
        if(lease?.goal_id===request.goal_id){
            lease.controller.abort();
            await lease.done;
        }
        const goal=this.ledger.state.goals[key];
        if(!goal)throw new Fault('NOT_FOUND');
        return {status:goal.status,unknown_action:goal.status==='UNKNOWN'};
    }
    async status(client: string, input: unknown) { const request = schemas.status.parse(input); const session = this.auth(client, request.session_id)!; if (request.goal_id) {
        const result = this.ledger.state.goals[this.goalKey(request.session_id, request.goal_id)];
        if (!result)
            throw new Fault('NOT_FOUND');
        return structuredClone(result);
    } if (request.action_id) {
        const result = this.ledger.state.actions[request.action_id];
        if (!result || result.session_id !== request.session_id)
            throw new Fault('NOT_FOUND');
        return structuredClone(result);
    } return { session_id: request.session_id, closed: session.closed, quarantined: session.quarantined, busy: this.leases.has(request.session_id) }; }
    async closeSession(client:string,input:unknown) {
        const {session_id}=schemas.close_session.parse(input);
        this.auth(client,session_id);
        return this.closeOwnedSession(session_id);
    }
    private async retryOpenCleanup(session_id:string){
        if(this.ledger.state.sessions[session_id])await this.closeOwnedSession(session_id);
        else await this.options.browser.close(session_id);
        this.failedOpenCloses.delete(session_id);
    }
    private async closeOwnedSession(session_id:string) {
        const session=this.ledger.state.sessions[session_id]!;
        const existing=this.pendingCloses.get(session_id);
        if(existing)return existing;
        if(session.closed&&!this.opened.has(session_id)&&!this.failedOpenCloses.has(session_id))return {closed:true,quarantined:session.quarantined};
        this.closing.add(session_id);
        const pending=(async()=>{
            const lease=this.leases.get(session_id);
            if(lease){lease.controller.abort();await lease.done;}
            await this.observations.get(session_id)?.catch(()=>{});
            if(!session.closed)await this.ledger.transaction(state=>{state.sessions[session_id]!.closed=true;state.sessions[session_id]!.epoch++;});
            await this.options.browser.close(session_id);
            this.opened.delete(session_id);
            return {closed:true,quarantined:this.ledger.state.sessions[session_id]!.quarantined};
        })();
        this.pendingCloses.set(session_id,pending);
        try{return await pending;}finally{this.pendingCloses.delete(session_id);}
    }
    async kill() {
        this.killed=true;
        const active=[...this.leases.values()];
        for(const lease of active)lease.controller.abort();
        await Promise.all(active.map(lease=>lease.done));
    }
    shutdown():Promise<void> {
        if(this.shutdownPromise)return this.shutdownPromise;
        this.stopped=true;
        for(const timer of this.networkOwners.values())clearTimeout(timer);
        this.shutdownPromise=(async()=>{
            await this.kill();
            await Promise.allSettled([...this.pendingOpens,...this.pendingCloses.values(),...this.observations.values(),...this.revokingOwners.values()]);
            const errors:unknown[]=[];
            for(const id of this.failedOpenCloses.keys()){try{await this.retryOpenCleanup(id);}catch(error){errors.push(error);}}
            for(const id of this.opened){
                try{await this.options.browser.close(id);this.opened.delete(id);}catch(error){errors.push(error);}
            }
            try{await this.ledger.close();}catch(error){errors.push(error);}
            if(errors.length===1)throw errors[0];
            if(errors.length)throw new AggregateError(errors,'Engine shutdown cleanup failed');
        })().catch(error=>{this.shutdownPromise=undefined;throw error;});
        return this.shutdownPromise;
    }
}
