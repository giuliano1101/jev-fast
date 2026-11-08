import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, chmodSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJevRuntime, NativeAdapter, nativeCandidate} from '../index.mjs';
import {canonicalJson} from '../dist/src/remote/protocol.js';
import {fixture, args, response} from './helpers.mjs';

test('missing or nonprivate key fails locally', () => {
  const f = fixture();
  try {
    writeFileSync(f.keyFile, '');
    assert.throws(() => createJevRuntime(f), /TYPESAFE_API_KEY_REQUIRED/);
    writeFileSync(f.keyFile, 'offline-test-key'); chmodSync(f.keyFile, 0o644);
    assert.throws(() => createJevRuntime(f), /PRIVATE_STORAGE_REQUIRED/);
  } finally { f.cleanup(); }
});
test('out-of-catalog choice is rejected and usage is still counted', async () => {
  const f = fixture(); const runtime = createJevRuntime({...f, transport: async () => response('invented_action')});
  try {
    await assert.rejects(runtime.choose(args), /INVALID_RESPONSE/);
    assert.equal(runtime.usage().known_usage_attempts, 1);
  } finally { runtime.close(); f.cleanup(); }
});
test('transport failure is never replayed and remains unknown usage', async () => {
  const f = fixture(); let calls = 0;
  const runtime = createJevRuntime({...f, transport: async () => { calls++; throw Error('offline-test-key'); }});
  try {
    await assert.rejects(runtime.choose(args), error => !error.message.includes('offline-test-key'));
    assert.equal(calls, 1); assert.equal(runtime.usage().unknown_usage_attempts, 1);
  } finally { runtime.close(); f.cleanup(); }
});
test('missing selection is not fabricated and copy is not added as an unbound or clipboard action', () => {
  const desktop = {async call() { throw Error('NO_DESKTOP'); }, async close() {}};
  const adapter = new NativeAdapter({app:'com.apple.finder', desktop});
  const base = {observation_id:'obs', app:{bundle_id:'com.apple.finder', pid:1}, window:{window_id:'w', title:'Authorized'}, elements:[{element_id:'e-video', role:'AXImage', label:'preview_sub_v2.mp4', enabled:true, bounds:{x:1,y:2,width:3,height:4}}]};
  const spec = {id:'select_video', description:'Select the authorized video', method:'desktop_click', label:'preview_sub_v2.mp4', role:'AXImage'};
  const absent = adapter.guard(nativeCandidate(base, spec), base);
  assert.equal(Object.hasOwn(absent.target, 'selected'), false);
  assert.equal(canonicalJson(absent).includes('"selected"'), false);
  for (const selected of [false, true]) {
    const state = {...base, elements:[{...base.elements[0], selected}]};
    const guard = adapter.guard(nativeCandidate(state, spec), state);
    assert.equal(guard.target.selected, selected);
    assert.equal(canonicalJson(guard).includes(`"selected":${selected}`), true);
  }
  for (const selected of [undefined, null, 0, 1, 'false']) {
    const state = {...base, elements:[{...base.elements[0], selected}]};
    const guard = adapter.guard(nativeCandidate(state, spec), state);
    assert.equal(Object.hasOwn(guard.target, 'selected'), false);
    assert.equal(canonicalJson(guard), canonicalJson(absent));
  }
  const unbound = nativeCandidate(base, {id:'key', description:'Window key', method:'desktop_press_key', params:{key:'cmd+c'}});
  assert.equal(unbound.input.element_id, undefined);
  assert.equal(adapter.guard(unbound, base).target, null);
  assert.throws(() => nativeCandidate(base, {id:'copy', description:'Read clipboard', method:'desktop_read_clipboard'}), /UNSUPPORTED_NATIVE_ACTION/);
  assert.equal('x' in nativeCandidate(base, spec).input, false);
});
test('deployed package has no MCP dependency or import', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['playwright','zod']);
  function check(directory) {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) check(path);
      else if (entry.name.endsWith('.js')) assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:from|import\()\s*['"](?:@modelcontextprotocol|@playwright\/mcp)/);
    }
  }
  check(fileURLToPath(new URL('../dist/', import.meta.url)));
});
