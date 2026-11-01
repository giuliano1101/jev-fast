# Native Desktop Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Enable native macOS/Windows App operations through Jev without application allowlists or count/cost/goal quotas, prove actual native Mac operations, and publish truthful platform acceptance.

**Architecture:** Add a standalone stdio desktop MCP host using native macOS AX/AppKit/CoreGraphics/ScreenCaptureKit and Windows UIAutomation/Win32. Existing `host_tools/host_act(host=desktop)` integrates it with the shared coordinator, signed real Jev and durable host audit. Native helper is a long-lived JSON-lines process, with grounded observation IDs and real app/PID/window references. Installed-app scope is open; stale targets, ownership, OS permission facts and UNKNOWN remain correctness rules. No dependency on this Codex chat, browser fixtures, external runtime app blocklists or fixed model time limits.

**Tech Stack:** TypeScript Node24 MCP SDK, Swift native macOS helper, PowerShell/.NET Windows helper, existing usage-only Jev host bridge, offline fixture drivers plus Mac native acceptance.


**Scope update (latest user instruction, overrides original deployment checklist):** Keep the original private profile, Key and ledgers unchanged; do not restart relay, switch devices or clean up Windows connections 64d7b3b2 / b4dbbc71. Windows installs/verifies its own native executor. Accordingly, no shared desktop host enrollment or coordinator/connector upgrade was performed. Actual Mac acceptance used standalone native MCP + an independent HostService calling the existing real Jev coordinator; public MCP still exposes the configured android host. Only Nginx body-size configuration was hot-reloaded. TLS keep-alive and optional longer device heartbeat are prepared code, awaiting a permitted maintenance window. Old Windows request was queried read-only, never replayed. Do not execute the superseded deployment steps below without a newer user instruction.

### Task 1: Native contract and MCP facade

Files: `src/desktop/{contracts,driver,main}.ts`, `scripts/build-desktop.mjs`, tests/unit/desktop*.test.ts.

- [x] RED/GREEN tool contract tests: arbitrary app names/paths, zero whitelist, schema grounding and candidate duplicates; require observation_id with element_id/coordinates. Native request shape `{id,method,params}`, response `{id,ok,result}` or `{id,ok:false,error:{code}}`.
- [x] Tool catalog: desktop_status, desktop_list_apps, desktop_launch_app, desktop_open_document, desktop_get_state, desktop_screenshot, desktop_activate_app, desktop_click, desktop_type_text, desktop_press_key, desktop_set_value, desktop_scroll, desktop_drag, desktop_perform_action. Use latest actual schema for platform-neutral arguments.
- [x] Separate actual OS choice from injectable private native executable for offline tests; fixed trusted CLI options, never ordinary tool parameters. Serialize native commands and retain in-flight input slot after caller uncertainty, no automatic input replay.
- [x] MCP facade turns optional native result.image `{data,mimeType}` into MCP image content, returns JSON state text separately, supports operator CLI `--call` for diagnostics. No arbitrary script/shell RPC. Native launch accepts any installed app, not a project allowlist.
- [x] Native compile is explicit `npm run desktop:build` (Swift cache in temp), not hidden in ordinary tests. Copy Windows helper to dist via build script and version fixed native protocol. Fake-driver tests exercise actual stdio MCP and arbitrary apps without OS input/paid calls.

### Task 2: Native macOS implementation

Files: `native/desktop-macos.swift`, meaningful native helper tests/probes.

- [x] Read real permission status, list apps, resolve bundle/name/absolute app path/PID; launch or activate via AppKit; open user-specified local document with selected app.
- [x] Return AX application/window/control data with observation_id and element_id; retain actual AX handles, no fixed element/depth count. Traverse with cycle detection, not arbitrary node clipping. Before actions verify PID/element identity/current label/role/value/geometry as applicable. Observing another app/session does not silently redirect an input.
- [x] Implement native AX press/set-value/secondary action plus pointer/key/Unicode/scroll/drag fallback using current app/window coordinate mapping and actual foreground checks. No environment gates or application blacklist.
- [x] ScreenCaptureKit PNG has explicit origin/scale/window mapping; do not guess Retina coordinates. Screenshot permission failure is honest OS error, not silently substituted fake pixels.
- [x] Compile and permission/status probes only by worker; parent owns live UI operations and model calls. Parent tests real Calculator and own temporary TextEdit document; do not modify existing user documents.

### Task 3: Windows backend and host revocation

Files: `native/desktop-windows.ps1`, platform selection tests, `src/host/service.ts` and tests.

- [x] Implement matching JSON-lines API via Windows UIAutomation/Win32, real windows and element refs, screenshot mapping, input/drag/scroll/text, launch/open/activate. No app blacklist. Report lack of interactive desktop/OS privilege honestly.
- [x] Mark platform test coverage accurately: this Mac cannot establish physical Windows acceptance. Add Windows-native CI probe where feasible, never label mocks as real Windows input.
- [x] Regression: revoking owner A while physical host call is in flight must not ACK drain before that call settles; pending/decision-only work is fenced immediately; owner B may continue later, no replay of A UNKNOWN. New physical helper lifetime drains or kills its own backend before claiming shutdown.

### Task 4: Review, real proof, deploy and publish

Files: private operator desktop host config/profile, docs/{native-desktop,other-ai-real-testing,quickstart-agent}.md, README, AGENTS and report/artifacts.

- [x] Independent spec review then quality review. Run typecheck/lint/unit/integration/safety/deploy checks, ordinary tests never call hosted model.
- [x] Preserve current remote Jev, usage-only allowance, profile, Key and historic audit. Original desktop enrollment / process upgrade step is SUPERSEDED by the latest user no-restart instruction; do not perform it. Standalone native MCP is available locally; shared public profile remains android.
- [x] Existing local real Jev coordinator, through independent HostService/native MCP, chooses Calculator clicks and own TextEdit typing/save; verify actual AX result and saved file via independent read. Record attempts/failures/actual tokens, avoid publishing raw screen/account data. Never touch passwords or user documents in acceptance.
- [x] Preserve the one-page console, and update docs with actual standalone desktop tool discovery and clear Mac/Windows setup. No new application/fee/count gates; keep user's manual off and idempotency/UNKNOWN intact.
- [x] Push code/report/manuals to authorized GitHub main and verify CI; leave service running. Preserve untracked `docs/other-ai-real-testing 2.md`.
