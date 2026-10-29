import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../src/session/ledger.js';
test('exclusive durable ledger survives reopen and quarantines uncertain actions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jev-ledger-'));
    const ledger = await Ledger.open(dir);
    try {
        await assert.rejects(Ledger.open(dir), /STORAGE_BUSY/);
        await ledger.transaction(state => { state.sessions.s = { owner: 'a', fixture_id: 'standard', allowed_origin: 'http://127.0.0.1:1234', epoch: 1, quarantined: false, closed: false }; state.goals.g = { session_id: 's', goal_id: 'g', idempotency_key: 'i', request_hash: 'hash', status: 'RUNNING', steps: 0, elapsed_ms: 0, reason: null, evidence: [], action_ids: ['a'] }; state.actions.a = { action_id: 'a', session_id: 's', goal_id: 'g', lease_epoch: 1, idempotency_key: 'i', request_hash: 'hash', snapshot_id: 'snap', candidate_id: 'c', policy_version: 'p0-v1', status: 'EXECUTING', created_at: 1, updated_at: 1 }; });
        await ledger.close();
        const reopened = await Ledger.open(dir);
        assert.equal(reopened.state.actions.a?.status, 'UNKNOWN');
        assert.equal(reopened.state.sessions.s?.quarantined, true);
        assert.equal(reopened.state.goals.g?.status, 'UNKNOWN');
        const text = await readFile(join(dir, 'ledger.json'), 'utf8');
        assert.ok(text.includes('UNKNOWN'));
        await reopened.close();
    }
    finally {
        await ledger.close();
        await rm(dir, { recursive: true, force: true });
    }
});
test('dead-process owner lock is reclaimed without replaying EXECUTING action', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const dir = await mkdtemp(join(tmpdir(), 'jev-crash-'));
    const moduleURL = new URL('../../src/session/ledger.js', import.meta.url).href;
    try {
        await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `import {Ledger} from ${JSON.stringify(moduleURL)};const ledger=await Ledger.open(${JSON.stringify(dir)});await ledger.transaction(s=>{s.sessions.s={owner:'a',fixture_id:'standard',allowed_origin:'http://127.0.0.1:1234',epoch:1,quarantined:false,closed:false};s.goals.g={session_id:'s',goal_id:'g',idempotency_key:'i',request_hash:'hash',status:'RUNNING',steps:0,elapsed_ms:0,reason:null,evidence:[],action_ids:['a']};s.actions.a={action_id:'a',session_id:'s',goal_id:'g',lease_epoch:1,idempotency_key:'i',request_hash:'hash',snapshot_id:'snap',candidate_id:'c',policy_version:'p0-v1',status:'EXECUTING',created_at:1,updated_at:1};});process.exit(0);`]);
        const ledger = await Ledger.open(dir);
        assert.equal(ledger.state.actions.a?.status, 'UNKNOWN');
        assert.equal(ledger.state.sessions.s?.quarantined, true);
        await ledger.close();
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
