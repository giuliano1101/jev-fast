# Connect the live operator service

> **For agentic workers:** Use superpowers:subagent-driven-development with TDD and independent spec/quality reviews. Parent provisions the private operator setup and performs the actual cutover.

**Goal:** Serve real signed Jev decisions through the already deployed MCP route, preserving all budgets/audits and leaving the service running.

**Architecture:** A local HTTPS decision gateway uses the existing private key and the unspent part of the existing approval. Its transport reserves in the original ledger before every hosted HTTP attempt; its own ledger also caps attempts to the originally unspent amount. The Mac coordinator runs `mode:remote`, `required_jev`; no mock fallback. An operator token rotator renews private certificate-bound one-hour tokens without changing AI-visible tools or restarting the coordinator.

**Tech Stack:** Existing Node24 TypeScript gateway/coordinator/MCP SDK; private OpenSSL certificates and detached operator processes. Main execution scope remains standard synthetic fixtures.

## Task 1: Private token reload

- [x] Add `tokenReload?: boolean` only to trusted remote service profile. Default false preserves existing behavior. Add `tokenLoader?:()=>Promise<string>` only to trusted RemoteDecisionProvider constructor.
- [x] Test changing one private token file from an old valid certificate-bound token to a new valid token updates authenticated health/decisions without restarting provider. Invalid/empty/multiline/unreadable replacements fail closed and never use stale credentials. Existing static token path behaves unchanged.
- [x] Reload before each exchange; preserve the original request deadline including file reads. No request or MCP args can provide loader, paths or provider changes.
- [x] When reload is enabled, config fingerprint binds the path, identity and fixed trust/key material, not replaceable token bytes; otherwise old fingerprint behavior stays unchanged. Test fingerprint stability across token renewal and change on trust/identity/config changes.
- [x] Run focused tests/typecheck/lint, obtain spec then quality approval. Do not edit Engine, budget limits, receipt validation, deadlines or owner rules.

## Task 2: Private provisioning and cutover

- [x] Prepare owner-only persistent TLS/receipt/token material, remote profile and gateway runner under ignored `.runtime/live-service`; never print keys/tokens.
- [x] Use the existing approval expiry/caps and original RequestBudget ledger. Compute remaining allowance before provisioning; reserve in that exact ledger per HTTP attempt, including retries. No reset/renewal of old limits or paid allowance. Record current user instruction as authorization to use the remaining allowance for service decisions.
- [x] Start gateway on loopback, verify authenticated mode=jev/model=jev-1.14.0 without hosted inference. Rotate tokens locally with no provider calls.
- [x] Preserve current coordinator ledger. If a goal is running, wait for terminal state before a one-time profile switch. Stop/start only for this necessary switch; do not stop the resulting service on task cleanup.
- [x] Leave connector and automatic operator AI admission running. Verify doctor shows provider=jev, transport=remote, routeCompatible/remoteReachable/identityMatches true, enforcementMode=required_jev.
- [x] Execute a minimal genuine MCP synthetic goal; inspect signed route=jev and HTTP/accounting evidence. Never silently replay UNKNOWN or failed business IDs.
- [x] Document operational paths and remaining allowance, update GitHub and run required checks. Keep model service processes alive, with failure retaining audits/locks rather than automatic clearing.

Implementation note: launchd failed before Node due to macOS background access to Documents (EX_CONFIG 78); its own failed job was unloaded. Gateway/coordinator/panel use detached processes instead, without changing privacy settings. No reboot persistence claim.
