import {DatabaseSync} from 'node:sqlite';
import {chmodSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validateReconciliation} from './dist/bench/hybrid/execution-journal.js';
import {FileExecutionJournal} from './dist/bench/hybrid/execution-journal.js';
import {preparePrivateDirectory, assertPrivateFile} from './dist/src/service/private-directory.js';

/** macOS driver codes raised before the journaled input is posted. Title/URL stability is not in this set. */
export const DESKTOP_PRE_DISPATCH_REJECTIONS = Object.freeze([
  'ACTION_NOT_SUPPORTED', 'ALLOWLIST_MISMATCH', 'AMBIGUOUS_APP', 'APP_NOT_FOUND', 'APP_NOT_RUNNING', 'ATTRIBUTE_NOT_SETTABLE',
  'ELEMENT_DISABLED', 'EXTRA_SELECTION', 'FILE_URL_UNAVAILABLE', 'INVALID_REQUEST', 'METHOD_NOT_FOUND', 'PERMISSION_REQUIRED', 'SELECTION_REQUIRED', 'UNSUPPORTED_KEY',
]);
const PRE_DISPATCH = new Set(DESKTOP_PRE_DISPATCH_REJECTIONS);
const OPEN_STATUS = new Set(['PLANNING', 'EXECUTING', 'UNKNOWN']);
const REASONS = new Set(['INVALID_RECONCILIATION', 'NOT_EXECUTED_UNPROVEN', 'EXECUTED_UNPROVEN', 'HUMAN_CONFIRMATION_REQUIRED', 'DEADLINE', 'CANCELLED', 'EVENT_MISMATCH', 'JOURNAL_CORRUPT', 'SURFACE_QUARANTINED']);
const leasePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const TERMINAL = { 'not-executed': 'RECONCILED_NOT_EXECUTED', executed: 'RECONCILED_EXECUTED', unconfirmed: 'RECONCILED_UNCONFIRMED' };

export function isDesktopPreDispatchRejection(code) { return typeof code === 'string' && PRE_DISPATCH.has(code); }

function validLease(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 80 && leasePattern.test(value); }
function correlationUuid(name) {
  const hex = createHash('sha256').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    if (error?.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}
function readLock(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const pid = Number.isInteger(parsed?.pid) ? parsed.pid : null;
    return {present: true, pid, owner: ownerAlive(pid), advisory: true};
  } catch { return {present: true, pid: null, owner: 'unknown', advisory: true}; }
}
function readJournalSnapshot(physical) {
  const path = join(physical, 'executions.json');
  if (!existsSync(path)) return {readable: true, pending: [], resolved: []};
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (!state || !Array.isArray(state.pending) || !Array.isArray(state.resolved)) return {readable: false};
    return {readable: true, pending: state.pending, resolved: state.resolved};
  } catch { return {readable: false}; }
}
export function openStepsDatabase(root, {readOnly = false} = {}) {
  const path = join(root, 'steps.sqlite');
  if (!existsSync(path)) {
    if (readOnly) return null;
  } else for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) assertPrivateFile(path + suffix);
  const db = new DatabaseSync(path, readOnly ? {readOnly: true, fileMustExist: true} : {});
  if (!readOnly) {
    chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS steps(id TEXT PRIMARY KEY,digest TEXT NOT NULL,status TEXT NOT NULL,result TEXT);");
    const names = new Set(db.prepare('PRAGMA table_info(steps)').all().map(column => column.name));
    if (!names.has('phase')) db.exec('ALTER TABLE steps ADD COLUMN phase TEXT');
    if (!names.has('method')) db.exec('ALTER TABLE steps ADD COLUMN method TEXT');
    if (!names.has('event_json')) db.exec('ALTER TABLE steps ADD COLUMN event_json TEXT');
  }
  return db;
}
function loadSteps(db) {
  if (!db) return [];
  const names = new Set(db.prepare('PRAGMA table_info(steps)').all().map(column => column.name));
  const phase = names.has('phase') ? 'phase' : 'NULL AS phase';
  const method = names.has('method') ? 'method' : 'NULL AS method';
  const eventJson = names.has('event_json') ? 'event_json' : 'NULL AS event_json';
  return db.prepare(`SELECT id,status,result,${phase},${method},${eventJson} FROM steps`).all().map(row => {
    let parsed = null;
    try { parsed = row.result ? JSON.parse(row.result) : null; } catch { parsed = null; }
    return {
      id: row.id, status: row.status, phase: row.phase ?? null, method: row.method ?? null,
      code: typeof parsed?.code === 'string' ? parsed.code : null,
      dispatch: typeof parsed?.dispatch === 'string' ? parsed.dispatch : null,
      actionId: `step-${row.id}`, open: OPEN_STATUS.has(row.status),
    };
  });
}
function pendingView(event) {
  return {schemaVersion: 1, eventId: event.eventId, leaseKey: event.leaseKey, sessionId: event.sessionId, actionId: event.actionId, observationId: event.observationId, startedAt: event.startedAt};
}
function journalSaysSubmitted(resolution) {
  return resolution?.status === 'executed' || (resolution?.status === 'reconciled' && resolution?.proof?.verdict === 'executed');
}
function durableNotDispatched(step, resolution) {
  if (!step || journalSaysSubmitted(resolution) || step.dispatch === 'submitted') return false;
  if (step.status === 'PLANNING' || step.phase === 'planning' || step.phase === 'armed') return true;
  return isDesktopPreDispatchRejection(step.code);
}
function judge(event, step, resolution, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_RECONCILIATION');
  const basis = value.basis;
  if (basis !== 'pre-dispatch' && basis !== 'observed-effect' && basis !== 'human-confirmed') throw Error('INVALID_RECONCILIATION');
  const proof = validateReconciliation(event, {
    eventId: value.eventId, leaseKey: value.leaseKey, actionId: value.actionId,
    observationId: value.observationId, evidenceId: value.evidenceId, verdict: value.verdict,
  });
  if (resolution?.proof?.observationId && proof.observationId === resolution.proof.observationId) throw Error('INVALID_RECONCILIATION');
  if (proof.verdict === 'not-executed') {
    if (basis !== 'pre-dispatch' || !durableNotDispatched(step, resolution)) throw Error('NOT_EXECUTED_UNPROVEN');
  } else if (proof.verdict === 'executed') {
    if (!journalSaysSubmitted(resolution) || (basis !== 'observed-effect' && basis !== 'human-confirmed')) throw Error('EXECUTED_UNPROVEN');
  } else if (proof.verdict === 'unconfirmed') {
    if (basis !== 'human-confirmed') throw Error('HUMAN_CONFIRMATION_REQUIRED');
  } else throw Error('INVALID_RECONCILIATION');
  return {proof, basis};
}
function publicSteps(steps) {
  return steps.filter(step => step.open).map(step => ({id: step.id, actionId: step.actionId, status: step.status, code: step.code, phase: step.phase, method: step.method}));
}
function matchingResolutions(steps, resolved) {
  const matches = [];
  for (const step of steps.filter(item => item.open)) {
    const resolution = [...resolved].reverse().find(item => item?.event?.actionId === step.actionId);
    if (!resolution) continue;
    matches.push({
      eventId: resolution.event.eventId, actionId: resolution.event.actionId, observationId: resolution.event.observationId,
      status: resolution.status, verdict: resolution.proof?.verdict ?? null, evidenceId: resolution.proof?.evidenceId ?? null,
    });
  }
  return matches;
}
function targetsFor(pending, steps, leaseKey) {
  const targets = [];
  const seen = new Set();
  for (const event of pending) {
    const step = steps.find(item => item.open && item.actionId === event.actionId) ?? null;
    const resolution = null;
    targets.push({event: pendingView(event), step, kind: 'pending', resolution});
    seen.add(event.actionId);
  }
  for (const step of steps.filter(item => item.open)) {
    if (seen.has(step.actionId)) continue;
    seen.add(step.actionId);
    targets.push({event: null, step, kind: 'open-step', resolution: null, leaseKey});
  }
  return targets;
}
function resolveTarget(target, resolved) {
  if (target.kind === 'pending') return target;
  const resolution = [...resolved].reverse().find(item => item?.event?.actionId === target.step.actionId) ?? null;
  if (resolution?.event) return {...target, event: pendingView(resolution.event), kind: 'partial', resolution};
  const step = target.step;
  return {...target, kind: 'absent', resolution: null, event: pendingView({
    schemaVersion: 1, eventId: correlationUuid(`desktop-step:${step.id}`), leaseKey: target.leaseKey,
    sessionId: `desktop-step-${step.id.slice(0, 40)}`, actionId: step.actionId,
    observationId: 'desktop-step-no-journal-observation', startedAt: 0,
  })};
}
function outcomeReason(proofs) {
  const verdicts = new Set(proofs.map(item => item.proof.verdict));
  if (verdicts.size !== 1) return 'ACTION_RECONCILED';
  if (verdicts.has('not-executed')) return 'ACTION_NOT_EXECUTED';
  if (verdicts.has('executed')) return 'ACTION_CONFIRMED';
  return 'ACTION_UNCONFIRMED';
}

/** Point-in-time read. Does not take the owner lock, delete it, or change either ledger. Owner liveness is advisory. */
export function inspectDesktopSurface({directory, leaseKey = 'physical-host'} = {}) {
  if (!validLease(leaseKey)) return {status: 'UNREADABLE', reason: 'INVALID_INPUT'};
  if (!existsSync(directory)) return {status: 'CLEAR', reason: 'NO_SESSION_DIRECTORY', leaseKey, lock: null, pending: [], steps: [], matchingResolutions: [], counts: {pending: 0, openSteps: 0, resolved: 0}, stepsReadable: true, advisoryOwner: null};
  const root = preparePrivateDirectory(directory);
  const physical = join(root, 'physical');
  const lock = existsSync(join(physical, 'owner.lock')) ? readLock(join(physical, 'owner.lock')) : null;
  const journal = readJournalSnapshot(physical);
  if (!journal.readable) return {status: lock ? 'BUSY' : 'UNREADABLE', reason: 'JOURNAL_CORRUPT', leaseKey, lock, pending: [], steps: [], matchingResolutions: [], counts: {pending: 0, openSteps: 0, resolved: 0}, stepsReadable: false, advisoryOwner: lock ? 'Owner liveness is advisory. A dead pid does not authorize deleting the lock or either ledger.' : null};
  let steps = [], stepsReadable = true;
  if (existsSync(join(root, 'steps.sqlite'))) {
    try {
      const db = openStepsDatabase(root, {readOnly: true});
      steps = loadSteps(db); db?.close();
    } catch { stepsReadable = false; steps = []; }
  }
  const openSteps = publicSteps(steps);
  const pending = journal.pending.map(event => ({eventId: event.eventId, leaseKey: event.leaseKey, actionId: event.actionId, observationId: event.observationId, startedAt: event.startedAt}));
  const quarantined = journal.pending.length > 0 || openSteps.length > 0;
  const status = lock ? 'BUSY' : !stepsReadable ? 'UNREADABLE' : quarantined ? 'QUARANTINED' : 'CLEAR';
  return {
    status, reason: lock ? 'JOURNAL_BUSY' : !stepsReadable ? 'STEPS_UNREADABLE' : quarantined ? 'SURFACE_QUARANTINED' : 'NO_PENDING_ACTION',
    leaseKey, lock, pending, steps: openSteps, matchingResolutions: matchingResolutions(steps, journal.resolved),
    counts: {pending: journal.pending.length, openSteps: openSteps.length, resolved: journal.resolved.length},
    stepsReadable, advisoryOwner: lock ? 'Owner liveness is advisory. A dead pid does not authorize deleting the lock or either ledger.' : null,
  };
}

/** One-at-a-time recovery. Never executes, replays, deletes a ledger, or removes owner.lock. */
export async function reconcileDesktopSurface({directory, verify, leaseKey = 'physical-host', signal, maxDurationMs = 2000} = {}) {
  if (typeof verify !== 'function' || !validLease(leaseKey) || !Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 2000 || (signal !== undefined && typeof signal?.addEventListener !== 'function')) return {status: 'UNKNOWN', reason: 'INVALID_INPUT'};
  if (!existsSync(directory)) return {status: 'CLEAR', reason: 'NO_SESSION_DIRECTORY', leaseKey};
  const root = preparePrivateDirectory(directory);
  const physical = join(root, 'physical');
  const lockPath = join(physical, 'owner.lock');
  if (existsSync(lockPath)) return {status: 'BUSY', reason: 'JOURNAL_BUSY', lock: readLock(lockPath)};
  const controller = new AbortController();
  const deadline = Date.now() + maxDurationMs;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, {once: true});
  if (signal?.aborted) onAbort();
  let active = true, settled = false, timer, journal, db, ignoreLate = false;
  const check = () => { if (!active || Date.now() >= deadline) throw Error('DEADLINE'); if (controller.signal.aborted) throw Error('CANCELLED'); };
  const fail = error => ({status: 'UNKNOWN', reason: error instanceof Error && REASONS.has(error.message) ? error.message : 'RECONCILIATION_FAILED'});
  try {
    journal = await FileExecutionJournal.open(physical);
    const snapshot = readJournalSnapshot(physical);
    if (!snapshot.readable) return {status: 'UNREADABLE', reason: 'JOURNAL_CORRUPT'};
    const dbExists = existsSync(join(root, 'steps.sqlite'));
    if (snapshot.pending.length === 0 && !dbExists) return {status: 'CLEAR', reason: 'NO_PENDING_ACTION', leaseKey};
    db = dbExists ? openStepsDatabase(root) : null;
    const steps = loadSteps(db);
    const openSteps = steps.filter(step => step.open);
    if (snapshot.pending.length === 0 && openSteps.length === 0) return {status: 'CLEAR', reason: 'NO_PENDING_ACTION', leaseKey};
    const operation = (async () => {
      const decisions = [];
      for (const seed of targetsFor(snapshot.pending, steps, leaseKey)) {
        const target = resolveTarget(seed, snapshot.resolved);
        check();
        const stepView = target.step ? {id: target.step.id, actionId: target.step.actionId, status: target.step.status, code: target.step.code, phase: target.step.phase, method: target.step.method, dispatch: target.step.dispatch} : null;
        const resolutionView = target.resolution ? {status: target.resolution.status, verdict: target.resolution.proof?.verdict ?? null, evidenceId: target.resolution.proof?.evidenceId ?? null, observationId: target.resolution.proof?.observationId ?? null} : null;
        const value = await verify(Object.freeze(target.event), Object.freeze({
          signal: controller.signal, deadline, journalKind: target.kind, step: Object.freeze(stepView), resolution: resolutionView && Object.freeze(resolutionView),
        }));
        check();
        decisions.push({target, ...judge(target.event, target.step, target.resolution, value)});
      }
      check();
      const applied = [];
      for (const decision of decisions) {
        check();
        if (decision.target.kind === 'pending') await journal.reconcile(decision.target.event, decision.proof);
        if (decision.target.step && db) {
          const status = TERMINAL[decision.proof.verdict];
          const record = {
            status, code: decision.target.step.code, dispatch: decision.proof.verdict, basis: decision.basis,
            proof: decision.proof, priorStatus: decision.target.step.status, journalKind: decision.target.kind,
            journalStatus: decision.target.resolution?.status ?? (decision.target.kind === 'pending' ? 'pending' : 'absent'),
            journalVerdict: decision.target.resolution?.proof?.verdict ?? null, replayed: false, source: 'reconcileDesktopSession',
          };
          const changed = db.prepare("UPDATE steps SET status=?, result=?, phase='reconciled' WHERE id=? AND status IN ('PLANNING','EXECUTING','UNKNOWN')").run(status, JSON.stringify(record), decision.target.step.id);
          if (Number(changed.changes) !== 1) throw Error('EVENT_MISMATCH');
          applied.push({id: decision.target.step.id, actionId: decision.target.step.actionId, status, verdict: decision.proof.verdict, basis: decision.basis});
        }
      }
      check();
      const after = readJournalSnapshot(physical);
      const remainingSteps = loadSteps(db).filter(step => step.open);
      if (!after.readable || after.pending.length > 0 || remainingSteps.length > 0) throw Error('SURFACE_QUARANTINED');
      return {status: 'RESOLVED', reason: outcomeReason(decisions), leaseKey, steps: applied, replayed: false};
    })();
    const guarded = operation.catch(error => { if (ignoreLate) return undefined; throw error; });
    const stopped = new Promise((_resolve, reject) => {
      const rejectStopped = code => { if (settled) return; active = false; reject(Error(code)); };
      timer = setTimeout(() => rejectStopped('DEADLINE'), Math.max(1, deadline - Date.now()));
      controller.signal.addEventListener('abort', () => rejectStopped('CANCELLED'), {once: true});
      if (controller.signal.aborted) rejectStopped('CANCELLED');
    });
    const outcome = await Promise.race([guarded, stopped]);
    settled = true;
    return outcome;
  } catch (error) { settled = true; return fail(error); }
  finally {
    ignoreLate = true; active = false; clearTimeout(timer); controller.abort();
    signal?.removeEventListener('abort', onAbort);
    if (db) { try { db.close(); } catch { /* The journal lock still has to be released. */ } }
    if (journal) await journal.close();
  }
}
