import {DatabaseSync} from 'node:sqlite';
import {chmodSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {preparePrivateDirectory, assertPrivateFile} from './dist/src/service/private-directory.js';

const PRICE = 0.042 / 1e6;
// The official default per-request context is 64k; long-context opt-in is never sent.
const MAX_REQUEST_COST = 65536 * PRICE;
/** Explicit campaign budget only. Pending/missing usage keeps its full reservation. */
export class TestBudget {
  #db;
  constructor({directory, limitUsd}) {
    if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw Error('INVALID_BUDGET');
    const root = preparePrivateDirectory(directory), path = join(root, 'budget.sqlite');
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) assertPrivateFile(path + suffix);
    this.#db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY CHECK(id=1),limit_usd REAL NOT NULL); CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,reserved REAL NOT NULL,cost REAL,http_status INTEGER,finished INTEGER NOT NULL DEFAULT 0);');
    this.#db.prepare('INSERT OR IGNORE INTO config VALUES(1,?)').run(limitUsd);
    const config = this.#db.prepare('SELECT limit_usd FROM config WHERE id=1').get();
    if (config.limit_usd !== limitUsd) { this.#db.close(); throw Error('BUDGET_CONFIG_MISMATCH'); }
  }
  summary() {
    const row = this.#db.prepare('SELECT COUNT(*) AS attempts, COALESCE(SUM(cost),0) AS known_cost_usd, COALESCE(SUM(CASE WHEN cost IS NULL THEN reserved ELSE 0 END),0) AS reserved_unknown_usd, SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unknown_attempts FROM attempts').get();
    return {...row, unknown_attempts: row.unknown_attempts ?? 0, limit_usd: this.#db.prepare('SELECT limit_usd FROM config').get().limit_usd,
      committed_usd: row.known_cost_usd + row.reserved_unknown_usd};
  }
  wrap(recorder) {
    const ids = new Map();
    return {
      begin: () => {
        const id = randomUUID();
        this.#db.exec('BEGIN IMMEDIATE');
        try {
          const s = this.summary();
          if (s.committed_usd + MAX_REQUEST_COST > s.limit_usd + 1e-12) throw Error('TEST_BUDGET_EXHAUSTED');
          this.#db.prepare('INSERT INTO attempts(id,reserved) VALUES(?,?)').run(id, MAX_REQUEST_COST);
          this.#db.exec('COMMIT');
        } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
        // If the usage ledger cannot begin, the conservative reservation stays held.
        const attempt = recorder.begin();
        if (typeof attempt !== 'string') throw Error('SYNC_RECORDER_REQUIRED');
        ids.set(attempt, id); return attempt;
      },
      finish: (attempt, completion) => {
        const id = ids.get(attempt); if (!id) throw Error('BUDGET_ATTEMPT_UNKNOWN');
        recorder.finish(attempt, completion);
        const usage = completion.usage;
        const cost = usage ? usage.input_tokens * PRICE : null;
        const changed = this.#db.prepare('UPDATE attempts SET cost=?,http_status=?,finished=1 WHERE id=? AND finished=0').run(cost, completion.http_status, id);
        if (changed.changes !== 1) throw Error('BUDGET_ATTEMPT_NOT_PENDING');
        ids.delete(attempt);
      },
    };
  }
  close() { this.#db.close(); }
}
