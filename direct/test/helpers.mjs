import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export const args = {idempotency_key: 'test-goal-step-1', task: 'Open the visible details',
  state: {observation_id: 'obs-1', controls: ['Details']},
  actions: [{id: 'open_details', description: 'Click the observed Details button'},
    {id: 'wait', description: 'Wait for the page to settle'}]};
export function fixture() {
  const runtime = mkdtempSync(join(tmpdir(), 'jev-direct-test-'));
  const keyFile = join(runtime, 'api-key');
  writeFileSync(keyFile, 'offline-test-key', {mode: 0o600});
  return {runtime, keyFile, cleanup: () => rmSync(runtime, {recursive: true, force: true})};
}
export function response(choice = 'open_details') {
  return Response.json({model: 'jev-1.14.0', answers: {action: {type: 'choice', choice, confidence: 0.99}},
    usage: {input_tokens: 101, output_tokens: 3}});
}
