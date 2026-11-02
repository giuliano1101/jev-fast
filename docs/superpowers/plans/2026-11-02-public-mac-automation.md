# Public Mac Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Follow TDD and independent spec then quality review.

**Goal:** Enable the existing public MCP to operate the daily Chrome and native Mac GUI, preserving original remote Jev, Android, admission, sessions and usage-only metering.

**Architecture:** Add an HTTP compatibility front and a loopback Mac sidecar reached over a separate reverse SSH tunnel. Forward legacy MCP transports unchanged to the running relay; route host=mac (desktop alias) to the sidecar. Native operations use existing HostService and native stdio executor; real choices use original coordinator IPC. End-user continuation is checked against the original relay before choice and physical input. No shared process restarts.

**Tech Stack:** TypeScript, Node24, SDK Streamable HTTP, private SQLite audit, existing HostService, native desktop, nginx graceful reload, launchd/systemd.

### Task 1: Tested bridge and compatibility front
Files: new src/mac-public/{contracts,store,http,auth,sidecar,front,main}.ts and tests/unit/mac-public*.test.ts, tests/integration/mac-public*.test.ts; avoid unrelated changes.
- [x] Write failing tests for same-owner dedupe, conflict, unknown restart and lost submit recovery without replay.
- [x] Implement private durable async jobs, canonical owner scoping, single physical Mac queue, host mac/desktop aliases, real IPC choice callback and original relay admission validation.
- [x] Implement raw legacy HTTP forwarding, intercept mac host_tools/act, request_status and enrich network_status/tool descriptions. Retain existing session IDs and continuation identity. Reject colliding legacy/mac request IDs. No added count/time budgets; diagnostics bounded independently of business work.
- [x] Lift native screenshots into MCP image blocks without duplicate base64. Preserve metadata and unknown semantics.
- [x] Tests cover off/revoke while choosing and queued, cross-owner isolation, DELETE/reconnect continuation, legacy passthrough, Android, screenshots and no default paid cap.
- [x] Fresh spec review then code quality review; fix findings.

### Task 2: Additive deployment and real acceptance
Files: new deployment templates/scripts and private runtime files outside Git. Original shared profiles/ledgers untouched.
- [x] Build and run all five project checks plus focused bridge tests; tests contain no hosted calls.
- [x] Start Mac bridge as own launchd job, reuse original native binary identity and IPC; new reverse tunnel only. Start VPS front as separate private systemd job. Existing processes remain running.
- [x] Private front smoke tests, then nginx -t and graceful route reload for same /mcp. Keep /connector and relay running; disable upstream replay.
- [x] Through actual public MCP verify original session continuity and Android, daily Chrome same running PID/new owned tab, native screenshot, TextEdit owned document edit/save and independent file readback. Record real Jev provider and actual usage; close only owned contexts.
- [x] Document exact Cursor connection, schemas, how to observe/input with host mac, actual scope/risk, rollback and operational checks. Publish code/report after review, with delivery recorded in repository history.
