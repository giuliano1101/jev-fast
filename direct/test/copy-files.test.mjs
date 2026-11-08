import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../dist/src/remote/protocol.js';
import {JevSession, NativeAdapter, nativeCandidate} from '../index.mjs';
import {fixture} from './helpers.mjs';

const files = ['file:///approved/preview_sub_v2.mp4', 'file:///approved/cover-a.png', 'file:///approved/cover-b.png', 'file:///approved/cover-c.png'];
const secret = 'CLIPBOARD_TEXT_SECRET';
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const bounds = {x:0, y:0, width:40, height:40};
const model = () => ({async choose() { return {selected_id:'copy_files', confidence:1, provider:'jev', model:'jev-1.14.0'}; }, close() {}});

function elements(selected = true) {
  return files.map((file, index) => ({element_id:'file-'+index, role:'AXImage', label:file.split('/').pop(), enabled:true, ...(selected === undefined ? {} : {selected}), bounds:{...bounds, x:index}}));
}
function state(selected = true, observation = 'obs-copy') {
  return {observation_id:observation, app:{bundle_id:'com.apple.finder', pid:77, name:'Finder'}, window:{window_id:'w-finder', title:'菜人'}, elements:elements(selected)};
}
function candidate(observed = state(), approved = files) {
  return nativeCandidate(observed, {id:'copy_files', description:'Copy the approved selected files', method:'desktop_copy_files', params:{element_ids:observed.elements.map(node => node.element_id), files:approved}});
}
function desktop(script) {
  const calls = [];
  return {calls, async call(method, input) {
    calls.push({method, input});
    if (method === 'desktop_get_state') return script.state();
    if (method === 'desktop_copy_files') return script.copy(input);
    throw Error('UNEXPECTED_DESKTOP_CALL');
  }, async close() {}};
}
async function run(script, verify = () => true) {
  const f = fixture(), adapterDesktop = desktop(script);
  const session = await JevSession.open({adapter:new NativeAdapter({app:'com.apple.finder', desktop:adapterDesktop}), jev:model(), directory:join(f.runtime, 'session')});
  try {
    const result = await session.step({task:'Copy the approved 菜人 files', goalId:'cairen-notes-copy', idempotencyKey:script.key ?? 'copy-approved-files', intent:{action:'copy-approved-files'}, settleMs:0,
      project:observed => observed.elements.map(node => ({label:node.label, selected:node.selected === true})),
      candidates:observed => [candidate(observed, script.files ? script.files() : files)], verify});
    const ledgerPath = join(f.runtime, 'session', 'physical', 'executions.json');
    const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '';
    return {result, desktop:adapterDesktop, ledger};
  } finally { await session.close(); f.cleanup(); }
}
const copies = value => value.calls.filter(call => call.method === 'desktop_copy_files');

test('copy is bound to the selected allowlist and does not accept a general clipboard read or an unbound shortcut', () => {
  const adapter = new NativeAdapter({app:'com.apple.finder', desktop:{async call() { throw Error('NO_DESKTOP'); }, async close() {}}});
  const observed = state();
  const action = candidate(observed);
  const guard = adapter.guard(action, observed);
  assert.equal(action.input.element_id, undefined);
  assert.equal('x' in action.input, false);
  assert.deepEqual(guard.target.map(node => node.selected), [true, true, true, true]);
  assert.deepEqual(guard.parameters.files, files);
  assert.notEqual(digest(guard), digest(adapter.guard(candidate(observed, files.slice(0, 3).concat(['file:///approved/other.png'])), observed)));
  const absent = state();
  for (const node of absent.elements) delete node.selected;
  assert.throws(() => adapter.guard(candidate(absent), absent), /INVALID_NATIVE_BINDING/);
  assert.throws(() => adapter.guard(candidate(state(false)), state(false)), /INVALID_NATIVE_BINDING/);
  assert.throws(() => nativeCandidate(observed, {id:'read', description:'Read clipboard', method:'desktop_read_clipboard'}), /UNSUPPORTED_NATIVE_ACTION/);
  const key = nativeCandidate(observed, {id:'shortcut', description:'Press copy', method:'desktop_press_key', params:{key:'cmd+c'}});
  assert.equal(adapter.guard(key, observed).target, null);
  assert.equal('element_id' in key.input, false);
});

test('a submitted allowlist copy keeps only match and count, including when the caller verify is true but the file set does not match', async () => {
  const matched = await run({state:() => state(true, 'obs-match'), copy:() => ({input_submitted:true, copy_proof:{match:true, count:4, files, text:secret}})});
  assert.equal(matched.result.status, 'VERIFIED');
  assert.deepEqual(matched.result.copy_proof, {match:true, count:4});
  assert.equal(JSON.stringify(matched.result).includes(secret), false);
  assert.equal(JSON.stringify(matched.result).includes('file:///'), false);
  assert.equal(matched.ledger.includes(secret), false);
  assert.equal(copies(matched.desktop).length, 1);
  assert.deepEqual(copies(matched.desktop)[0].input.files, files);

  const mismatched = await run({key:'copy-mismatch', state:() => state(true, 'obs-mismatch'), copy:() => ({input_submitted:true, copy_proof:{match:false, count:5, files:['file:///other/private.png'], text:secret}})});
  assert.equal(mismatched.result.status, 'POSTCONDITION_FAILED');
  assert.equal(mismatched.result.code, 'POSTCONDITION_NOT_MET');
  assert.deepEqual(mismatched.result.copy_proof, {match:false, count:5});
  assert.equal(JSON.stringify(mismatched.result).includes(secret), false);
  assert.equal(JSON.stringify(mismatched.result).includes('file:///'), false);
});

test('selection or allowlist changes and pre-write copy rejections never become a pasteable success', async () => {
  let reads = 0;
  const stale = await run({key:'copy-stale-selection', state:() => state(reads++ === 0, reads === 1 ? 'obs-a' : 'obs-b'), copy:() => { throw Error('COPY_MUST_NOT_RUN'); }});
  assert.equal(stale.result.status, 'STALE');
  assert.equal(stale.result.code, 'STATE_CHANGED');
  assert.equal(copies(stale.desktop).length, 0);

  let built = 0;
  const changed = await run({key:'copy-stale-allowlist', state:() => state(true, 'obs-allow'), files:() => built++ === 0 ? files : files.slice(0, 3).concat(['file:///approved/other.png']), copy:() => { throw Error('COPY_MUST_NOT_RUN'); }});
  assert.equal(changed.result.status, 'STALE');
  assert.equal(changed.result.code, 'STATE_CHANGED');
  assert.equal(copies(changed.desktop).length, 0);

  for (const code of ['ALLOWLIST_MISMATCH', 'SELECTION_REQUIRED', 'FILE_URL_UNAVAILABLE', 'EXTRA_SELECTION']) {
    const rejected = await run({key:'copy-'+code, state:() => state(), copy:() => { throw Error(code); }});
    assert.equal(rejected.result.status, 'FAILED');
    assert.equal(rejected.result.code, code);
    assert.equal(rejected.result.dispatch, 'not-executed');
  }
  const uncertain = await run({key:'copy-input-failed', state:() => state(), copy:() => { throw Error('INPUT_FAILED'); }});
  assert.equal(uncertain.result.status, 'UNKNOWN');
  assert.equal(uncertain.result.code, 'INPUT_FAILED');
});
