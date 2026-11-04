import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createJevRuntime, deployment} from '../index.mjs';
import {fixture, args, response} from './helpers.mjs';
test('official request shape, selected ID and durable usage are preserved across restart', async () => {
  const f = fixture(); let calls = 0;
  try {
    const runtime = createJevRuntime({...f, transport: async (url, init) => {
      calls++;
      assert.equal(url, deployment.endpoint);
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, 'Bearer offline-test-key');
      const body = JSON.parse(init.body);
      assert.equal(body.model, deployment.model);
      assert.equal(body.questions.action.type, 'choice');
      assert.deepEqual(Object.keys(body.questions.action.criteria), ['open_details', 'wait']);
      assert.equal(JSON.stringify(body).includes('offline-test-key'), false);
      return response();
    }});
    assert.equal((await runtime.choose(args)).selected_id, 'open_details');
    assert.equal(calls, 1);
    assert.equal(runtime.usage().input_tokens, 101);
    runtime.close();
    const reopened = createJevRuntime({...f, transport: async () => { throw Error('unexpected network'); }});
    assert.equal(reopened.usage().attempts, 1);
    assert.equal(reopened.usage().known_usage_attempts, 1);
    reopened.close();
  } finally { f.cleanup(); }
});
