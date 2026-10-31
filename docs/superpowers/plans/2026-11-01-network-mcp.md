# Network MCP and outbound connector implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development, test-driven-development, requesting-code-review and verification-before-completion. This is one bounded network subsystem; parent owns independent acceptance tests/docs/report.

**Goal:** Provide an authenticated HTTPS MCP endpoint forwarding bounded synthetic tasks through an outbound Mac connector, with durable at-most-once dispatch, queryable recovery, and the existing local service switch remaining authoritative.

**Architecture:** Cloud relay owns only network request bookkeeping and the MCP transport. A Mac connector makes outbound HTTPS sync/poll requests and calls existing private Unix IPC as client a. No inbound Mac port, no remote shell, no service-start/stop tools, no new provider, paid authorization or real-app adapter. Single configured device/agent pair per relay in this MVP; separate deployments/profiles for other devices.

**Tech stack:** Existing MCP SDK1.32.2 StreamableHTTPServerTransport in stateless JSON response mode, Node HTTPS, Node SQLite durable private stores, Zod strict schemas, Node tests and real isolated Playwright BrowserAdapter.

## Frozen interface and safety contract

- HTTPS only for both network roles. Server TLS key/cert and connector trusted CA (or system CA) are private-file configured; never disable certificate/hostname validation or follow redirects with credentials. Config supplied only via explicit --config FILE.
- Server has fixed device_id and agent_id. Distinct random >=32-byte Bearer credentials for MCP and connector loaded from0600 files, with expiry; never forwarded to local IPC or model. Roles cannot call each other's routes. Exact configured public Origin/Host and an Origin allowlist; absent Origin accepted for nonbrowser authenticated clients, invalid present Origin rejected. No CORS wildcard, public unauthenticated health contains no device/credential data. Do not claim complete OAuth2.1/login interoperability: initial private provisioning is for hosts supporting explicit Bearer headers; OAuth-host compatibility is a separate deployment concern.
- Network MCP offers the six existing `jev.*` operations using explicit wrapper `{request_id, params}`. Request_id is a stable1–100 identifier supplied by the caller, independent of JSON-RPC IDs/session reconnect. Params use existing strict core schemas and normalized defaults. Reject noncanonical provided synthetic values before durable storage. Local stdio/CLI contracts stay unchanged.
- Two additional read-only network tools: `jev.network_status {}` and `jev.request_status {request_id}`. Result is `{request_id, delivery_status, reply?}`. COMPLETED means delivery of an authoritative local reply, not necessarily GoalStatus SUCCEEDED; local error and UNKNOWN remain visible.
- Same request_id + same normalized method/params returns the same persisted record without re-dispatch; changed method/params is conflict. New transport/session must not change business IDs. run_goal still also preserves its goal_id and idempotency_key. No body, token, URL, selector, JS, identity/provider/operator settings outside these schemas.
- Submission is rejected when connector offline or local service not ready. No offline backlog to execute silently on reconnect. Short bounded QUEUED records bind the observed local coordinator instance; connector preflights that instance again before any action. Service restart rotates the instance, preventing stale accepted work from crossing local off/on.
- Relay durably changes QUEUED to DISPATCHED before returning a delivery. Delivery contains an unpredictable nonce, fixed device binding, request_id, normalized params, expiry and local instance. Never redeliver DISPATCHED/UNKNOWN. Missing receipt is uncertainty, not permission to repeat. On relay restart old queued requests expire/reject and dispatched requests become network UNKNOWN.
- Connector durably records the delivery and claim before IPC. It records the authoritative reply before uploading it. On reconnection/restart it retries uploading the exact persisted reply until acknowledgment; duplicate result is idempotent, conflicting/forged/wrong-nonce receipt rejected. A claim without recorded completion on connector restart yields network UNKNOWN and is never replayed. Late authoritative result may resolve transport UNKNOWN, without repeating the action.
- Heartbeat/sync continues during IPC goals; poll/execution concurrency and queue sizes bounded. Control/status/cancel can reach local core while a goal runs. Multiple connector processes for one profile must be fenced/denied; ownership/epoch and journals bind fixed profile. Fail closed on corrupt/mismatched/insecure stores. Never erase audit to restart.
- Add internal authenticated `service.local_health` reporting only ready and per-coordinator random instance_id; no provider/model network health call. It is not a public MCP action and does not allow operator control. Connector reads fresh private client credential for preflight/dispatch. Stop kills/cancels/drains via existing coordinator; connector must never auto-start service or retain a dispatch credential across off/on.
- Internet interruption does not itself cancel an already accepted bounded local goal. It can finish and save a reply; reconnect only reconciles. Local stop works without cloud connectivity. Network UNKNOWN and core goal UNKNOWN are distinct. No exactly-once physical-execution claim across arbitrary failures.
- Keep request/response bodies <=64KiB, bounded body read deadline cleared before long work, fixed total network/call deadlines, no secrets in stdout/errors, bounded records and network connections. Include authenticated wrong-role/expiry/corrupt-state/oversize/conflict/duplicate tests.

## Task 1: Core transport, stores and connector

Files: new `src/network/{protocol,store,server,connector,config,main}.ts` as needed; minimal `src/service/coordinator.ts` local_health branch; `tests/unit/network-*.test.ts`; package.json scripts `network:server`, `network:connector`.

- [x] Write failing tests for missing exports, normalized wrapper/idempotency conflict, durable dispatch before delivery, no redelivery across restart, exact result reupload, and local-instance fencing. Observe RED before implementation.
- [x] Implement private durable stores, protocol and relay; use real SDK stateless HTTP handling, not a JSON endpoint merely labelled MCP. Example server tools registration uses `ListToolsRequestSchema`, `CallToolRequestSchema`, `StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true})`.
- [x] Implement outbound connector/config/process flags; constructor/open APIs documented for parent acceptance tests. CLI command accepts only --config FILE and --help; --help/import do not read secrets, open listeners or start services.
- [x] Add minimal local_health with per-instance UUID: authenticated normal client/operator may read; response has only ready/instance_id. Existing service.health remains unchanged.
- [x] Green targeted tests, build/typecheck/lint; communicate exact APIs/fixture configuration. Never run hosted calls or alter existing .runtime budgets.

## Task 2: Independent actual network acceptance

Files: `tests/helpers/network-fixture.ts`, `tests/integration/network-mcp.test.ts`, `tests/integration/network-recovery.test.ts`, parent-owned.

- [x] Use trusted selfsigned TLS helper and actual SDK StreamableHTTPClientTransport against real HTTPS; connect real connector and coordinator/BrowserAdapter. Prove initialize/tools/list, open/goal/status/close, local stdio and CLI compatible.
- [x] Cut client response after goal accepted; recover with original request_id and request_status, assert same durable goal/actions count and no duplicate physical actions.
- [x] Cut connector network during execution/result upload; resume and reconcile exact persisted result, not IPC repeat. Restart relay with same private store and port; old deliveries never handed twice.
- [x] Test local off before submission, off while active with cloud disconnected, on with rotated coordinator epoch, stale queued work rejection, fresh task success after reconnect. Use actual panel /api/stop and /api/start for at least one path, validate final browser/ledger outcomes.
- [x] Deterministic uncertain physical-action fault retains core UNKNOWN/quarantine and does not replay through new network request. Connector claimed-without-result restart is separately network UNKNOWN.
- [x] Test wrong-role/token/origin/body/expiry, offline device, duplicate/conflicting IDs, and import/help no side effects. All disposable runtimes and offline mock decisions.

## Task 3: Review, documentation and publication

Files: `docs/network-mcp.md`, `docs/server-deployment.md`, README/AGENTS/quickstart/control-panel docs, CHANGELOG, `artifacts/network-mcp/{report.md,verification/*}`.

- [x] Independent spec review then separate code-quality review. Fix important issues and re-review.
- [x] Document private single-device Bearer provisioning, HTTPS/MCP client configuration, wrapper versus local argument shape, all delivery/goal states, exact restart/operator procedures, panel override, limitations and untested production/OAuth/second-machine cases.
- [x] Provide concrete deployment package/instructions/config templates containing no secrets. Server prerequisites: existing Linux host with Node24.19+/persistent disk/TLS443/domain/cert, allowed outbound MacHTTPS; target AI authentication compatibility. No server purchase/deployment before actual resources are provided.
- [x] Run complete typecheck/lint/unit/integration/safety; record counts and raw evidence with source hashes/privacy scan, zero paid calls. Commit/push to user repository and verify exact-head GitHub CI.

Release checkpoint: full local376/71/40 checks and both reviews passed. Publication/CI result is tracked by the resulting Git commit and Actions run; no public deployment is claimed.
