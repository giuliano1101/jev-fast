# Local Browser and Service Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Let Windows agents use real Jev with a browser executing locally on Windows (visible launch, existing Chrome/Edge CDP, or extension), and automatically recover the shared service without overriding deliberate operator off.

**Architecture:** A separate local stdio MCP owns a local official Playwright MCP backend and reuses HostService's durable action journal/order. Only choose_action goes to the existing public Jev MCP; browser tools never call Mac browser_open. Backend discovery/observations stay local. Public continuation is cached privately; uncertain requests are queried by original ID and never replayed. The original coordinator gains explicit operator running/stopped intent. A watchdog recovers dead owned processes/locks, preserves ledgers and original profile, and respects stopped intent. Connector registration persists a private resume handle so restarts retain the operator's device-off intent; relay never restores AI owners by name.

**Tech:** Node24/TypeScript, existing MCP SDK/HostService, pinned official @playwright/mcp, launchd on Mac and systemd relay recovery, local Playwright/Windows CI.

## Task 1: Local browser MCP (separate implementer)

Files: src/local/{cloud,browser,main}.ts, scripts/setup-local-browser.mjs, tests/unit/local-browser*.test.ts, tests/integration/local-browser*.test.ts, .github/workflows/local-browser-windows.yml.

- [ ] RED/GREEN cloud choice tests: no remote browser/host calls, automatic private continuation, original request polling, no uncertain resubmission, off/invalid owner fails closed without creating another identity.
- [ ] Local tools local_status/local_tools/local_observe/local_act. Status clearly identifies actual local platform/browser mode. Observe permits actual read-only backend observation; acts reuse HostService and require stable idempotency keys. Caller controls observations/descriptions, arguments stay local.
- [ ] Launch mode visible by default, Windows auto chooses installed Edge/Chrome. Attach maps to local Chrome/Edge CDP by channel or explicit local endpoint, extension mode uses official installed extension. No fixture/app allowlist, no cloud-model key/profile required, no silent fallback to remote Mac/headless.
- [ ] Close only owned MCP process/context, preserve existing borrowed user browser in attach/extension mode; verify in actual local CDP fixture.
- [ ] Setup command prints absolute MCP configuration for the actual machine, no Mac paths or execution policy bypass on Windows. Pin dependencies. Offline tests/CI never call hosted model.
- [ ] Windows CI proves browser executes on Windows; physical user's Windows/profile acceptance is distinguished from hosted runner.

## Task 2: Device registration recovery (root)

Files: src/network/{admission,manual-server,manual-connector}.ts, private registration store, corresponding tests.

- [ ] RED/GREEN persisted resume handle scoped to exact URL/binding/runtime. Mode0600, atomic updates, no token printing. Backwards-compatible optional resume_handle at register.
- [ ] Relay resumes only the exact device registration on possession of its opaque handle, never AI IDs. Preserve desiredEnabled/manual off across connector or relay restart, drain old owner revocations before readiness. No new identity on invalid resume; no audit/key reset.
- [ ] Test connector restart, relay restart, manual device off stays off, stale local instance invalidates old AI, old request never replays.

## Task 3: Always-on recovery that respects off (root)

Files: src/service/{intent,recovery,supervisor}.ts, CLI lifecycle hooks, tests; optional daemon registration scripts.

- [ ] RED/GREEN durable running/stopped intent: explicit stop records off before RPC; explicit start records on; watchdog never overrides off. Private profile remains selected and never falls back to mock.
- [ ] Recover only proven-dead owned process markers/socket/credentials, identity-check paths/inodes and PID death. Keep all ledgers/counters and UNKNOWN. Reuse existing Ledger stale-lock behavior and verify Audit lock recovery.
- [ ] Supervisor restarts dead coordinator/connector/gateway/panel/admin tunnel using fixed private operator configuration, no healthy-process restarts or arbitrary public commands. launchd owns watchdog, systemd relay on-failure restart; manual systemctl stop remains respected.
- [ ] Failure-injection tests run on isolated local fixture services; do not kill the shared live service for a test. Provision original private config without exposing it in Git.

## Task 4: Reviews, live proof and delivery

- [ ] Independent spec then quality review; fix findings. Run required typecheck/lint/unit/integration/safety plus Windows browser CI.
- [ ] Verify current shared readiness first, deploy only necessary tested recovery updates in one drained maintenance, preserve original keys/usage-only/ledgers/android. Persist current device handle privately under operator authorization before first upgraded connector restart.
- [ ] Real Jev local-browser acceptance executes in this Mac's visible browser, independent effect verified; Windows hosted runner tests local Windows execution; Windows physical machine still requires its own installed local MCP, not a Mac test substitute.
- [ ] Install self-recovery through launchd/systemd without overriding manual off. Validate original service healthy, no global/device-off experiment on shared users.
- [ ] Docs give exact Windows one-command setup + MCP local tool examples and explicit distinction from public Mac browser tools. Publish report/evidence/code to GitHub and verify CI. Preserve user docs/other-ai-real-testing 2.md.
