import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Dynamic loading keeps the initial missing implementation a test assertion failure.
const accessURL = new URL('../../bench/live/access.ts', import.meta.url);
if (import.meta.url.endsWith('.js')) accessURL.pathname = accessURL.pathname.replace(/\.ts$/, '.js');
type Access = typeof import('../../bench/live/access.js');
async function access(): Promise<Access> {
    const result = await import(accessURL.href).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
        throw error;
    }) as Access | null;
    assert.ok(result, 'live access implementation must exist');
    return result;
}
function temporary(prefix: string, run: (directory: string) => void): void {
    const directory = mkdtempSync(`/private/tmp/${prefix}`);
    try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
const options = () => ({ maxUsd: 0.03, maxRequests: 3, expiresAt: Date.now() + 60_000 });

test('secure key reader accepts only a private synthetic key file', async () => {
    const { readLocalKey } = await access();
    temporary('jev-key-test-', directory => {
        const path = join(directory, 'api-key');
        writeFileSync(path, 'synthetic-only-KEY_123', { mode: 0o600 });
        assert.equal(readLocalKey(path), 'synthetic-only-KEY_123');
        chmodSync(path, 0o644);
        assert.throws(() => readLocalKey(path));
        chmodSync(path, 0o600);
        chmodSync(directory, 0o755);
        assert.throws(() => readLocalKey(path));
    });
});

test('key reader rejects file and directory symlinks and out-of-scope paths', async () => {
    const { readLocalKey } = await access();
    temporary('jev-key-test-', directory => {
        writeFileSync(join(directory, 'target'), 'synthetic-only', { mode: 0o600 });
        symlinkSync(join(directory, 'target'), join(directory, 'api-key'));
        assert.throws(() => readLocalKey(join(directory, 'api-key')));
        temporary('jev-key-test-', other => {
            const alias = `${other}-alias`;
            try {
                symlinkSync(directory, alias);
                assert.throws(() => readLocalKey(join(alias, 'api-key')));
            } finally { rmSync(alias, { force: true }); }
        });
        assert.throws(() => readLocalKey('/tmp/jev-key-test/api-key'));
    });
});

test('key contents and failures are bounded and redacted', async () => {
    const { readLocalKey } = await access();
    temporary('jev-key-test-', directory => {
        const path = join(directory, 'api-key');
        for (const content of ['', 'synthetic SECRET\n', 'synthetic\tSECRET', 'é', 'a'.repeat(4097)]) {
            writeFileSync(path, content, { mode: 0o600 });
            assert.throws(() => readLocalKey(path), error => {
                const message = String(error);
                assert.ok(!message.includes(directory));
                assert.ok(!message.includes('synthetic'));
                assert.ok(!message.includes('SECRET'));
                return true;
            });
        }
        writeFileSync(path, 'a'.repeat(4096));
        assert.equal(readLocalKey(path).length, 4096);
        rmSync(path);
        assert.throws(() => readLocalKey(path), error => !String(error).includes(directory));
    });
});

test('budget persists each reservation before returning and reloads without refunds', async () => {
    const { RequestBudget } = await access();
    temporary('jev-budget-test-', directory => {
        const config = options();
        let budget = RequestBudget.open(directory, config);
        try {
            assert.deepEqual(budget.reserve(), { request: 1, reservedUsd: 0.01 });
            const disk = JSON.parse(readFileSync(join(directory, 'budget.json'), 'utf8'));
            assert.equal(disk.requests, 1);
            budget.close();
            budget = RequestBudget.open(directory, config);
            assert.deepEqual(budget.summary(), { requests: 1, reservedUsd: 0.01, ...config });
            assert.deepEqual(budget.reserve(), { request: 2, reservedUsd: 0.02 });
            budget.reserve();
            assert.throws(() => budget.reserve());
            assert.equal(budget.summary().requests, 3);
        } finally { budget.close(); }
        assert.throws(() => budget.reserve());
    });
});

test('budget separately enforces USD and request caps and rejects unsafe bounds', async () => {
    const { RequestBudget } = await access();
    for (const config of [{ ...options(), maxUsd: 0.01 }, { ...options(), maxRequests: 1 }]) {
        temporary('jev-budget-test-', directory => {
            const budget = RequestBudget.open(directory, config);
            try { budget.reserve(); assert.throws(() => budget.reserve()); } finally { budget.close(); }
        });
    }
    for (const change of [{ maxUsd: 3.01 }, { maxUsd: NaN }, { maxUsd: 0 }, { maxRequests: 301 }, { maxRequests: 1.5 }, { maxRequests: 0 }, { expiresAt: Date.now() - 1 }]) {
        temporary('jev-budget-test-', directory => assert.throws(() => RequestBudget.open(directory, { ...options(), ...change })));
    }
});

test('reopen cannot expand prior limits or extend expiry', async () => {
    const { RequestBudget } = await access();
    temporary('jev-budget-test-', directory => {
        const config = options();
        const first = RequestBudget.open(directory, config);
        first.reserve(); first.close();
        for (const change of [{ maxUsd: 0.04 }, { maxRequests: 4 }, { expiresAt: config.expiresAt + 1 }]) {
            assert.throws(() => RequestBudget.open(directory, { ...config, ...change }));
        }
        const smaller = RequestBudget.open(directory, { ...config, maxRequests: 1 });
        try { assert.throws(() => smaller.reserve()); } finally { smaller.close(); }
        assert.throws(() => RequestBudget.open(directory, config));
    });
});

test('active and crashed process locks both fail closed', async () => {
    const { RequestBudget } = await access();
    temporary('jev-budget-test-', directory => {
        const config = options();
        const budget = RequestBudget.open(directory, config);
        try {
            assert.throws(() => RequestBudget.open(directory, config));
            const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {RequestBudget} from ${JSON.stringify(accessURL.href)};try {RequestBudget.open(${JSON.stringify(directory)},${JSON.stringify(config)});process.exit(2);} catch {process.exit(0);}`]);
            assert.equal(child.status, 0, child.stderr.toString());
        } finally { budget.close(); }
        const crash = spawnSync(process.execPath, ['--input-type=module', '-e', `import {RequestBudget} from ${JSON.stringify(accessURL.href)};const b=RequestBudget.open(${JSON.stringify(directory)},${JSON.stringify(config)});b.reserve();process.exit(0);`]);
        assert.equal(crash.status, 0, crash.stderr.toString());
        assert.throws(() => RequestBudget.open(directory, config));
        assert.equal(JSON.parse(readFileSync(join(directory, 'budget.json'), 'utf8')).requests, 1);
    });
});

test('budget expiry is enforced on every reservation', async () => {
    const { RequestBudget } = await access();
    const originalNow = Date.now;
    temporary('jev-budget-test-', directory => {
        const config = options();
        const budget = RequestBudget.open(directory, config);
        try {
            Date.now = () => config.expiresAt;
            assert.throws(() => budget.reserve());
            assert.equal(budget.summary().requests, 0);
        } finally { Date.now = originalNow; budget.close(); }
    });
});

test('corrupt budget ledger cannot silently reset accumulated spend', async () => {
    const { RequestBudget } = await access();
    temporary('jev-budget-test-', directory => {
        writeFileSync(join(directory, 'budget.json'), '{"requests":-1}', { mode: 0o600 });
        assert.throws(() => RequestBudget.open(directory, options()));
    });
});

test('reopen cannot reset reservations through surplus option fields', async () => {
    const { RequestBudget } = await access();
    temporary('jev-budget-test-', directory => {
        const config = options();
        const first = RequestBudget.open(directory, config);
        first.reserve(); first.close();
        const injected = { ...config, requests: 0, version: 1 };
        const second = RequestBudget.open(directory, injected);
        try { assert.equal(second.summary().requests, 1); } finally { second.close(); }
    });
});

test('failed durable writes prevent sending and retain a fail-closed lock', async () => {
    const { RequestBudget } = await access();
    temporary('jev-budget-test-', directory => {
        const config = options();
        const budget = RequestBudget.open(directory, config);
        rmSync(join(directory, 'budget.json'));
        mkdirSync(join(directory, 'budget.json'));
        assert.throws(() => budget.reserve());
        assert.throws(() => budget.reserve());
        budget.close();
        assert.throws(() => RequestBudget.open(directory, config));
    });
});

test('budget creates a private nested directory for a new ledger', async () => {
    const { RequestBudget } = await access();
    temporary('jev-budget-test-', directory => {
        const budget = RequestBudget.open(join(directory, 'new', 'ledger'), options());
        try { assert.equal(budget.reserve().request, 1); } finally { budget.close(); }
    });
});
