import test from 'node:test';
import assert from 'node:assert/strict';
import {zstdDecompressSync} from 'node:zlib';
import { JevProvider } from '../../src/providers/jev.js';
import type { DecisionInput } from '../../src/core/contracts.js';
const input: DecisionInput = { synthetic: true, snapshot_id: 'snap', summary: 'synthetic form', goal: { task: 'form', language: 'en' }, candidates: [{ candidate_id: 'c', description: 'Complete synthetic form' }] };
const approval = () => ({ approval_id: 'synthetic-test', expires_at: Date.now() + 10000, synthetic_only: true as const, max_requests: 3, max_cost_usd: .01 });
const context = () => ({ signal: new AbortController().signal, deadline: Date.now() + 5000 });
const response = () => new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { action: { type: 'choice', choice: 'c', confidence: 1, probabilities: { c: 1 } } }, usage: { input_tokens: 10, output_tokens: 1 } }), { status: 200 });
test('large synthetic requests use lossless zstd and reuse the same bytes on bounded retry', async () => {
    const large = {...input, summary: 'synthetic form '.repeat(200)};
    const bodies: Uint8Array[] = [];
    const provider = new JevProvider({key:'synthetic-key', authorization:approval(), transport:async (_url, options) => {
        assert.equal(new Headers(options?.headers).get('content-encoding'), 'zstd');
        assert.ok(options?.body instanceof Uint8Array);
        const bytes = options.body;
        bodies.push(bytes);
        const decoded = zstdDecompressSync(bytes).toString('utf8');
        assert.equal(JSON.parse(decoded).state.summary, large.summary);
        assert.deepEqual(JSON.parse(decoded).questions.action.criteria, {c:input.candidates[0]!.description});
        assert.ok(bytes.byteLength < Buffer.byteLength(decoded));
        return bodies.length === 1 ? new Response('', {status:429, headers:{'retry-after':'0'}}) : response();
    }});
    await provider.decide(large, context());
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);
});
test('small requests stay plain JSON without content encoding', async () => {
    const provider = new JevProvider({key:'synthetic-key', authorization:approval(), transport:async (_url, options) => {
        assert.equal(new Headers(options?.headers).get('content-encoding'), null);
        assert.equal(typeof options?.body, 'string');
        return response();
    }});
    await provider.decide(input, context());
});
test('live requires explicit authorization and injected key; never reads environment', () => { assert.throws(() => new JevProvider({ key: 'synthetic-key' }), /LIVE_NOT_AUTHORIZED/); assert.throws(() => new JevProvider({ authorization: approval() }), /LIVE_NOT_AUTHORIZED/); });
test('fixed endpoint, no redirects, strict typed payload and safe projection', async () => { let calls = 0; const p = new JevProvider({ key: 'synthetic-key', authorization: approval(), transport: async (url, options) => { calls++; assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(options?.redirect, 'error'); assert.equal(options?.method, 'POST'); const body = JSON.parse(options!.body as string); assert.equal(body.model, 'jev-1.14.0'); assert.equal(body.questions.action.type, 'choice'); assert.deepEqual(body.questions.action.criteria, { c: 'Complete synthetic form' }); assert.ok(!String(options!.body).includes('DO_NOT_SEND')); return response(); } }); const result = await p.decide({ ...input, private_locator: 'DO_NOT_SEND' } as DecisionInput, context()); assert.equal(result.candidate_id, 'c'); assert.equal(calls, 1); });
test('429/529 share exactly one retry, each attempt reserves approval budget', async () => {
    let count = 0;
    const p = new JevProvider({ key: 'synthetic-key', authorization: approval(), transport: async () => { count++; return count === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : response(); } });
    await p.decide(input, context());
    assert.equal(count, 2);
    assert.equal(p.accounting().requests, 2);
    let capped = 0;
    const q = new JevProvider({ key: 'synthetic-key', authorization: { ...approval(), max_requests: 1 }, transport: async () => { capped++; return new Response('', { status: 529, headers: { 'retry-after': '0' } }); } });
    await assert.rejects(q.decide(input, context()), /REQUEST_CAP/);
    assert.equal(capped, 1);
});
test('Retry-After outside deadline and aborted requests never retry', async () => { let calls = 0; const p = new JevProvider({ key: 'synthetic-key', authorization: approval(), transport: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '90' } }); } }); await assert.rejects(p.decide(input, context()), /PROVIDER_DEADLINE/); assert.equal(calls, 1); const controller = new AbortController(); controller.abort(); await assert.rejects(p.decide(input, { ...context(), signal: controller.signal }), /CANCELLED/); assert.equal(calls, 1); });
test('malformed response and unsafe payload fail closed', async () => { for (const body of [{ model: 'jev-latest', answers: {} }, { model: 'jev-1.14.0', answers: { action: { type: 'choice', choice: 'c', confidence: 1, probabilities: { c: .3 } } }, usage: { input_tokens: 1, output_tokens: 0 } }]) {
    const p = new JevProvider({ key: 'synthetic-key', authorization: approval(), transport: async () => new Response(JSON.stringify(body)) });
    await assert.rejects(p.decide(input, context()));
} let calls = 0; const p = new JevProvider({ key: 'synthetic-key', authorization: approval(), transport: async () => { calls++; return response(); } }); await assert.rejects(p.decide({ ...input, synthetic: false } as unknown as DecisionInput, context()), /UNSAFE_OBSERVATION/); assert.equal(calls, 0); });
test('cost cap rejects before network and repeated overload has only two attempts', async () => { let calls = 0; const limited = new JevProvider({ key: 'synthetic-key', authorization: { ...approval(), max_cost_usd: 0.000001 }, transport: async () => { calls++; return response(); } }); await assert.rejects(limited.decide(input, context()), /COST_CAP/); assert.equal(calls, 0); const overloaded = new JevProvider({ key: 'synthetic-key', authorization: approval(), transport: async () => { calls++; return new Response('', { status: 529, headers: { 'retry-after': '0' } }); } }); await assert.rejects(overloaded.decide(input, context()), /PROVIDER_HTTP_ERROR/); assert.equal(calls, 2); assert.equal(overloaded.accounting().unknown_usage_requests, 2); });
test('transport ignoring abort is still deadline bounded and charges unknown usage', async () => { let calls = 0; const p = new JevProvider({ key: 'synthetic-key', authorization: approval(), transport: async () => { calls++; return new Promise(() => { }); } }); await assert.rejects(p.decide(input, { ...context(), deadline: Date.now() + 20 }), /PROVIDER_DEADLINE/); assert.equal(calls, 1); assert.equal(p.accounting().unknown_usage_requests, 1); });
test('response bodies and usage are bounded; missing usage stays unknown', async () => { for (const body of ['x'.repeat(65537), JSON.stringify({ model: 'jev-1.14.0', answers: { action: { type: 'choice', choice: 'c', confidence: 1 } }, usage: { input_tokens: -1, output_tokens: 0 } })]) {
    const p = new JevProvider({ key: 'synthetic-key', authorization: approval(), transport: async () => new Response(body) });
    await assert.rejects(p.decide(input, context()));
} const p = new JevProvider({ key: 'synthetic-key', authorization: approval(), transport: async () => new Response(JSON.stringify({ model: 'jev-1.14.0', answers: { action: { type: 'choice', choice: 'c', confidence: 1 } } })) }); const d = await p.decide(input, context()); assert.equal(d.usage, null); assert.equal(d.unknown_usage_requests, 1); assert.ok(p.accounting().reserved_cost_usd > 0); });
test('a stalled response cancellation cannot extend provider deadline',async()=>{const p=new JevProvider({key:'synthetic-key',authorization:approval(),transport:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}))});const result=await Promise.race([p.decide(input,{...context(),deadline:Date.now()+20}).then(()=> 'RESOLVED',error=>(error as Error).message),new Promise<string>(resolve=>setTimeout(()=>resolve('STILL_PENDING'),100))]);assert.equal(result,'PROVIDER_DEADLINE');});
test('S14 synthetic key in process environment never implicitly enables live',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const moduleURL=new URL('../../src/providers/jev.js',import.meta.url).href;
 const code=`import {JevProvider} from ${JSON.stringify(moduleURL)};let calls=0;globalThis.fetch=async()=>{calls++;throw Error('NETWORK_FORBIDDEN')};let denied=false;try{new JevProvider({authorization:{approval_id:'test',expires_at:Date.now()+1000,synthetic_only:true,max_requests:1,max_cost_usd:0.1}})}catch{denied=true;}console.log(JSON.stringify({calls,denied}));`;
 const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{env:{TYPESAFE_API_KEY:'CANARY_ENV_KEY'}});
 assert.deepEqual(JSON.parse(result.stdout),{calls:0,denied:true});assert.doesNotMatch(result.stdout+result.stderr,/CANARY_/);
});
test('durable reservation hook runs before each hosted attempt including retry',async()=>{let reserved=0,calls=0;const options={key:'synthetic-key',authorization:approval(),beforeAttempt:async()=>{reserved++;},transport:async()=>{calls++;assert.equal(reserved,calls);return calls===1?new Response('',{status:429,headers:{'retry-after':'0'}}):response();}};const provider=new JevProvider(options);await provider.decide(input,context());assert.equal(reserved,2);assert.equal(calls,2);});
test('failed or stalled durable reservation prevents network dispatch',async()=>{for(const hook of [async()=>{throw Error('DURABLE_CAP');},async()=>new Promise<void>(()=>{})]){let calls=0;const options={key:'synthetic-key',authorization:approval(),beforeAttempt:hook,transport:async()=>{calls++;return response();}};const provider=new JevProvider(options);await assert.rejects(provider.decide(input,{...context(),deadline:Date.now()+20}));assert.equal(calls,0);}});
