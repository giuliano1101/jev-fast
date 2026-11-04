import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {JevChoiceProvider} from './dist/src/providers/choice.js';
import {UsageLedger} from './dist/src/remote/usage.js';
import {preparePrivateDirectory, assertPrivateFile} from './dist/src/service/private-directory.js';
import {askQuestions} from './questions.mjs';
import {JevSession} from './session.mjs';
import {NativeAdapter} from './native.mjs';

export {DesktopExecutor} from './dist/src/desktop/executor.js';
export {runHybridSession} from './dist/bench/hybrid/controller.js';
export {FileExecutionJournal} from './dist/bench/hybrid/execution-journal.js';
export {ProcedureStore} from './dist/bench/hybrid/procedure-store.js';
export {routeHybrid} from './dist/bench/hybrid/router.js';
export {createFilesystemTeacherPort} from './dist/bench/hybrid/teacher-port.js';
export {TestBudget} from './budget.mjs';
export {JevSession} from './session.mjs';
export {NativeAdapter, nativeCandidate} from './native.mjs';
export {BrowserAdapter, browserCandidate, browserProjection} from './browser.mjs';
export {BrowserWorkflow} from './browser-workflow.mjs';
export {installCodexDefaults} from './install.mjs';

export const deployment = Object.freeze({
  endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.14.0', mode: 'official-direct',
  runtime: fileURLToPath(new URL('../.runtime/direct/', import.meta.url)),
});

/** Local host API only. No service, shell, browser or physical input starts on import. */
export function createJevRuntime({runtime = deployment.runtime, keyFile = join(runtime, 'api-key'), transport, budget} = {}) {
  preparePrivateDirectory(runtime);
  assertPrivateFile(keyFile);
  const key = readFileSync(keyFile, 'utf8').trim();
  if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw new Error('TYPESAFE_API_KEY_REQUIRED');
  const ledger = new UsageLedger(join(runtime, 'usage'));
  let closed = false;
  function recorder() {
    if (closed) throw new Error('RUNTIME_CLOSED');
    const usage = ledger.recorder({policy_id: 'official-direct',
      identity: {owner_id: 'local-owner', device_id: 'this-mac', agent_id: 'codex'}, request_id: randomUUID()});
    return budget ? budget.wrap(usage) : usage;
  }
  return Object.freeze({
    deployment,
    async choose(args, {signal = new AbortController().signal} = {}) {
      if (closed) throw new Error('RUNTIME_CLOSED');
      const provider = new JevChoiceProvider({key, recorder:recorder(), ...(transport ? {transport} : {})});
      return provider.choose(args, signal);
    },
    ask(args) { return askQuestions({key, recorder:recorder(), ...(transport ? {transport} : {})}, args); },
    usage() { return ledger.summary(); },
    close() { if (!closed) { closed = true; ledger.close(); } },
  });
}

/** All native sessions on this Mac share one physical-input journal/lease. */
export async function openDesktopSession({app, windowId, directory = join(deployment.runtime, 'native-session'), runtimeOptions, ...options}) {
  const adapter = new NativeAdapter({app, windowId});
  const jev = createJevRuntime(runtimeOptions);
  try { return await JevSession.open({adapter, jev, directory, ...options}); }
  catch (error) { await adapter.close(); jev.close(); throw error; }
}

/** An owned, isolated browser; never copies or attaches the daily Chrome profile. */
export async function openBrowserSession({runtimeOptions, directory, ...options} = {}) {
  const {BrowserAdapter} = await import('./browser.mjs');
  const jev = createJevRuntime(runtimeOptions); let adapter;
  try { adapter = await BrowserAdapter.launch(options); return await JevSession.open({adapter, jev, directory:directory ?? join(deployment.runtime, 'browser-sessions', adapter.id)}); }
  catch (error) { await adapter?.close(); jev.close(); throw error; }
}
