import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {canonicalJson} from '../dist/src/remote/protocol.js';
import {JevSession, NativeAdapter, nativeCandidate} from '../index.mjs';
import {fixture} from './helpers.mjs';

const ABSENT = Symbol('absent');
const bounds = {x:12, y:34, width:180, height:22};
const clickSpec = {id:'open-search', description:'Open the Notes list search', method:'desktop_click', label:'备忘录列表搜索…', role:'AXMenuItem'};
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const desktopStub = {async call() { throw Error('NO_DESKTOP'); }, async close() {}};
const adapter = new NativeAdapter({app:'com.apple.Notes', desktop:desktopStub});

function notesState(value, {element_id='e-search', enabled=true, role='AXMenuItem', label='备忘录列表搜索…', nodeBounds=bounds, observation_id='obs-1'} = {}) {
  const element = {element_id, role, label, enabled, settable:false, actions:['AXPress'], bounds:nodeBounds};
  if (value !== ABSENT) element.value = value;
  return {
    observation_id, app:{bundle_id:'com.apple.Notes', pid:4242, name:'Notes'},
    window:{window_id:'w-notes', title:'Notes'}, elements:[element],
  };
}
function guardFor(value, options) {
  const state = notesState(value, options);
  return adapter.guard(nativeCandidate(state, {...clickSpec, label:state.elements[0].label, role:state.elements[0].role}), state);
}
function model() {
  let calls = 0;
  return {async choose() { calls++; return {selected_id:'open-search', confidence:1, provider:'jev', model:'jev-1.14.0'}; }, close() {}, get calls() { return calls; }};
}
function scriptedDesktop(script) {
  let reads = 0;
  const calls = [];
  return {calls, async call(method, input) {
    calls.push({method, input});
    if (method === 'desktop_get_state') {
      const spec = script(reads++);
      const element = {element_id:'e-search', role:'AXMenuItem', label:'备忘录列表搜索…', enabled:spec.enabled !== false, bounds:spec.bounds ?? bounds};
      if (spec.value !== ABSENT) element.value = spec.value;
      return {observation_id:'obs-'+reads, app:{bundle_id:'com.apple.Notes', pid:4242, name:'Notes'}, window:{window_id:'w-notes', title:'Notes'}, elements:[element]};
    }
    if (method === 'desktop_click') return {input_submitted:true};
    throw Error('UNEXPECTED_DESKTOP_CALL');
  }, async close() {}};
}
const step = {task:'Open the Notes list search', goalId:'notes-list-search', idempotencyKey:'open-list-search', intent:{action:'open-list-search'},
  project:state => state.elements.map(node => ({role:node.role, label:node.label, enabled:node.enabled})),
  candidates:state => [nativeCandidate(state, clickSpec)], verify:() => true};
async function withSession(script, check) {
  const f = fixture(), desktop = scriptedDesktop(script), jev = model();
  const session = await JevSession.open({adapter:new NativeAdapter({app:'com.apple.Notes', desktop}), jev, directory:join(f.runtime, 'session')});
  try { await check({session, desktop, jev}); }
  finally { await session.close(); f.cleanup(); }
}
function clicks(desktop) { return desktop.calls.filter(call => call.method === 'desktop_click'); }

test('canonical json still rejects undefined and keeps legal scalars distinct', () => {
  assert.throws(() => canonicalJson({value:undefined}), /INVALID_PROTOCOL/);
  assert.throws(() => canonicalJson({value:NaN}), /INVALID_PROTOCOL/);
  assert.equal(canonicalJson({value:null}), '{"value":null}');
  assert.equal(canonicalJson({value:false}), '{"value":false}');
  assert.equal(canonicalJson({value:0}), '{"value":0}');
  assert.equal(canonicalJson({value:''}), '{"value":""}');
});

test('a bound Notes menu item with no accessibility value is digestible and stays element-bound', () => {
  const state = notesState(ABSENT);
  const candidate = nativeCandidate(state, clickSpec);
  const guard = adapter.guard(candidate, state);
  assert.equal(candidate.input.element_id, 'e-search');
  assert.equal('x' in candidate.input, false);
  assert.equal('y' in candidate.input, false);
  assert.equal(guard.method, 'desktop_click');
  assert.equal(guard.parameters.app, 'com.apple.Notes');
  assert.equal('element_id' in guard.parameters, false);
  assert.equal('x' in guard.parameters, false);
  assert.equal('y' in guard.parameters, false);
  assert.equal(Object.hasOwn(guard.target, 'value'), false);
  assert.equal(canonicalJson(guard.target), canonicalJson({role:'AXMenuItem', label:'备忘录列表搜索…', bounds}));
  assert.notEqual(canonicalJson(guard.target), canonicalJson({role:'AXMenuItem', label:'备忘录列表搜索…', value:null, bounds}));
  const key = nativeCandidate(state, {id:'save', description:'Save the window', method:'desktop_press_key', params:{key:'cmd+s'}});
  assert.equal(adapter.guard(key, state).target, null);
  assert.notEqual(key.method, candidate.method);
  assert.throws(() => adapter.guard({...candidate, input:{...candidate.input, app:'com.apple.TextEdit'}}, state), /INVALID_NATIVE_BINDING/);
  assert.throws(() => adapter.guard({...candidate, input:{...candidate.input, element_id:'missing'}}, state), /INVALID_NATIVE_BINDING/);
  assert.throws(() => nativeCandidate(notesState(ABSENT, {enabled:false}), clickSpec), /TARGET_NOT_UNIQUE/);
  assert.throws(() => adapter.guard(candidate, notesState(ABSENT, {enabled:false})), /INVALID_NATIVE_BINDING/);
});

test('missing, present, empty, null, false, and zero values stay distinct and stable', () => {
  const values = [ABSENT, '已输入', '', null, false, 0];
  const digests = values.map(value => digest(guardFor(value)));
  assert.equal(new Set(digests).size, values.length);
  for (const value of values) {
    const guard = guardFor(value);
    if (value === ABSENT) assert.equal(Object.hasOwn(guard.target, 'value'), false);
    else assert.equal(guard.target.value, value);
    assert.equal(digest(guard), digest(guardFor(value, {observation_id:'obs-2', element_id:'e-99'})));
  }
  const explicit = notesState(ABSENT);
  explicit.elements[0].value = undefined;
  assert.equal(digest(adapter.guard(nativeCandidate(explicit, clickSpec), explicit)), digests[0]);
  assert.notEqual(digest(guardFor(ABSENT, {nodeBounds:{...bounds, x:bounds.x + 1}})), digests[0]);
  assert.notEqual(digest(guardFor(ABSENT, {label:'查找'})), digests[0]);
  assert.notEqual(digest(guardFor(ABSENT, {role:'AXButton'})), digests[0]);
  const nan = guardFor(NaN);
  assert.equal(Number.isNaN(nan.target.value), true);
  assert.throws(() => canonicalJson(nan), /INVALID_PROTOCOL/);
  assert.throws(() => canonicalJson(guardFor({nested:undefined})), /INVALID_PROTOCOL/);
  const duplicated = notesState(ABSENT);
  duplicated.elements.push({...duplicated.elements[0], element_id:'e-other'});
  assert.throws(() => nativeCandidate(duplicated, clickSpec), /TARGET_NOT_UNIQUE/);
});

test('a target-bound click with a missing accessibility value dispatches once and does not quarantine', async () => {
  for (const value of [ABSENT, '已输入', '', null, false, 0]) {
    await withSession(() => ({value}), async ({session, desktop, jev}) => {
      const result = await session.step(step);
      assert.equal(result.status, 'VERIFIED');
      assert.equal(result.code, 'POSTCONDITION_VERIFIED');
      assert.equal(result.cached, false);
      assert.ok('model_ms' in result.timings);
      assert.ok('execute_ms' in result.timings);
      assert.equal(jev.calls, 1);
      assert.equal(clicks(desktop).length, 1);
      assert.equal(clicks(desktop)[0].input.element_id, 'e-search');
      assert.equal(clicks(desktop)[0].input.observation_id, 'obs-2');
      assert.equal('x' in clicks(desktop)[0].input, false);
      assert.equal('y' in clicks(desktop)[0].input, false);
      const replay = await session.step(step);
      assert.equal(replay.cached, true);
      assert.equal(replay.status, 'VERIFIED');
      assert.equal(clicks(desktop).length, 1);
      assert.equal(jev.calls, 1);
    });
  }
});

test('a changed accessibility target is rejected before dispatch and a new key can proceed', async () => {
  const changes = [[ABSENT, '已输入'], [ABSENT, ''], [ABSENT, null], [ABSENT, false], [ABSENT, 0], ['', null], [null, false], [false, 0], [0, ''], ['已输入', '']];
  for (const [first, second] of changes) {
    await withSession(index => ({value:index === 0 ? first : second}), async ({session, desktop, jev}) => {
      const result = await session.step(step);
      assert.equal(result.status, 'STALE');
      assert.equal(result.code, 'STATE_CHANGED');
      assert.equal(clicks(desktop).length, 0);
      assert.equal(jev.calls, 1);
      assert.equal('execute_ms' in result.timings, false);
    });
  }
  await withSession(index => ({value:ABSENT, bounds:index === 0 ? bounds : {...bounds, y:40}}), async ({session, desktop}) => {
    const result = await session.step(step);
    assert.equal(result.status, 'STALE');
    assert.equal(result.code, 'STATE_CHANGED');
    assert.equal(clicks(desktop).length, 0);
  });
  let mode = 'drift';
  await withSession(index => ({value:mode === 'drift' && index > 0 ? 'changed' : ABSENT}), async ({session, desktop, jev}) => {
    const stale = await session.step(step);
    assert.equal(stale.status, 'STALE');
    assert.equal(clicks(desktop).length, 0);
    const cached = await session.step(step);
    assert.equal(cached.cached, true);
    assert.equal(cached.status, 'STALE');
    assert.equal(clicks(desktop).length, 0);
    mode = 'stable';
    const next = await session.step({...step, idempotencyKey:'retry-after-stable'});
    assert.equal(next.status, 'VERIFIED');
    assert.equal(next.cached, false);
    assert.equal(clicks(desktop).length, 1);
    assert.equal(jev.calls, 2);
  });
});

test('an illegal accessibility value still fails during guard digest before the model or dispatch', async () => {
  await withSession(() => ({value:NaN}), async ({session, desktop, jev}) => {
    const result = await session.step(step);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.code, 'INVALID_PROTOCOL');
    assert.equal(result.cached, false);
    assert.equal(result.decision, undefined);
    assert.equal(jev.calls, 0);
    assert.equal(clicks(desktop).length, 0);
    assert.ok('observe_ms' in result.timings);
    assert.equal('model_ms' in result.timings, false);
    assert.equal('execute_ms' in result.timings, false);
    const replay = await session.step(step);
    assert.equal(replay.cached, true);
    assert.equal(replay.code, 'INVALID_PROTOCOL');
    assert.equal(jev.calls, 0);
  });
  await withSession(index => ({value:ABSENT, enabled:index === 0}), async ({session, desktop, jev}) => {
    const result = await session.step(step);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.code, 'TARGET_NOT_UNIQUE');
    assert.equal(clicks(desktop).length, 0);
    assert.equal(jev.calls, 1);
  });
});
