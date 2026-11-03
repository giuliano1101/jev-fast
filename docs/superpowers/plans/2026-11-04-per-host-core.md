# Per-host execution core implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for implementation and independent spec/quality reviews. Work in the existing linked worktree; do not create another checkout.

**Goal:** Remove product CLI/MCP and centralized relay/connector services while preserving per-host executors, decision logic, metering, safety and historical evidence.

**Architecture:** Applications import TypeScript libraries and use the owner-private local coordinator. Native Mac/Windows drivers, real browser execution, local browser adapters and Android backend clients remain. MCP client dependencies are retained only to speak to third-party executor backends; this project no longer publishes an MCP server or business CLI.

**Tech Stack:** Node 24, TypeScript, Playwright, Swift, PowerShell, SQLite.

## Task 1: Code and regression coverage

- [x] Add failing tests showing the console uses lifecycle functions without invoking a CLI, and the native executor remains callable without an MCP server.
- [x] Extract the existing start/stop/health/doctor lifecycle from src/cli/index.ts into src/service/lifecycle.ts; preserve profile matching, persisted manual intent, locks and no-replay recovery. Export a local library entry.
- [x] Remove src/cli, src/mcp, src/network, src/mac-public, public-cloud/local stdio entrypoints, desktop stdio server, centralized admission code, deployment templates and setup scripts. Preserve native contracts/driver, local browser service/config, host client adapters, remote model decision gateway, all core and hybrid execution modules.
- [x] Replace control panel CLI subprocess/admission controls with direct lifecycle functions and a single-page per-host UI. Remove network-owner dispatch routes; retain core session safety. Make remaining supervisor use lifecycle directly, or remove only obsolete relay-specific supervisor code while preserving intent/recovery primitives.
- [x] Remove tests specific to removed transports. Migrate meaningful lifecycle, browser and native tests to library execution. Do not delete retained execution/safety tests to conceal regressions.
- [x] Remove obsolete package scripts, CI steps and runnable cross-entry benchmark launchers; preserve historical reports/results and useful benchmark logic where practical.
- [x] Clean removed build output on rebuild so an old dist MCP/CLI cannot remain runnable.

## Task 2: Current documentation and historical evidence

- [x] Rewrite README, AGENTS, current integration/quickstart/control/native/browser docs around per-host imports. Relocate retired service manuals to a clearly labelled archive. Keep historical reports, designs, fixture tasks and lessons, with an archive index explaining old commands are not current support.
- [x] Explain local browser login modes, native OS permissions, Android backend client dependency, postcondition checks, idempotency and UNKNOWN behavior.
- [x] Write a dated removal report with exact retained/removed scope and live-service disposition. Never change keys, private profiles or historical ledgers.

## Task 3: Deployment disposition, verification and GitHub

- [x] Clarify whether the user wants deployed services stopped or source-only removal. Until answered, do not alter running shared services.
- [x] Run npm run typecheck, npm run lint, npm test, npm run test:integration, npm run test:safety and native tests; inspect actual results and independent reviews.
- [x] Commit only tracked source/docs changes and push to GitHub main after checking remote changes. Preserve unrelated untracked files and private runtime evidence.
