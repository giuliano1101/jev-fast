# Live browser comparison implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement and review the isolated units below, with test-driven development and final verification.

**Goal:** Test real Jev calls and browser operations against ordinary Codex computer use and a deterministic auxiliary baseline, measuring reliability as well as latency within the user's USD 3 incremental API budget.

**Architecture:** Keep the shipped P0 engine unchanged unless live evidence identifies a bug. Add a separate synthetic browser challenge harness: three difficulties, real Chromium input, semantic candidates without embedded answers, independent result oracle. Use a durable global request reservation before every paid HTTP attempt. Ordinary computer use uses this Codex session and its browser UI tools; its subscription/token cost is unavailable, not zero.

**Tech Stack:** Existing Node 24, TypeScript, Playwright, node:test; local HTML fixture; native Codex computer-use tools. No additional model key is required for the current-session control.

## Authorization and design freeze

- User authorized USD 3 total incremental API spend, including retries. Use a conservative USD 0.01 reservation per HTTP attempt, at most 300 attempts across all live runs; never refund reservations. Verified official Jev input price USD 0.042/Mtok, output free, bounded 16 KiB request, no long-context header. Actual usage is reported separately from reservations.
- Start with at most two smoke requests (small JSON and compressed request), then calibration separate from evaluation.
- Compare the same visible synthetic tasks and seeds. Difficulty: easy explicit labels, medium confusable labels/multi-step selection, hard layout changes/delayed controls/conditional steps.
- Main comparator: ordinary Codex computer use (without Jev). Direct script is an auxiliary lower bound only. Report architecture asymmetry, browser differences, setup and observation overhead; do not call the ratio pure model speedup.
- Report all started tasks, success, wrong actions, safe refusals, recovered tasks, p50/p95, confidence and API failures. Pre-register confidence threshold 0.9 for execution; keep all low-confidence cases in denominator. Do not tune on evaluation failures.
- Test public/synthetic pages only; no personal accounts, external messages, purchases, or destructive actions are needed. Browser execution is real, content is controlled synthetic, native macOS coverage is not claimed.

## Task 1 — durable budget and local secret reader

Files: `bench/live/access.ts`, `tests/unit/live-access.test.ts`.

- [x] Red tests: invalid key permissions/symlinks reject without exposing contents; repeated budget opens preserve spent reservations; cap checked before network; exclusive owner prevents simultaneous runs.
- [x] Implement `readLocalKey(path): string`, `RequestBudget.open(directory, {maxUsd,maxRequests,expiresAt})`, `reserve(): {request, reservedUsd}`, `close()`. Record no key or body. All writes must complete before caller can send a request.
- [x] `npm run build && node --test dist/tests/unit/live-access.test.js`; review spec then implementation.

## Task 2 — verify real provider contract

Files: `bench/live/smoke.ts`, live artifacts under `artifacts/live/`.

- [x] Use injected key, fixed official endpoint/model, durable reservation transport, bounded overall timeout. Save only typed diagnostics, status, usage, timings and budget; never response secrets/raw headers.
- [x] Verify small and compressed requests before browser evaluation. Any protocol fix gets a failing synthetic regression first.

## Task 3 — graded real-browser challenge

Files: `bench/live/challenge.ts`, `fixtures/challenge.html`, `tests/integration/challenge.test.ts`.

- [x] Red tests demonstrate difficulty-specific targets/decoys, wrong-click accounting, deterministic seeds, delayed/rerendered targets, terminal oracle independent of model selection.
- [x] Implement page with visible instruction and controls only; selection candidates describe actual controls, shuffled positions/opaque IDs, never carry a correct flag. Keep oracle state out of model input.
- [x] Implement bounded real click/fill/select/scroll/wait flow with local target freshness checks and no side-effect replay. Use independent page oracle to score every action.
- [x] Run browser tests for all difficulties and challenge types before paid batches.

## Task 4 — measured comparison and reporting

Files: `bench/live/run.ts`, `bench/live/report.ts`, `artifacts/live/`.

- [x] Red tests for denominators, incomplete tasks, finite metrics, paired-success ratios and per-difficulty summaries.
- [x] Freeze task list/seed/order/time limits before evaluation. Run Jev and scripted samples in alternating order; run current-session computer use on the same task definitions. Record page-initialization-to-terminal time including loading delays, and separate browser/navigation setup where measurable.
- [x] Save raw sanitized rows, audit events, budget reservations, manifest, report. Include failed/aborted runs, not only successful trials.
- [x] Final independent review, typecheck/lint/relevant regressions, archive evidence; report uncertainty and remaining untested surfaces honestly.

No Git repository exists here; do not fabricate commits or create a remote deployment. The optimization bundle remains the pre-live baseline.
