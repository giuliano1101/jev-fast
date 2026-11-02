# Windows executor acceptance

[Implementation and recovery contract](../../docs/windows-executor.md).

`offline-checks.json` records 28 Windows-specific checks plus four private-storage regressions on upstream revision `56d4cd5e8fc80064aa112b11cf6abe2c2cc0524b`, all passed. A separate actual G-drive SDK recheck passed. Ordinary tests use explicit offline decision fixtures and actual local executors, not hosted Jev.

`live-checks.json` records real `jev-1.14.0` acceptance: 31 primary checks, eight Android checks and seven dual-facade checks passed. Seven facade checks passed again after the upstream merge and Windows DACL fix. Groups can overlap and are not a count of independent business tasks. Initial failures and subsequent fixes remain recorded.

`local-retest-20261102.json` records the later Windows rerun: 32 local/private-storage checks, the final CDP recheck, 28 real primary checks and seven real dual-facade checks. The corrected CDP fixture has managed startup, explicit cookie verification and registered failure/abort cleanup. Source delivery uses canonical LF. Synthetic browser and desktop screenshots were also inspected privately.

The first Mac return (`fe712aa`, tested candidate `952b7c7`) passed typecheck/lint, 560 unit checks, 40 safety checks, 16 deployment checks and seven native protocol checks. Integration had 122 passed, three skipped and one CDP fixture timeout; the result was received and archived, not accepted as a full pass. Corrected-source Mac/Windows CI is the next gate.

The full Mac service is not ported to Windows: its Windows unit/core rerun remains 325 passed / 237 failed. Ordinary integration/safety runs also failed and left test handles open; those owned test processes were stopped and their incomplete status retained. A separate forced-exit safety diagnostic was 14 passed / 26 failed. Deployment tests cannot import Unix `grp` on Windows. These are not presented as passes or all certified harmless. Business portals, game semantics and live streaming need target-specific acceptance. Global activation and formal publication to main remain pending.

No private runtime, continuation, logged-in profile, device identifier or raw application screenshot is included here.

[Plan coverage and remaining acceptance](plan-status.md) distinguishes implemented adapters from target-specific acceptance.
