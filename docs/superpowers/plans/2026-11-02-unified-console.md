# Unified Jev Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Give the operator one compact local page for service lifecycle, AI/device admission, history, and connection instructions.

**Architecture:** The existing loopback control panel becomes the single normal UI. A private server-side adapter talks to the existing relay admission API over the operator's loopback tunnel, reads its rotating token from a private file, and projects connection metadata without exposing relay capabilities. Relay/executor services and their policies remain running and unchanged. Existing admission HTML remains a backend/legacy diagnostic, with original Mac shortcuts opening the unified page.

**Tech Stack:** TypeScript/Node24 HTTP, vanilla accessible HTML/CSS/JS, existing CLI lifecycle, Zod private config, Playwright offline browser integration.

### Task 1: Private admission adapter and unified routes

Files: create `src/control/admission.ts`, `tests/unit/control-admission.test.ts`; modify `src/control/server.ts`, `src/control/main.ts`.

- [x] RED: exercise an actual loopback admission server with private configuration. `const adapter=await loadAdmissionAdapter(file); assert.equal((await adapter.list()).connections[0].name,'Our AI');` must initially fail because API does not exist.
- [x] Accept private `{url,tokenFile,publicMcpUrl?}` only from `--admission-config FILE`; require HTTP literal 127.0.0.1 origin and absolute private token path. Use `readPrivateJson/readPrivateFile`, read token each call, fixed POST `/api/status` and `/api/admission`, exact upstream Origin, never follow redirects or accept browser-supplied endpoint/path/token.
- [x] Export `AdmissionConnection` public projection (`id,type,name,state,enabled,generation,firstSeen,lastSeen,desiredEnabled?`), `AdmissionAdapter.list():Promise<{connections:AdmissionConnection[];publicMcpUrl?:string}>`, `setEnabled(id,enabled):Promise<AdmissionConnection>`. Filter out owner, grant and local-instance fields. Sanitize errors; bound malformed responses and network waiting, without adding execution quotas.
- [x] Add authenticated `POST /api/connections` and `POST /api/admission` to control panel. Preserve exact Host/Origin/capability checks; only admission body is strict JSON `{id,enabled}`. Serialize all mutations, keep reads independent. Return `{configured:false,connections:[]}` when no adapter; configured upstream failure is 503, not empty success. Never execute admission on GET or closing panel.
- [x] GREEN: real loopback tests verify private token rotation, no capability leakage, redirect/unsafe config rejection, CSRF rejection and exact forwarded mutation. Existing lifecycle tests remain green.

### Task 2: One-page interface

Files: replace `src/control/ui.ts`; add `tests/integration/control-console.test.ts`; adjust existing UI assertions only for intentional new copy.

- [x] RED actual Chromium test: page has `h1=Jev 控制台`, service controls and connection rows in the same document; 150 offline rows remain collapsed, search/filter finds active names, name HTML is text, per-row off calls only admission endpoint.
- [x] Implement compact light neutral layout with one green accent. Top header + service status/start/stop/refresh; live connection table with AI/device type, actual state, last seen and per-instance enable/disable button; search and type filters; collapsed offline history and connection instructions. No page navigation or second iframe.
- [x] Browser API contracts: `/api/status` unchanged; `/api/connections` returns `{configured,connections,publicMcpUrl?}`; `/api/admission` accepts `{id,enabled}` and returns `{connection}`. Shared local `x-jev-control-token`, JSON request body only for admission. Never use relay operator token in JS.
- [x] Keep old service DOM ids status/mode/reachability/start/stop/refresh/error/activity and existing MCP/CLI labels. Details can be collapsed; tests opening details before asserting visible text are intentional.
- [x] Poll connections without replacing unchanged rows, preserve focus/search/history state, do not overlap reads or let stale replies undo mutations. Show unavailable/error truthfully and retry on next refresh. UI updates through textContent, no interpolation of untrusted names into HTML.
- [x] GREEN browser checks: exact intended mutation, subsequent actual stopping state, offline/history search, failed upstream stays an error, mobile390 fits without horizontal overflow, no browser errors, polling preserves focused button.

### Task 3: Integration, deployment and review

Files: docs/control-panel.md, docs/manual-admission.md, README.md, original Mac private panel startup and shortcuts.

- [x] Parent verifies specification then independent code quality review. Fix important findings before deployment.
- [x] Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration`, `npm run test:safety`; no hosted calls.
- [x] Provision private admission-config using existing loopback tunnel/token. Refresh only control panel process, retain coordinator/gateway/connector and original profile/ledger. Both private panel/admission shortcuts point to unified page. Finder launcher reuses provisioned local shortcut where present.
- [x] Open unified page in original Chrome, verify actual remote Jev ready and real connection list. Test service off/admission mutations only on isolated offline fixtures, not shared production owners. Capture sanitized offline visual if needed, no credentials or names in public screenshot.
- [x] Update user/operator docs to one-page entry, preserve manual-off and UNKNOWN behavior. Commit/push to authorized GitHub and verify CI; leave service running. Preserve untracked `docs/other-ai-real-testing 2.md`.
