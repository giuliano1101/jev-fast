import type { DecisionProvider, DecisionInput, DecisionContext, Decision } from '../core/contracts.js';
import { Fault } from '../core/errors.js';
/** Offline deterministic provider. No environment or credentials are accessed. */
export class MockProvider implements DecisionProvider {
    constructor(private readonly choose: (input: DecisionInput) => string = (input) => input.candidates[0]?.candidate_id ?? '') { }
    async decide(input: DecisionInput, context: DecisionContext): Promise<Decision> { if (context.signal.aborted)
        throw new Fault('CANCELLED'); if (!input.synthetic)
        throw new Fault('UNSAFE_OBSERVATION'); return { provider: 'mock', model: 'mock-v1', snapshot_id: input.snapshot_id, candidate_id: this.choose(input), confidence: 1, usage: { input_tokens: 0, output_tokens: 0 }, elapsed_ms: 0, request_count: 0, retry_count: 0, unknown_usage_requests: 0 }; }
}
