import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DesktopExecutor, createJevRuntime} from '../index.mjs';
import {fixture, args, response} from './helpers.mjs';

test('model chooses one grounded candidate; host executes once and checks a fresh postcondition', async () => {
  const f = fixture(); let clicks = 0; let complete = false; let observations = 0;
  const desktop = new DesktopExecutor({driver: {
    async call(method, input) {
      if (method === 'get_state') { observations++; return {observation_id: `obs-${observations}`, complete}; }
      assert.equal(method, 'click'); assert.equal(input.observation_id, 'obs-1');
      assert.equal(input.element_id, 'details-button'); clicks++; complete = true; return {status: 'executed'};
    }, async close() {},
  }});
  const runtime = createJevRuntime({...f, transport: async () => response()});
  try {
    const before = await desktop.call('desktop_get_state', {app: 'test.app'});
    const decision = await runtime.choose({...args, state: before});
    assert.equal(clicks, 0);
    const candidates = new Map([['open_details', {app: 'test.app', observation_id: before.observation_id, element_id: 'details-button'}]]);
    await desktop.call('desktop_click', candidates.get(decision.selected_id));
    const after = await desktop.call('desktop_get_state', {app: 'test.app'});
    assert.equal(clicks, 1); assert.equal(after.complete, true); assert.notEqual(after.observation_id, before.observation_id);
  } finally { runtime.close(); await desktop.close(); f.cleanup(); }
});
