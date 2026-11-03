# Working with jev-fast

Current architecture (2026-11-04): each physical host runs its own execution core. Read docs/quickstart-agent.md and docs/agent-integration-guide.md. Product CLI, stdio/public MCP servers, relay/connectors, public Mac bridge and admission management have been removed. Do not resurrect them or instruct users to connect to the historical public URL.

- The lifecycle/profile loader/Unix socket helpers remain POSIX-only; Windows uses direct DesktopExecutor or LocalBrowserService with a host-supplied DecisionPort. Do not claim Windows coordinator/profile installation works without porting uid/mode checks.
- Import local APIs from src/index.ts (compiled dist/src/index.js). The loopback operator console calls lifecycle functions directly. The owner-private coordinator IPC and model decision gateway remain internal infrastructure, not replacement public business APIs.
- Preserve browser, native desktop (Swift/macOS and PowerShell/Windows), Android/HostService backend clients and hybrid learning/verification modules. MCP client dependencies support third-party executors only; do not confuse them with a product MCP server.
- Daily Chrome/Edge requires an explicitly configured local attach/extension backend or the native desktop driver. RealBrowserService creates separate isolated contexts and does not reuse daily login state. Verify actual platform, OS permissions, browser connection and postconditions.
- Keep Key/profile/identity and historical ledgers private and intact. Upgrading source does not authorize deleting runtime files, rotating credentials, changing provider, overwriting live builds or stopping unrelated processes. Live retirement status is recorded in docs/reports/2026-11-04-per-host-core.md.
- Model choice is not task completion. Observe, select, execute and verify. Preserve idempotency_key/goal_id. UNKNOWN means preserve evidence and stop; never change keys, clear journals or replay uncertain physical actions.
- Manual stop intent stays authoritative; recovery uses the original selected profile and fails closed on mismatch. Proven-dead lock recovery must preserve audit data. Only close resources owned by your task.
- There is no new global paid/count/session/step cap. Explicit operator policies and caller budgets remain supported; correctness and OS/resource rules remain. No hosted calls in ordinary tests/CI.
- Historical reports/artifacts and archived manuals describe earlier versions. Preserve evidence, but never treat historical service URLs or old CLI commands as current support.

Use applicable Superpowers engineering skills. Before claiming code complete run npm run typecheck, npm run lint, npm test, npm run test:integration and npm run test:safety. Native changes also need platform-specific checks. Report skipped tests, actual physical acceptance scope and limitations.
