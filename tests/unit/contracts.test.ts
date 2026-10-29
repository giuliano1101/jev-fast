import test from 'node:test';
import assert from 'node:assert/strict';
import { schemas, decisionSchema, validateDecision } from '../../src/core/contracts.js';
test('public requests reject identity forgery and arbitrary predicates', () => {
    assert.equal(schemas.open_session.safeParse({ fixture_id: 'standard', client_id: 'other' }).success, false);
    assert.equal(schemas.run_goal.safeParse({ session_id: 's', goal_id: 'g', idempotency_key: 'i', goal: { task: 'form', language: 'en', seed: 1 }, success: { kind: 'javascript', expression: '1' } }).success, false);
});
test('decision checks types, finite confidence, model and complete probability set', () => {
    const valid = { provider: 'mock', model: 'mock-v1', snapshot_id: 's', candidate_id: 'c', confidence: 1, usage: { input_tokens: 0, output_tokens: 0 }, elapsed_ms: 0 };
    assert.equal(decisionSchema.safeParse({ ...valid, confidence: '1' }).success, false);
    assert.equal(decisionSchema.safeParse({ ...valid, confidence: NaN }).success, false);
    assert.throws(() => validateDecision({ ...valid, model: 'unknown' }, 's', ['c']));
    assert.throws(() => validateDecision({ ...valid, candidate_id: 'outside' }, 's', ['c']));
    assert.throws(() => validateDecision({ ...valid, probabilities: { c: 0.9 } }, 's', ['c']));
    assert.throws(() => validateDecision({ ...valid, probabilities: { c: 1, extra: 0 } }, 's', ['c']));
    assert.equal(validateDecision(valid, 's', ['c']).candidate_id, 'c');
});
test('fixture step and error predicates are bounded', () => { const request = { session_id: 's', goal_id: 'g', idempotency_key: 'i', goal: { task: 'form', language: 'en', seed: 1 } }; assert.equal(schemas.run_goal.safeParse({ ...request, success: { kind: 'step', value: 1 } }).success, true); assert.equal(schemas.run_goal.safeParse({ ...request, success: { kind: 'step', value: 3 } }).success, false); assert.equal(schemas.run_goal.safeParse({ ...request, success: { kind: 'flag', name: 'error', value: true } }).success, true); });
