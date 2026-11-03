# Windows official Jev UI executor

Source snapshot of the Windows installation validated on 2026-11-04. It uses the official TypeSafe SDK, a persistent local decision loop, independent Chrome/Playwright and Codex IAB adapters, and a Windows-native Jev-Desktop broker/worker. It does not register or use an MCP server.

This directory is separate from the repository's historical Mac relay and MCP implementations. It is currently a machine-specific integration, not a standalone portable installer: the installed root is `G:/Codex/Jev control`, the official SDK/DPAPI credential runtime is `C:/Users/Admin/.codex/jev-direct`, and the global entry is `C:/Users/Admin/.codex/jev-direct/ui.mjs`. Review those paths before installing elsewhere.

## Dependency and layout

Keep `jev-direct-setup` and `desktop-executor` as siblings in the installation root. The browser adapter currently imports Playwright 1.61.1 from the sibling `jev-fast/node_modules/playwright`. The official runtime uses `@typesafe-ai/sdk` 0.7.0 and undici 8.12.3. Keys are read from the existing Windows-user DPAPI credential and never passed to Python.

The native backend is [jacks3tr/Jev-Desktop](https://github.com/jacks3tr/Jev-Desktop) pinned at `483bdf71f293588962326f91dd04096e5f2822f6` (MIT). Clone that upstream project into the `desktop-executor` directory, then overlay the two Python bridge files included here. Create a Python 3.12 virtual environment there and install `comtypes==1.4.17`, `httpx==0.28.1`, `mss==10.2.0`, `rapidocr-onnxruntime==1.4.4`, Pillow and NumPy. MCP package/transport installation is not used. See `UPSTREAM-LICENSE.txt`.

The global installer requires the existing official direct runtime and the installation-root source files; it writes only the UI entry, a scoped skill, an install receipt and the `JEV_UI_EXECUTOR_V1` global instruction block. It backs up the prior global instructions on first installation. It does not modify Codex's primary model or the API key.

## Entry points

`node C:/Users/Admin/.codex/jev-direct/ui.mjs status` reports installed capabilities without a model request. `start RUN.json` requires a live task authorization and reuses healthy services. `desktop RUN_DIR PLAN.json` and `chrome RUN_DIR PLAN.json` execute bounded plans. The IAB adapter is loaded through Codex's documented CUA runtime and uses a local file channel for decisions, so credentials remain in the SDK process.

The authorization document uses `authorization.status`, `expires_at`, `max_requests`, and `max_cost_usd`. The existing usage ledger is cumulative and must never be reset to resume. Each request reserves cost before the call. API retries are disabled. Each UI operation has a persistent identity and single execution claim; unknown outcomes require observation before any recovery.

## Validated scope

Steam: three game searches and screenshots in 18.477 seconds, plus a separate click/focus test through the installed global entry. Chrome: three preview photos saved in 1.503 seconds. IAB: three matching photos eventually saved through observed-source recovery after native media download timed out. All six images decoded and their cross-browser hashes matched. OCR verified the three Steam screenshots; Jev Box located the store search field. Automatic visual-coordinate clicking is not enabled.

Read `LIVE-TEST-20261104.md` for failures, timing boundaries and budget accounting. Do not interpret the saved-media segment as whole-browser wall time. The IAB native media download remains a known failing path. General self-drawn apps, dragging, scrolling and arbitrary multi-app flows have not been accepted.

No credentials, browser profiles, user account content, raw screenshots, local capability addresses or runtime ledgers are committed here.
