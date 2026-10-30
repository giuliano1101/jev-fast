import {
    closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
    readSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function privateEntry(stat: Stats, directory: boolean): boolean {
    return typeof process.getuid === 'function' && stat.uid === process.getuid()
        && (stat.mode & 0o7777) === (directory ? 0o700 : 0o600)
        && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1);
}
function sameEntry(first: Stats, second: Stats): boolean {
    return first.dev === second.dev && first.ino === second.ino;
}
function readPrivateFile(path: string, maximum: number): Buffer {
    const before = lstatSync(path);
    if (!privateEntry(before, false) || before.size > maximum) throw new Error('UNSAFE_FILE');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const opened = fstatSync(fd);
        if (!privateEntry(opened, false) || !sameEntry(before, opened) || opened.size > maximum) throw new Error('UNSAFE_FILE');
        const bytes = Buffer.alloc(maximum + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, null);
            if (count === 0) break;
            length += count;
        }
        const after = fstatSync(fd);
        if (length > maximum || !privateEntry(after, false) || !sameEntry(after, lstatSync(path))
            || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('UNSAFE_FILE');
        return bytes.subarray(0, length);
    } finally { closeSync(fd); }
}

/** Read only the explicitly provided private staging file; errors never expose it. */
export function readLocalKey(path: string): string {
    let directoryFd: number | undefined;
    try {
        if (!/^\/private\/tmp\/jev-key-[A-Za-z0-9_-]+\/api-key$/.test(path)) throw new Error('UNSAFE_KEY');
        const directory = dirname(path);
        const before = lstatSync(directory);
        if (!privateEntry(before, true)) throw new Error('UNSAFE_KEY');
        directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const opened = fstatSync(directoryFd);
        if (!privateEntry(opened, true) || !sameEntry(before, opened)) throw new Error('UNSAFE_KEY');
        const bytes = readPrivateFile(path, 4096);
        const after = lstatSync(directory);
        if (!privateEntry(after, true) || !sameEntry(opened, after)
            || bytes.length === 0 || bytes.some(byte => byte < 0x21 || byte > 0x7e)) throw new Error('UNSAFE_KEY');
        return bytes.toString('ascii');
    } catch {
        throw new Error('LOCAL_KEY_REJECTED');
    } finally {
        if (directoryFd !== undefined) closeSync(directoryFd);
    }
}

interface BudgetOptions { maxUsd: number; maxRequests: number; expiresAt: number }
interface BudgetState extends BudgetOptions { version: 1; requests: number }
export interface BudgetSummary extends BudgetOptions { requests: number; reservedUsd: number }

function validOptions(value: BudgetOptions): boolean {
    return Number.isFinite(value.maxUsd) && value.maxUsd > 0 && value.maxUsd <= 3
        && Number.isInteger(value.maxRequests) && value.maxRequests > 0 && value.maxRequests <= 300
        && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0;
}

/** A reservation is charged at $0.01 before the caller may start its HTTP attempt. */
export class RequestBudget {
    private closed = false;
    private uncertain = false;
    private readonly directory: string;
    private readonly directoryFd: number;
    private readonly lockFd: number;
    private state: BudgetState;
    private constructor(
        directory: string, directoryFd: number, lockFd: number, state: BudgetState,
    ) {
        this.directory = directory;
        this.directoryFd = directoryFd;
        this.lockFd = lockFd;
        this.state = state;
    }

    static open(directory: string, options: BudgetOptions): RequestBudget {
        return RequestBudget.openInternal(directory, options, false);
    }

    /** Resume only an already existing host ledger; never initialize or renew it. */
    static openExisting(directory: string, options: BudgetOptions): RequestBudget {
        return RequestBudget.openInternal(directory, options, true);
    }

    private static openInternal(directory: string, options: BudgetOptions, requireExisting: boolean): RequestBudget {
        options = { maxUsd: options.maxUsd, maxRequests: options.maxRequests, expiresAt: options.expiresAt };
        if (!validOptions(options) || Date.now() >= options.expiresAt) throw new Error('BUDGET_OPTIONS_REJECTED');
        let directoryFd: number | undefined;
        let lockFd: number | undefined;
        let persistenceStarted = false;
        const root = resolve(directory);
        const lockPath = join(root, '.budget.lock');
        try {
            const firstCreated = requireExisting ? undefined : mkdirSync(root, { mode: 0o700, recursive: true });
            // Persist each new directory's parent entry as well as the ledger itself.
            if (firstCreated !== undefined) {
                const lastParent = dirname(firstCreated);
                let parent = dirname(root);
                for (;;) {
                    const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
                    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
                    if (parent === lastParent) break;
                    parent = dirname(parent);
                }
            }
            const before = lstatSync(root);
            if (!privateEntry(before, true)) throw new Error('BUDGET_DIRECTORY_REJECTED');
            directoryFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            if (!sameEntry(before, fstatSync(directoryFd))) throw new Error('BUDGET_DIRECTORY_REJECTED');
            lockFd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            writeFileSync(lockFd, JSON.stringify({ pid: process.pid, token: randomUUID() }));
            fsyncSync(lockFd);
            fsyncSync(directoryFd);
            const ledgerPath = join(root, 'budget.json');
            let state: BudgetState;
            let exists = true;
            try { lstatSync(ledgerPath); } catch (error) {
                if (requireExisting || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                exists = false;
            }
            if (exists) {
                const prior = JSON.parse(readPrivateFile(ledgerPath, 4096).toString('utf8')) as BudgetState;
                if (!prior || prior.version !== 1 || !validOptions(prior) || !Number.isInteger(prior.requests)
                    || prior.requests < 0 || prior.requests > prior.maxRequests || prior.requests / 100 > prior.maxUsd
                    || options.maxUsd > prior.maxUsd || options.maxRequests > prior.maxRequests
                    || options.expiresAt > prior.expiresAt || Date.now() >= prior.expiresAt
                    || prior.requests > options.maxRequests || prior.requests / 100 > options.maxUsd) throw new Error('BUDGET_STATE_REJECTED');
                state = { version: 1, requests: prior.requests, ...options };
            } else {
                state = { version: 1, requests: 0, ...options };
            }
            const budget = new RequestBudget(root, directoryFd, lockFd, state);
            persistenceStarted = true;
            budget.persist(state);
            return budget;
        } catch {
            if (lockFd !== undefined) {
                closeSync(lockFd);
                // Uncertain writes retain their lock for explicit manual recovery.
                if (!persistenceStarted) { unlinkSync(lockPath); if (directoryFd !== undefined) fsyncSync(directoryFd); }
            }
            if (directoryFd !== undefined) closeSync(directoryFd);
            throw new Error('BUDGET_OPEN_REJECTED');
        }
    }

    private assertOwned(): void {
        if (this.closed || this.uncertain) throw new Error('BUDGET_UNAVAILABLE');
        const directory = lstatSync(this.directory);
        const lock = lstatSync(join(this.directory, '.budget.lock'));
        if (!privateEntry(directory, true) || !sameEntry(directory, fstatSync(this.directoryFd))
            || !privateEntry(lock, false) || !sameEntry(lock, fstatSync(this.lockFd))) throw new Error('BUDGET_UNAVAILABLE');
    }

    private persist(state: BudgetState): void {
        this.assertOwned();
        const temporary = join(this.directory, `.budget-${randomUUID()}.tmp`);
        let fd: number | undefined;
        try {
            fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            writeFileSync(fd, JSON.stringify(state));
            fsyncSync(fd);
            closeSync(fd); fd = undefined;
            renameSync(temporary, join(this.directory, 'budget.json'));
            fsyncSync(this.directoryFd);
        } catch {
            this.uncertain = true;
            throw new Error('BUDGET_PERSISTENCE_REJECTED');
        } finally { if (fd !== undefined) closeSync(fd); }
    }

    reserve(): { request: number; reservedUsd: number } {
        try {
            this.assertOwned();
            const request = this.state.requests + 1;
            if (Date.now() >= this.state.expiresAt || request > this.state.maxRequests || request / 100 > this.state.maxUsd) throw new Error('BUDGET_LIMIT_REACHED');
            const next = { ...this.state, requests: request };
            this.persist(next);
            this.state = next;
            return { request, reservedUsd: request / 100 };
        } catch { throw new Error('BUDGET_RESERVATION_REJECTED'); }
    }

    summary(): BudgetSummary {
        return { requests: this.state.requests, reservedUsd: this.state.requests / 100,
            maxUsd: this.state.maxUsd, maxRequests: this.state.maxRequests, expiresAt: this.state.expiresAt };
    }

    close(): void {
        if (this.closed) return;
        try {
            if (!this.uncertain) {
                this.assertOwned();
                unlinkSync(join(this.directory, '.budget.lock'));
                fsyncSync(this.directoryFd);
            }
        } catch { throw new Error('BUDGET_CLOSE_REJECTED'); }
        finally {
            this.closed = true;
            closeSync(this.lockFd);
            closeSync(this.directoryFd);
        }
    }
}
