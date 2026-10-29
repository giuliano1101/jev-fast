import { mkdir, open, readFile, rename, unlink, rmdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LedgerState } from '../core/contracts.js';
import { Fault } from '../core/errors.js';
/** Exclusive owner marker and atomic fsync/rename snapshots. Stale markers require manual PID verification. */
export class Ledger {
    private tail: Promise<void> = Promise.resolve();
    private closed = false;
    private constructor(readonly directory: string, private lock: FileHandle, public state: LedgerState) { }
    static async open(directory: string): Promise<Ledger> {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        let lock: FileHandle;
        try {
            lock = await open(join(directory, 'owner.lock'), 'wx', 0o600);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw new Fault('STORAGE_BUSY');
            // Serialize stale-owner reclamation; re-read under the recovery guard before unlink.
            const recovery = join(directory, 'recovery.lock');
            try {
                await mkdir(recovery, { mode: 0o700 });
            }
            catch {
                throw new Fault('STORAGE_BUSY');
            }
            try {
                const marker = join(directory, 'owner.lock');
                const before = await stat(marker);
                const owner = JSON.parse(await readFile(marker, 'utf8')) as {
                    pid: unknown;
                };
                if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
                    throw new Fault('STORAGE_BUSY');
                try {
                    process.kill(owner.pid, 0);
                    throw new Fault('STORAGE_BUSY');
                }
                catch (e) {
                    if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
                        throw new Fault('STORAGE_BUSY');
                }
                if ((await stat(marker)).ino !== before.ino)
                    throw new Fault('STORAGE_BUSY');
                await unlink(marker);
                try {
                    lock = await open(marker, 'wx', 0o600);
                }
                catch {
                    throw new Fault('STORAGE_BUSY');
                }
            }
            finally {
                await rmdir(recovery);
            }
        }
        try {
            await lock.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
            await lock.sync();
            let state: LedgerState = { version: 1, sessions: {}, goals: {}, actions: {} };
            try {
                state = JSON.parse(await readFile(join(directory, 'ledger.json'), 'utf8')) as LedgerState;
                if (state.version !== 1 || !state.sessions || !state.goals || !state.actions)
                    throw new Error('invalid');
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw new Fault('STORAGE_CORRUPT');
            }
            const ledger = new Ledger(directory, lock, state);
            await ledger.transaction(s => {
                for (const action of Object.values(s.actions)) {
                    if (['EXECUTING', 'VERIFYING'].includes(action.status)) {
                        action.status = 'UNKNOWN';
                        const session = s.sessions[action.session_id];
                        if (session)
                            session.quarantined = true;
                    }
                }
                for (const goal of Object.values(s.goals)) {
                    if (goal.status === 'RUNNING') {
                        const unknown = goal.action_ids.some(id => s.actions[id]?.status === 'UNKNOWN');
                        goal.status = unknown ? 'UNKNOWN' : 'FALLBACK';
                        goal.reason = 'PROCESS_RESTART';
                    }
                }
                for (const session of Object.values(s.sessions))
                    session.epoch++;
            });
            return ledger;
        }
        catch (e) {
            await lock.close();
            await unlink(join(directory, 'owner.lock'));
            throw e;
        }
    }
    transaction(fn: (state: LedgerState) => void): Promise<void> {
        const next = this.tail.then(async () => { if (this.closed)
            throw new Fault('STORAGE_CLOSED'); const draft = structuredClone(this.state); fn(draft); const temp = join(this.directory, `ledger-${randomUUID()}.tmp`); const file = await open(temp, 'wx', 0o600); try {
            await file.writeFile(JSON.stringify(draft));
            await file.sync();
        }
        finally {
            await file.close();
        } await rename(temp, join(this.directory, 'ledger.json')); const dir = await open(this.directory, 'r'); try {
            await dir.sync();
        }
        finally {
            await dir.close();
        } this.state = draft; });
        this.tail = next.catch(() => { });
        return next;
    }
    async close(): Promise<void> { await this.tail; if (this.closed)
        return; this.closed = true; await this.lock.close(); await unlink(join(this.directory, 'owner.lock')); }
}
