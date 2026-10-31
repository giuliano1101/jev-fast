# Local service control panel implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for implementation and separate spec/code reviews. Use test-driven-development and verification-before-completion.

**Goal:** Let the operator start/stop the existing coordinator in a local Chinese web UI and make the actual agent integration boundary easy to discover.

**Architecture:** An explicit loopback-only control process delegates a fixed set of operations to the existing CLI using process.execPath and argv (no shell). Runtime and optional private service profile are fixed at startup. The browser never receives operator credentials. Token-authenticated same-origin API, exact Host/Origin validation and no CORS protect changes. Panel startup never starts coordinator or paid goals. Closing panel leaves service unchanged; stopping service uses existing kill/cancel/drain behavior.

**Tech stack:** Node HTTP, TypeScript, embedded HTML/CSS/JS, existing CLI, Node test runner and Playwright.

### Task 1: Implement control process and UI
- [x] Add failing tests in tests/unit/control-panel.test.ts for authenticated status, start/stop, forbidden requests, fixed CLI args and command failure/timeout behavior.
- [x] Add src/control/server.ts (server, API boundary, fixed CLI adapter), src/control/ui.ts (Chinese accessible UI) and src/control/main.ts (startup flags/help, safe URL output, shutdown).
- [x] API accepts only status/start/stop, no arbitrary args/config/provider/key/body. Loopback bind, exact Host+Origin, random session token provided through URL fragment and sent in header, no cookie/CORS, no-store/CSP/referrer policy. Mutations serialized, errors redacted, subprocess bounded.
- [x] UI shows observed running/unavailable/blocked states accurately, mock versus remote, remote reachability/scope, runtime and errors. Buttons reflect pending operations. Start never silently selects a different profile. Status failure must not falsely claim stopped. Stop must work even if an ordinary status probe is slow. No automatic goals/demos or paid API calls.
- [x] Add npm run control, confirm red then green, typecheck/lint.

### Task 2: Document AI onboarding and operator use
- [x] Create docs/quickstart-agent.md with portable install/build/start/doctor/schema/MCP setup, fixed tool scope and result/retry semantics, no machine-specific node path as default.
- [x] Add a discoverable AGENTS.md linking guide and stating fixture-only scope, default mock, required private operator provisioning for hosted mode, no bypass or automatic payment authorization.
- [x] Create docs/control-panel.md with launch/stop commands, switch semantics, private profile behavior, panel lifecycle versus coordinator lifecycle, and security/diagnostic limitations.
- [x] Update README/CHANGELOG and fix outdated mock-only claim in docs/mcp.md. Include no secrets or host-private paths in committed examples.

### Task 3: Verify, review and publish
- [x] Add real-loopback browser test: status while stopped, start mock, CLI/MCP health, stop, service no longer reachable, page error handling; all disposable runtime and no paid API.
- [x] Independent spec review followed by code review; fix findings and recheck.
- [x] Run typecheck/lint/unit/integration/safety. Record results and limitations in artifacts/control-panel/report.md.
- [x] Release operation: commit/push following existing authorized repository workflow; verify CI. Open an operator panel on this machine, with coordinator initially off. The release outcome is recorded in Git history/CI and the final task delivery, rather than predicted in this pre-release plan.

Release note: feature commit uploaded and operator panel opened with coordinator off. Initial CI cancelled before all steps by macOS14 brownout; workflow migrated to macOS15. Current run status is tracked in GitHub Actions.
