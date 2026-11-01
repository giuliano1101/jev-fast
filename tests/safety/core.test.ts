import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../src/core/engine.js';
import { MockProvider } from '../../src/providers/mock.js';
import type { BrowserPort, Candidate, Goal, Predicate, Snapshot } from '../../src/core/contracts.js';
class FakeBrowser implements BrowserPort {
    executions = 0;
    done = false;
    stale = false;
    noop = false;
    hung = false;
    observed = 0;
    async open() { return { allowed_origin: 'http://127.0.0.1:7777' }; }
    async observe(session_id: string, _goal?: Goal): Promise<Snapshot> { this.observed++; const now = Date.now(); return { session_id, snapshot_id: 'snap' + this.observed, document_epoch: 1, mutation_version: 0, url: 'http://127.0.0.1:7777/form', origin: 'http://127.0.0.1:7777', created_at: now, expires_at: now + 2000, fingerprint: this.done ? 'done' : 'same', safe_summary: 'synthetic form', synthetic: true, nodes: [], candidates: [{ candidate_id: 'c', snapshot_id: 'snap' + this.observed, operation: 'click', target_ref: 'submit', params_ref: 'local', risk_class: 'fixture', preconditions: [], expected_postcondition: { kind: 'task_complete' }, policy_version: 'p0-v1', description: 'Complete synthetic form' }] }; }
    async validate() { return !this.stale; }
    async execute(_session: string, _candidate: Candidate, _goal: Goal, _signal: AbortSignal) { this.executions++; if (this.hung)
        await new Promise(() => { }); if (!this.noop)
        this.done = true; }
    async check(_session: string, _predicate: Predicate) { return this.done; }
    async close() { }
}
const req = (session_id: string) => ({ session_id, goal_id: 'g', idempotency_key: 'id', goal: { task: 'form' as const, language: 'en' as const, seed: 1 }, success: { kind: 'task_complete' as const } });
async function setup(provider = new MockProvider()) { const dir = await mkdtemp(join(tmpdir(), 'jev-core-')); const browser = new FakeBrowser(); const engine = await Engine.create({ storageDir: dir, browser, provider, clients: ['a', 'b'] }); const session = await engine.openSession('a', { fixture_id: 'standard' }); return { dir, browser, engine, s: session.session_id, cleanup: async () => { await engine.shutdown(); await rm(dir, { recursive: true, force: true }); } }; }
test('idempotent result survives restart; different request conflicts; unauthorized observers fail', async () => {
    const f = await setup();
    try {
        const r = await f.engine.runGoal('a', req(f.s));
        assert.equal(r.status, 'SUCCEEDED');
        assert.deepEqual(await f.engine.runGoal('a', req(f.s)), r);
        assert.equal(f.browser.executions, 1);
        await assert.rejects(f.engine.runGoal('a', { ...req(f.s), goal: { task: 'form', language: 'zh', seed: 1 } }), /IDEMPOTENCY_CONFLICT/);
        await assert.rejects(f.engine.observe('b', { session_id: f.s }), /UNAUTHORIZED/);
        await f.engine.shutdown();
        const e = await Engine.create({ storageDir: f.dir, browser: f.browser, provider: new MockProvider(), clients: ['a'] });
        assert.deepEqual(await e.runGoal('a', req(f.s)), r);
        await e.shutdown();
        const content = await readFile(join(f.dir, 'ledger.json'), 'utf8');
        assert.ok(!content.includes('synthetic form'));
        assert.ok(!content.includes('safe_summary'));
    }
    finally {
        await f.cleanup();
    }
});
test('stale validation prevents physical action', async () => { const f = await setup(); try {
    f.browser.stale = true;
    assert.equal((await f.engine.runGoal('a', req(f.s))).reason, 'STALE_SNAPSHOT');
    assert.equal(f.browser.executions, 0);
}
finally {
    await f.cleanup();
} });
test('two no-op actions stop loop', async () => { const f = await setup(); try {
    f.browser.noop = true;
    assert.equal((await f.engine.runGoal('a', req(f.s))).reason, 'NO_PROGRESS');
    assert.equal(f.browser.executions, 2);
}
finally {
    await f.cleanup();
} });
test('execution timeout is UNKNOWN and quarantines new work', async () => { const f = await setup(); try {
    f.browser.hung = true;
    // Leave room for real fsync setup under concurrent test load; the executor still never resolves.
    const r = await f.engine.runGoal('a', { ...req(f.s), time_budget_ms: 1000 });
    assert.equal(r.status, 'UNKNOWN');
    await assert.rejects(f.engine.runGoal('a', { ...req(f.s), goal_id: 'g2', idempotency_key: 'id2' }), /QUARANTINED/);
    assert.equal(f.browser.executions, 1);
}
finally {
    await f.cleanup();
} });
test('kill prevents decisions and future actions', async () => { const f = await setup(); try {
    await f.engine.kill();
    await assert.rejects(f.engine.runGoal('a', req(f.s)), /KILLED/);
    assert.equal(f.browser.executions, 0);
}
finally {
    await f.cleanup();
} });
test('cancel an in-flight action preserves UNKNOWN and cannot overlap', async () => { const f = await setup(); try {
    f.browser.hung = true;
    const running = f.engine.runGoal('a', req(f.s));
    while (!f.browser.executions)
        await new Promise(r => setTimeout(r, 1));
    await assert.rejects(f.engine.runGoal('a', { ...req(f.s), goal_id: 'g2', idempotency_key: 'id2' }), /BUSY/);
    const cancel = await f.engine.cancel('a', { session_id: f.s, goal_id: 'g' });
    assert.equal(cancel.status, 'UNKNOWN');
    assert.equal((await running).status, 'UNKNOWN');
    assert.equal(f.browser.executions, 1);
}
finally {
    await f.cleanup();
} });
test('low confidence, invalid choice, malformed probabilities never execute', async () => {
    for (const patch of [{ confidence: 0.89 }, { candidate_id: 'outside' }, { probabilities: { c: .5 } }, { model: 'unknown' }, { confidence: NaN }]) {
        const provider = new MockProvider();
        provider.decide = async (input) => ({ ...{ provider: 'mock', model: 'mock-v1', snapshot_id: input.snapshot_id, candidate_id: 'c', confidence: 1, usage: null, elapsed_ms: 0 }, ...patch }) as never;
        const f = await setup(provider);
        try {
            assert.equal((await f.engine.runGoal('a', req(f.s))).status, 'FALLBACK');
            assert.equal(f.browser.executions, 0);
        }
        finally {
            await f.cleanup();
        }
    }
});
test('decision budget expires and late response never executes', async () => { const provider = new MockProvider(); provider.decide = async (input) => { await new Promise(r => setTimeout(r, 100)); return { provider: 'mock', model: 'mock-v1', snapshot_id: input.snapshot_id, candidate_id: 'c', confidence: 1, usage: null, elapsed_ms: 100, request_count: 0, retry_count: 0, unknown_usage_requests: 0 }; }; const f = await setup(provider); try {
    assert.equal((await f.engine.runGoal('a', { ...req(f.s), time_budget_ms: 30 })).reason, 'TIME_BUDGET');
    await new Promise(r => setTimeout(r, 120));
    assert.equal(f.browser.executions, 0);
}
finally {
    await f.cleanup();
} });
test('step cap stops a progressing but unfinished goal', async () => { const f = await setup(); try {
    f.browser.check = async () => false;
    f.browser.observe = async (s, g) => { const snap = await FakeBrowser.prototype.observe.call(f.browser, s, g); snap.fingerprint = String(f.browser.observed); snap.candidates[0]!.expected_postcondition = { kind: 'flag', name: 'loaded', value: true }; return snap; };
    f.browser.check = async (_s, p) => p.kind === 'flag';
    assert.equal((await f.engine.runGoal('a', { ...req(f.s), max_steps: 1 })).reason, 'STEP_BUDGET');
    assert.equal(f.browser.executions, 1);
}
finally {
    await f.cleanup();
} });
test('empty candidates and unsafe summary abort before provider', async () => { for (const mode of ['empty', 'unsafe']) {
    const f = await setup();
    try {
        f.browser.observe = async (s, g) => { const snap = await FakeBrowser.prototype.observe.call(f.browser, s, g); if (mode === 'empty')
            snap.candidates = []; if (mode === 'unsafe')
            snap.synthetic = false; return snap; };
        assert.equal((await f.engine.runGoal('a', req(f.s))).status, 'FALLBACK');
        assert.equal(f.browser.executions, 0);
    }
    finally {
        await f.cleanup();
    }
} });
test('cancellation during provider selection fences its late answer', async () => { let started = false; const provider = new MockProvider(); provider.decide = async (input) => { started = true; await new Promise(r => setTimeout(r, 80)); return { provider: 'mock', model: 'mock-v1', snapshot_id: input.snapshot_id, candidate_id: 'c', confidence: 1, usage: null, elapsed_ms: 80, request_count: 0, retry_count: 0, unknown_usage_requests: 0 }; }; const f = await setup(provider); try {
    const running = f.engine.runGoal('a', req(f.s));
    while (!started)
        await new Promise(r => setTimeout(r, 1));
    await f.engine.cancel('a', { session_id: f.s, goal_id: 'g' });
    assert.equal((await running).status, 'CANCELLED');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(f.browser.executions, 0);
}
finally {
    await f.cleanup();
} });
test('a true goal cannot override a failed action postcondition', async () => { const f = await setup(); try {
    f.browser.check = async (_s, p) => p.kind === 'task_complete' && f.browser.done;
    f.browser.observe = async (s, g) => { const snap = await FakeBrowser.prototype.observe.call(f.browser, s, g); snap.candidates[0]!.expected_postcondition = { kind: 'flag', name: 'loaded', value: true }; return snap; };
    const result = await f.engine.runGoal('a', req(f.s));
    assert.equal(result.status, 'FALLBACK');
    assert.equal(result.reason, 'POSTCONDITION_FAILED');
}
finally {
    await f.cleanup();
} });
test('shutdown waits for active goal terminal persistence', async () => { const f = await setup(); try {
    f.browser.hung = true;
    const running = f.engine.runGoal('a', req(f.s));
    while (!f.browser.executions)
        await new Promise(r => setTimeout(r, 1));
    await f.engine.shutdown();
    assert.equal((await running).status, 'UNKNOWN');
    const state = JSON.parse(await readFile(join(f.dir, 'ledger.json'), 'utf8'));
    assert.equal(Object.values(state.goals).every((g) => (g as {
        status: string;
    }).status !== 'RUNNING'), true);
}
finally {
    await f.cleanup();
} });
test('telemetry distinguishes every phase and counts provider requests without values', async () => { const dir = await mkdtemp(join(tmpdir(), 'jev-telemetry-')); const browser = new FakeBrowser(); const events: unknown[] = []; const engine = await Engine.create({ storageDir: dir, browser, provider: new MockProvider(), clients: ['a'], onEvent: e => events.push(e) }); try {
    const { session_id } = await engine.openSession('a', { fixture_id: 'standard' });
    await engine.runGoal('a', req(session_id));
    const phases = events.map(e => (e as {
        phase: string;
    }).phase);
    for (const phase of ['observe', 'candidate', 'policy', 'provider', 'execute', 'verify'])
        assert.ok(phases.includes(phase), phase);
    const provider = events.find(e => (e as {
        phase: string;
    }).phase === 'provider') as {
        requests: number;
    };
    assert.equal(provider.requests, 0);
    assert.ok(!JSON.stringify(events).includes('synthetic form'));
}
finally {
    await engine.shutdown();
    await rm(dir, { recursive: true, force: true });
} });
test('unknown execution records its attempted step and durable stage timestamps', async () => { const f = await setup(); try {
    f.browser.hung = true;
    const result = await f.engine.runGoal('a', { ...req(f.s), time_budget_ms: 80 });
    assert.equal(result.status, 'UNKNOWN');
    assert.equal(result.steps, 1);
    const action = await f.engine.status('a', { session_id: f.s, action_id: result.action_ids[0] }) as {
        validated_at?: number;
        execution_started_at?: number;
        completed_at?: number;
    };
    assert.equal(typeof action.validated_at, 'number');
    assert.equal(typeof action.execution_started_at, 'number');
    assert.equal(typeof action.completed_at, 'number');
}
finally {
    await f.cleanup();
} });
test('immediate shutdown drains a goal whose initial ledger transaction is pending',async()=>{const f=await setup();try{const running=f.engine.runGoal('a',req(f.s));await f.engine.shutdown();const result=await running;assert.ok(['CANCELLED','FALLBACK'].includes(result.status));assert.equal(f.browser.executions,0);}finally{await f.cleanup();}});
test('closing session rejects a new goal before browser close completes',async()=>{const f=await setup();let release!:()=>void;let entered=false;const gate=new Promise<void>(r=>release=r);f.browser.close=async()=>{entered=true;await gate;};const closing=f.engine.closeSession('a',{session_id:f.s});try{while(!entered)await new Promise(r=>setTimeout(r,1));await assert.rejects(f.engine.runGoal('a',req(f.s)),/SESSION_UNAVAILABLE/);assert.equal(f.browser.executions,0);}finally{release();await closing;await f.cleanup();}});
test('shutdown drains and cleans a pending browser open',async()=>{const dir=await mkdtemp(join(tmpdir(),'jev-open-'));const browser=new FakeBrowser();let release!:()=>void;let closed=0;const gate=new Promise<void>(r=>release=r);browser.open=async()=>{await gate;return {allowed_origin:'http://127.0.0.1:7777'};};browser.close=async()=>{closed++;};const engine=await Engine.create({storageDir:dir,browser,provider:new MockProvider(),clients:['a']});const opening=engine.openSession('a',{fixture_id:'standard'});const settled=opening.then(()=>({ok:true}),e=>({ok:false,error:e}));try{const shutting=engine.shutdown();await new Promise(r=>setTimeout(r,10));release();await shutting;assert.equal((await settled).ok,false);assert.equal(closed,1);}finally{release();await engine.shutdown();await rm(dir,{recursive:true,force:true});}});
test('immediate cancel works before initial goal persistence',async()=>{const f=await setup();try{const running=f.engine.runGoal('a',req(f.s));const result=await f.engine.cancel('a',{session_id:f.s,goal_id:'g'});assert.equal(result.status,'CANCELLED');assert.equal((await running).status,'CANCELLED');assert.equal(f.browser.executions,0);}finally{await f.cleanup();}});
test('cancelling completed goal does not borrow another active goal status',async()=>{const f=await setup();try{await f.engine.runGoal('a',req(f.s));f.browser.done=false;f.browser.hung=true;const running=f.engine.runGoal('a',{...req(f.s),goal_id:'g2',idempotency_key:'id2'});while(f.browser.executions<2)await new Promise(r=>setTimeout(r,1));const old=await f.engine.cancel('a',{session_id:f.s,goal_id:'g'});assert.equal(old.status,'SUCCEEDED');assert.equal(old.unknown_action,false);await new Promise(r=>setTimeout(r,10));await f.engine.cancel('a',{session_id:f.s,goal_id:'g2'});const cancelled=await running;assert.equal(cancelled.status,'UNKNOWN');assert.ok(cancelled.elapsed_ms>0);}finally{await f.cleanup();}});
test('independent owners can open separate browser sessions',async()=>{const f=await setup();try{const second=await f.engine.openSession('b',{fixture_id:'standard'});assert.notEqual(second.session_id,f.s);await assert.rejects(f.engine.observe('a',{session_id:second.session_id}),/UNAUTHORIZED/);}finally{await f.cleanup();}});
test('public observation reserves the session against goal execution',async()=>{const f=await setup();let release!:()=>void;const original=f.browser.observe.bind(f.browser);f.browser.observe=async(s,g)=>{if(!g)await new Promise<void>(r=>{release=r;});return original(s,g);};try{const pending=f.engine.observe('a',{session_id:f.s});while(!release)await new Promise(r=>setTimeout(r,1));await assert.rejects(f.engine.runGoal('a',req(f.s)),/BUSY/);release();await pending;assert.equal(f.browser.executions,0);}finally{release?.();await f.cleanup();}});
test('proven pre-execution stale rejection reobserves without UNKNOWN or replay',async()=>{
 const {ExecutionNotStarted}=await import('../../src/core/errors.js');const f=await setup();let attempts=0;
 f.browser.execute=async()=>{attempts++;f.browser.done=true;throw new ExecutionNotStarted();};
 try{const result=await f.engine.runGoal('a',req(f.s));assert.equal(result.status,'SUCCEEDED');assert.equal(attempts,1);assert.equal(f.browser.executions,0);assert.equal(f.engine.ledger.state.sessions[f.s]!.quarantined,false);assert.equal(f.engine.ledger.state.actions[result.action_ids[0]!]!.status,'REJECTED');}finally{await f.cleanup();}
});
test('failed public observation cannot prevent session cleanup',async()=>{const f=await setup();let reject!: (error:Error)=>void;let closed=0;f.browser.observe=async()=>new Promise((_resolve,r)=>{reject=r;});f.browser.close=async()=>{closed++;};try{const observation=f.engine.observe('a',{session_id:f.s}).catch(()=>{});const closing=f.engine.closeSession('a',{session_id:f.s});reject(new Error('READ_FAILED'));await observation;assert.equal((await closing).closed,true);assert.equal(closed,1);}finally{await f.cleanup();}});
test('lost action response preserves committed side effect without replay',async()=>{
 const f=await setup();
 f.browser.execute=async()=>{
  f.browser.executions++;
  f.browser.done=true;
  // A short goal deadline can expire during durable setup before execute starts.
  // Commit then lose the response; the separate hung-executor test covers timeouts.
  throw new Error('ACTION_RESPONSE_LOST');
 };
 try{
  const result=await f.engine.runGoal('a',req(f.s));
  assert.equal(result.status,'UNKNOWN');
  assert.equal(f.browser.done,true);
  assert.equal(result.action_ids.length,1);
  assert.equal(f.engine.ledger.state.actions[result.action_ids[0]!]!.status,'UNKNOWN');
  assert.equal(f.engine.ledger.state.sessions[f.s]!.quarantined,true);
  const repeated=await f.engine.runGoal('a',req(f.s));
  assert.deepEqual(repeated,result);
  assert.equal(f.browser.executions,1);
  await assert.rejects(f.engine.runGoal('a',{...req(f.s),goal_id:'g2',idempotency_key:'id2'}),/QUARANTINED/);
  assert.equal(f.browser.executions,1);
 }finally{await f.cleanup();}
});
