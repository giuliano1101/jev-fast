import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, chmodSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJevRuntime} from '../index.mjs';
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
