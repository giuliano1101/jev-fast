# S7 Real Website and Douyin Interaction Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the isolated decision bridge and two-stage review. Parent performs live UI and paid requests; no delegated key access.

**Goal:** Compare ordinary computer use, Jev, and an evidence-driven optimization on genuine everyday website and Douyin navigation tasks, showing every question and all outcomes.

**Architecture:** Keep the S6 synthetic provider and execution engine unchanged. Add a separately authorized, fixed-public-control decision bridge with no raw page/account text. Both methods operate the same local IAB/native Douyin surface through CUA. Record full orchestration wall time and decision time separately; a supervised bridge is not an autonomous production adapter.

**Tech Stack:** Node 24, TypeScript, node:test, existing durable RequestBudget, official Jev HTTP endpoint, CUA AX/DOM tools.

## Frozen task inventory

| ID | Surface | Difficulty | Question | Success signal |
|---|---|---|---|---|
| W1 | wikipedia.org | Easy | Open English Wikipedia from the multilingual home page. | English main page URL and heading. |
| W2 | wikipedia.org | Medium | Set search language to English, search Kyoto, open its article. | English Kyoto article heading and URL. |
| W3 | calculator.net/date-calculator.html | Hard | Calculate 2026-11-01 to 2026-11-15, including the end date. | Result 15 calendar days and matching date inputs. |
| D1 | Douyin creator center | Easy | From content management, open collections. | Collections tab/list visible. |
| D2 | Douyin creator center | Medium | Filter works to published. | Audit filter shows 已发布. |
| D3 | Douyin creator center | Hard | Filter 已发布 + 图文 and sort 最高播放. | Three controls visibly show requested values. |

No post, message, like, follow, delete, export, upload, edit work, or account setting change. Existing unfinished draft is preserved. Native UI observations may be inspected locally; only fixed generic control descriptions and public test values can enter the Jev payload or committed evidence. No account statistics/content/screenshots go to GitHub.

Feasibility amendment: the original timeanddate.com W3 attempt submitted correctly but reached a Just a moment anti-bot page. Keep it as `W3-blocked-site` (one blocked ordinary trial, unpaired). The same question moved to calculator.net before any Jev trial. Ordinary trials are collected first while the bridge is implemented; methods are therefore batched, not randomized/interleaved. Report learning, network and order effects explicitly. D3 ordinary repetition 2 uses sorting before filters after repetition 1 observed empty filter labels during sorting; those labels may be transient page loading, so do not claim a persistent website bug without further evidence.

## Task 1 — public-control contract and bridge

Files: `bench/real/catalog.ts`, `bench/real/decision.ts`, `tests/unit/real-decision.test.ts`.

- [x] Define fixed task IDs/goals and action IDs/descriptions from observed controls; locally bind IDs to fresh AX/DOM targets.
- [x] Red tests use an injected fake transport and assert unknown task/action, extra raw text, duplicate IDs, expired authorization, invalid confidence/choice and oversized response reject without executing UI.
- [x] Implement `decidePublic(input, options)` with explicit public-controls authorization, fixed model/endpoint, redirect error, bounded response/deadline, no retries, request reservation before fetch; return selected ID/confidence/usage/timing. Keep synthetic API contract unchanged.
- [x] CLI takes explicit key file and JSON input, shares original `.runtime/live-budget` cap/expiry, stores sanitized decision events and never prints keys. Reuse secure key reader. Existing 115 reservations stay charged; total stays <=300 / $3.
- [x] Verify `npm run build && node --test dist/tests/unit/real-decision.test.js`, then independent spec and quality review.

## Task 2 — baseline collection

Files: `artifacts/real/tasks.json`, `artifacts/real/all-trials.json`, `artifacts/real/decisions/`.

- [x] Record task definitions, original start/reset states, before-run code hashes, action limits (12 / 300 s), confidence 0.9 and measurement definition before measuring.
- [x] Run each task twice with ordinary computer use and twice with baseline Jev; retain the documented batched order amendment. Reset outside timing. Timing starts before first observation and ends at verified visible target state; include tool/orchestration delay. Record all started trials, failures, refusals and recovery.
- [x] Baseline Jev receives currently visible allowed candidates plus verified completed actions; never use hidden page state. Refresh target before execution, compare current label and only then execute. Parent does not override choices; missing/low-confidence/unsafe choice stops task.

## Task 3 — optimize from evidence and retest

Files: decision bridge/catalog as required; corresponding regression tests; `artifacts/real/optimization.md`.

- [x] Inspect baseline action counts/failed states/round trips first. Document one observed bottleneck and a testable hypothesis; do not lower confidence threshold.
- [x] Red regression for the specific improvement, implement the smallest fix, spec/quality review, then freeze optimized code hash.
- [x] Repeat the same six tasks twice with optimized Jev. Report paired before/after as within-task retest, not held-out generalization; ordinary baseline remains unchanged. If live sites block, record blocker and only then add clearly labeled local everyday-workflow fallback.

## Task 4 — report and delivery

Files: `artifacts/real/report.md`, machine-readable summaries, README, CHANGELOG.

- [x] Show six question cards with start/actions/expected state, all trial outcomes, latency and requests; success-only speed ratios have explicit matched denominators. Report UI orchestration separately from API decision latency, not pure model speed.
- [x] Include all cumulative paid attempts and old unknown request; current Codex session cost unknown. Do not reset/extend budget implicitly.
- [x] Full offline typecheck/lint/unit/integration/safety, validate source hashes, scrub committed output, commit and upload updates to authorized repository; verify GitHub CI.

The dedicated checkout has no unrelated edits; work on `feat/s7-real-interactions` and retain the immutable `v0.1.0-s6` tag. No additional worktree is necessary for this in-place continuation.

Completion note: final six-question twice retest is 8/12, original baseline6/12 and ordinary12/12. First optimized5/12 plus integrated ablation3/8 are retained. Two integration-stage additions were evidence-driven: queue transport and native AX checkbox repair. All rows and limitations appear in report.md.
