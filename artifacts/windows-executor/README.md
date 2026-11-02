# Windows executor acceptance

[Implementation and recovery contract](../../docs/windows-executor.md).

`offline-checks.json` records 28 Windows-specific checks plus four private-storage regressions on upstream revision `56d4cd5e8fc80064aa112b11cf6abe2c2cc0524b`, all passed. A separate actual G-drive SDK recheck passed. Ordinary tests use explicit offline decision fixtures and actual local executors, not hosted Jev.

`live-checks.json` records real `jev-1.14.0` acceptance: 31 primary checks, eight Android checks and seven dual-facade checks passed. Seven facade checks passed again after the upstream merge and Windows DACL fix. Groups can overlap and are not a count of independent business tasks. Initial failures and subsequent fixes remain recorded.

The full service unit/core suite remains failed on Windows (325 passed, 237 failed); supported-platform regression is pending on Mac. Business portals, game semantics and live streaming need target-specific acceptance. Global activation and GitHub publication remain pending.

No private runtime, continuation, logged-in profile, device identifier or raw application screenshot is included here.

[Plan coverage and remaining acceptance](plan-status.md) distinguishes implemented adapters from target-specific acceptance.
