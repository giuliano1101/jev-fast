# Metered Service Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with TDD and independent specification then quality review. Parent manages private runtime and deployment. Do not stop the shared coordinator.

**Goal:** The operator explicitly requests unlimited paid service duration/cost/request count with durable usage accounting instead of budget refusal.

**Architecture:** Add explicit trusted `metering` policy, mutually exclusive with capped authorization, without huge pretend caps. Persist every HTTP attempt before dispatch and its usage/status after response independently of goal success. Keep historical capped budgets immutable and available; current service stops consulting them. Existing action correctness, idempotency, TLS and shared execution controls remain.

**Tech Stack:** Node24 TypeScript, existing Jev provider/HTTPS gateway, private SQLite usage ledger, local operator CLI and current detached gateway runner.

## Task 1: Accounting-only provider and ledger

Files: `src/providers/jev.ts`, new `src/remote/usage.ts`, `tests/unit/metered-usage.test.ts`, `tests/unit/metered-operator.test.ts`, `tests/unit/metered-store-cost.test.ts`.

- [x] Write RED tests: explicit metering performs over 1,000 cumulative calls without count/cost/date caps; ordinary capped mode remains unchanged; invalid/missing/mixed policy rejects. No real HTTP in tests.
- [x] Write RED ledger tests for pre-dispatch persistence, retries/failures/missing usage, reopen with unfinished attempts counted unknown, per-policy/identity summary, no double completion, and private-file validation.
- [x] Implement `UsageLedger` and trusted recorder contract. Record attempt ID, policy ID, identity/request context, timestamps, HTTP status, input/output token counts or null, known cost, and unknown usage separately. No prompts, bodies, keys, synthetic reservations treated as charges, or unknown cost represented as zero actual cost. Use SQLite FULL synchronous transactions and owner-only files.
- [x] Add `JevOptions.metering` with policy id and recorder, exclusive of old authorization. In metered mode do not test caps/date or enforce RESERVED_TOKENS as spending cap; retain projection, decision and request deadlines/cancellation. Begin immediately before each actual transport dispatch, finish in finally; parse valid top-level usage independently of answer validity. Recorder errors prevent dispatch/return; preserve original request lifetime.
- [x] Run focused test command: `. scripts/env.sh; npm run build; node --test dist/tests/unit/metered-usage.test.js dist/tests/unit/jev.test.js` and inspect passing counts.

## Task 2: Gateway and operator wiring

Files: `src/remote/gateway.ts`, `src/remote/main.ts`, new integration tests.

- [x] Add explicit trusted live union: old `{key, authorization, approval}` or `{key, metering:{policy_id,ledger}}`; never AI/MCP arguments. Metered gateway skips configureBudget/reserve only for metered policy, persists attempts in UsageLedger, retains signed Jev route and request ownership.
- [x] Allow private approval file `{metering:{policy_id:"operator-usage-only"}}` with no expiry/count/cost fields. Add local `usage --config FILE` command returning totals without API key or hosted call. Close ledger on normal gateway shutdown, preserve history.
- [x] Add offline HTTPS tests: metered requests with real TLS fixtures produce signed Jev receipts; duplicate request produces no extra HTTP/charge; old capped budgets still reject; missing usage/failure persists unknown; no hosted calls.
- [x] Specification review then quality review; resolve important findings. Parent verifies diff and complete type/lint/default/integration/safety suites.

## Task 3: Switch the configured Mac

Files: ignored `.runtime/live-service/` operator runner/config and public docs/artifacts.

- [x] Save current runner and approval without deleting ledgers. Write explicit current operator unlimited-metering instruction. Remove original RequestBudget wrapper from active transport and child budget mode; do not mutate old counters or old approvals.
- [x] Remove budget expiry from token/enrollment renewal; continue short-lived credential rotation within existing certificate lifetime, no new AI authentication burden. Keep same identity, CA, receipts and remote profile so coordinator does not restart.
- [x] Wait until no in-flight/pending action, gracefully replace only loopback gateway with detached metered runner; keep coordinator/connector/panel/auto-admission alive. Verify free doctor health and metering policy.
- [x] Run one real public MCP synthetic goal and check signed route=jev, durable known tokens/cost or explicit unknown, original budget unchanged, and no per-AI key request.
- [x] Update current docs/AGENTS/README, report exact cost method/unknowns and scope. Remove superseded remaining-2-calls/current-budget claims; keep historical S17 artifacts unchanged. Scan changed files for private material.
- [x] Commit/push user repository and verify CI. Leave service running. No later approval or new spending cap needed under this explicit operator instruction; preserve manual stop.

Completion: source and local runtime completed, real proof521 input tokens/$0.000021882, originalbudgetunchanged. Finaltests424/78/40 +Python16. SpecreviewbugfixedwithdefaultNodechildprocessregression; independent spec/qualityapproved. GitHub publication/CI recorded by final delivery.
