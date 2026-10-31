# Manual admission console implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development, test-driven-development, requesting-code-review and verification-before-completion. One production implementer; parent owns independent integration/docs/report.

**Goal:** Remove user-managed AI/device authentication setup and let the operator see names and manually enable/disable individual connection instances before they execute.

**Architecture:** Add a manual-admission mode beside legacy S14 Bearer mode. AI clients use ordinary stateful Streamable HTTP initialize/clientInfo.name, no Authorization. Connector registers its self-reported device name and receives a fresh random connection handle; no configured network key or OAuth. New handles start disabled. A separate loopback-only operator console lists both types and changes enabled state. Names are unverified labels, not identities; session/connection handles are transport capabilities, not user identity authentication. Existing local operator boundary and TLS remain.

**Scope:** Still one selected active executor per relay, multiple AI connections sharing the bounded core. No server deployment, paid calls, real-app expansion or automatic budget approval. Legacy direct/CLI/stdio/Bearer behavior preserved.

## Frozen behavior

- Manual mode is explicit in configuration/templates and requires no mcpTokenFile/connectorTokenFile/tokenFile. Legacy mode remains selected by explicit Bearer config or existing programmatic token options, so old tests/config remain compatible.
- Stateful MCP assigns random sessionId on initialize, using bounded clientInfo.name as display label; ordinary six wrapped `{request_id,params}` plus two status tools keep their shape. No self-reported identity fields in action args. Pending clients can discover tools and see their own gate state, cannot execute/read other's results. Every new MCP session is a new disabled instance even with same name.
- Connector POST registration likewise creates a distinct disabled device instance, not a name-based takeover. Only one device can be enabled at once. Registration and sync cannot set enabled. Same process reconnect keeps its handle; replacement process requires fresh manual approval. TLS/Host/Origin/body/rate/cap limits remain. Names rendered via textContent/escaping.
- Operator console binds127.0.0.1 and uses existing-style per-launch fragment capability/Host/Origin protection. It is not accessible from public /mcp or /connector routes; remote callers cannot approve themselves. User-managed auth is removed only for device/AI admission, not operator authority. Cloud console access later uses an operator tunnel/provider boundary, not a public unauthenticated admin port.
- Console shows name, type, short instance ID, pending/enabled/disabled/stopping/offline states, first/last seen and manual switches. Connection names are marked self-reported. Disabled state immediately rejects new submissions and queued dispatch. In-flight remote stop is shown as waiting for executor acknowledgment, not instant rollback; completed physical actions cannot be undone. Global Mac stop remains independent of cloud.
- Requests/results are namespaced by actual MCP session instance, never name or caller-selected identity. Same request_id used by A and B is independent; cross-session request_status cannot see another result.
- Every approved AI grant generation derives a distinct trusted local network owner. Internal IPC dispatch uses that owner, never client-a as the final goal owner. Add narrowly scoped connector-only (private client-a IPC) dispatch/revoke methods; normal public tools cannot call them. Core owner isolation denies A's session/goal/status/cancel from B. Revoked owners never become active again; re-enable creates a new owner generation and requires a fresh browser session.
- Disable first fences admission, then persists revocations/rejects queued work. Connector sync delivers allowed owners + revocations before any new job; connector revokes/cancels/drains old owners before acknowledging stop. Claims/replies remain durable and never replayed. Disabled device cancels its active owners. On device switch old AI grants cannot silently move to a new unreviewed device.
- Core revoke stops new calls, aborts owned goals, drains pending opens/observations/closes and closes only owned sessions. Pending open is checked after await against the owner grant; it cannot complete successfully after revoke. Global local kill/UNKNOWN semantics and local ledger schema remain valid.
- Relay restart/session termination/expiry clears approvals for new connections; persisted audits and incomplete revocations are retained and reconciled, not erased. Existing S14 store compatibility must be explicit; either preserve old records in-place with separate manual registry or fail closed with a documented new directory. Never silently reset uncertain requests. New manual session cannot recover another expired session's result by name; reapproval is required.

## Task 1 — Production and focused tests

Files: new `src/network/admission*.ts`, manual transport/console modules; minimal network protocol/server/connector/config/main changes; core engine/coordinator network-owner support; `tests/unit/admission-*.test.ts`.

- [x] Test-first missing/manual gate RED, same-name distinct instances, defaultdisabled, operator-only flips, durable scoped IDs and epoch/revocation behavior.
- [x] Implement manual registry/MCP mode and outbound connector registration/grant/revoke, preserving legacy defaults for existing token options.
- [x] Implement distinct local owners + pending-open/revoke fencing, focused real/fake-port unit tests, no ordinary tool identity injection.
- [x] Implement loopback management UI + read-only names/state and switches. Provide programmatic server/console/connector APIs early for parent acceptance tests.
- [x] Verify targeted tests/build/typecheck/lint; no paid calls or mutations to existing runtime/budgets.

## Task 2 — Independent integration

Parent files: `tests/integration/admission-console.test.ts` and helpers as needed.

- [x] Real HTTPS SDK without Authorization registers named AI; outbound device without token registers; both appear pending in real browser console; beforeapproval zero physical actions.
- [x] Operator enables own device/AI in UI; approved goal succeeds. Same-name impostor staysdisabled and cannot inherit permission.
- [x] A/B with same business request_id do not share records; B cannot access A's session/status/cancel.
- [x] Disable AI while provider held: block new/queued, actual owner CANCELLED/drained, zero further actions, stop acknowledgement reflected; reconnect/newinstance defaultoff, reenable uses new owner.
- [x] Disable device; global local panel stop while cloud disconnected; preserve no-replay/UNKNOWN and old Bearer regression.
- [x] Public self-enable/forged name/control payload and XSS labels rejected/escaped. Console remains local protected boundary.

## Task 3 — Docs/report/publication

- [x] Update onboarding/config/templates to manual admission primary path; mark optional legacy Bearer. Explain no identity verification, handle capabilities, per-instance approvals and asynchronous remote stop.
- [x] Separate spec then code-quality reviews; fix important findings and re-review.
- [x] Run full required suites, privacy scan and archive raw evidence in artifacts/manual-admission. Report exact passing scope and zero paid calls.
- [x] Commit/push to user GitHub, verify exact-head CI; prepare updated source archive for later server deployment.

Release checkpoint: full local392/77/40 and independent reviews passed; publication/CI result tracked by resulting commit and Actions. No live deployment is claimed.
