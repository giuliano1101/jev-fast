# Remove Product Limits Implementation Plan

> **For agentic workers:** Use TDD, dispatch independent file domains in parallel, then independent specification and quality review. Parent integrates and deploys. Preserve the user's untracked `docs/other-ai-real-testing 2.md` untouched.

**Goal:** Remove artificial usage/session/goal/connection quotas and provide a general Jev choice API for real browser/desktop/mobile hosts, while preserving correct ownership, audit, cancellation and no-replay semantics.

**Architecture:** Existing fixture harness becomes multi-session with caller-owned optional goal limits. New `jev.choose_action` accepts caller task/state/actions rather than fixed task enums; Jev chooses and signs a decision proof, host executes through its existing browser/computer/mobile tool and verifies the resulting state. Real execution adapters are not invented or silently substituted. Legacy fixture tests remain available. Fee policy remains metering-only.

**Tech Stack:** Node24/TypeScript, existing MCP relay/connector/coordinator, HTTPS/mTLS Ed25519 decision gateway, per-context Playwright fixture browser, usage.sqlite and independent durable choice audit.

## Task 1 — Core session and goal limits

Own `src/core/contracts.ts`, `src/core/engine.ts`, `src/browser/adapter.ts`, `src/session/schema.ts` and relevant tests.

- [x] RED tests: concurrent opens allocate independent contexts; unrelated session executes/closes independently; per-session leases and owner checks remain. Browser startup is shared by promise to avoid concurrent Chromium launch races.
- [x] Remove global openSession BUSY guard; expose authoritative unlimited session capacity in health via parent. Remove maximum8steps/60s; optional omitted limits mean no product cap, not a huge sentinel cap. Caller-specified finite positive limits remain honored; cancellation always works.
- [x] Make omitted deadline timer-free (Infinity internal only, never persist it). Long caller durations use safe timer scheduling, no Node TimeoutOverflowWarning/early stop. Adjust ledger validation for more than64steps/actions without removing correctness relations.
- [x] Export `authorizeClient(client)` guard for coordinator general calls. Do not edit service/config/coordinator or network files.
- [x] Focused RED/GREEN tests and relevant prior tests, report changed expectations because old single-session/cap behavior intentionally removed.

## Task 2 — General signed choices and hosted metering

Own new `src/choice/contracts.ts`, `src/providers/choice.ts`, `src/remote/choice.ts`/choice store, `src/remote/gateway.ts`, `src/remote/client.ts`, `src/remote/credentials.ts`, `src/service/config.ts` and relevant tests.

- [x] Publish exact API contract early: `choiceArgsSchema` contains stable `idempotency_key`, arbitrary `task`, JSON `state`, nonempty unique `actions:[{id,description}]`, optional caller `timeout_ms`; no fixed task/site/app allowlist or product candidate count limit.
- [x] New gateway `/v1/choices` authenticates new `decide:actions` token scope; operator explicitly authorizes it, old synthetic-only token cannot silently gain general scope. `decide:actions` is a superset for existing fixture endpoint so rollout preserves old calls.
- [x] New source provider calls the fixed official Jev endpoint with typed choice questions; respects caller cancellation/optional deadline, no fixed2second inference deadline; no automatic unbounded retry loop. Track every HTTP attempt with existing UsageLedger and historical price; unknown usage remains explicit.
- [x] Durable choice idempotency keyed by authenticated identity+trusted coordinator caller_scope+idempotency_key. Cached complete results never call upstream again; changed payload conflicts; pending/unknown is not replayed. Signed proof binds full request, caller scope, selected ID and identity; proof is not permission to execute stale UI without host revalidation.
- [x] Metering required in current general deployment; don't create/rewrite capped approvals. Remove gateway60/minute and global4 request caps, keep TLS/protocol/correctness. Choice request lifetime must not be killed by legacy socket2second deadline.
- [x] ServiceProfile adds optional `chooseAction(client,args,signal)` trusted callback; remote profile builds client and verifies proof using configured receipt key/identity/issuer/audience. Ordinary MCP args cannot supply caller_scope/provider/key.
- [x] Fixture protocol and signatures stay backward compatible. Source profile doesn't default new installs into paid service.
- [x] Offline tests: arbitrary real-app descriptions; >64actions; >2s response; duplicate/conflict/unknown; actual HTTP-status/token accounting; signature/caller binding; legacy regression. No hosted calls by agents.

## Task 3 — Network quotas and long-running delivery

Own `src/network/` except protocol tool-definition integration parent may touch; coordinate before shared edits. Own `src/service/ipc.ts` for long business RPC lifetimes.

- [x] Inventory all network count/rate/idle/queue/delivery quotas. Remove 32active/requestqueue,128AI,10000registry/audit caps and local connector4-inflight hard ceiling. Preserve owner scoping, heartbeat fences, cancellation/recovery and manual stop.
- [x] Remove default AI idle expiration. Preserve explicit caller/operator TTL if provided for backward-compatible experiments; null means no default expiry. Expose capability accurately.
- [x] Default queue/result lifetime for run_goal and choose_action is not a fixed5s/70s cap. Caller goal/choice deadlines honored. Durable nullable deadlines represent no product deadline (no fake huge number). Current transport failures still become UNKNOWN, never rerun.
- [x] IPC business calls with omitted caller duration must not be cut off by fixed65seconds; header/invalid input protections remain. Old explicit test timeout options remain honored.
- [x] Remove cumulative storage-record quotas where they gate use, without deleting any audit/history. Keep finite format and payload resource protections, enumerate remaining technical limits.
- [x] TDD coverage for >oldmax sessions/queue, pending >oldtime caps via controlled time, long business IPC, existing disconnect/replay safety.

## Task 4 — Parent integration and runtime

Own `src/service/contracts.ts`, `src/service/coordinator.ts`, `src/service/main.ts`, CLI/MCP mapping, docs/deployment/tests; coordinate core schema extension.

- [x] Add `jev.choose_action` to CLI/localMCP/network tool definitions without making arbitrary task states into fixture fields. Coordinator authenticates owner before and after general request; aborts general requests on revocation/stop, no browser session needed. Use trusted profile callback.
- [x] Add truthful health capability data: unlimited aggregate fixture sessions, optional caller limits, general choice availability. No static active_session_limit1.
- [x] Update tests that enumerate6/8 tools; new general+fixture APIs documented separately. Existing fixtures retain isolated public data, generic real host bridge accepts caller state intentionally.
- [x] Produce restriction inventory marking each product cap removed, missing physical adapters honestly distinguished, technical protections retained with rationale. No blanket claim literally all machine/protocol constraints vanished.
- [x] Run typecheck/lint/default/integration/safety, independent spec/quality review. Run real public choose_action + real host browser interaction and two concurrent fixture sessions, meter actual calls.
- [x] Deploy updated relay and Mac services only after safe drain; preserve old ledgers/UNKNOWN, no process cleanup stop at end. Internal token rotates actions scope using existing operator authority and certificates. Keep no paid limits.
- [x] Update handbook/AGENTS/README/report and push GitHub, verify CI. Preserve the unrelated untracked user document.

## Implementation update

The scope was extended from choice-only host bridging to integrated real-browser and configured MCP-host executors because the deployed service needed direct usable execution. Current public deployment additionally enables synchronous AI admission and private continuation capabilities for short-lived MCP clients. Final evidence is in `docs/reports/2026-11-02-unrestricted-service.md`; the original failed search remains in the report. Completion checks cover the delivered code, not universal website/macOS capabilities.
