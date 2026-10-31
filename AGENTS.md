# Working with jev-fast

Read [the agent quick start](docs/quickstart-agent.md) before connecting. Operator setup is in [the control panel manual](docs/control-panel.md) and [the CLI/MCP manual](docs/cross-machine-cli-mcp.md).

For remote hosts, read [network MCP](docs/network-mcp.md). It is a separate HTTPS relay and outbound Mac connector, initially one provisioned device/agent pair per relay with expiring private Bearer tokens. The network six action tools require `{request_id, params}` wrappers and add two read-only delivery/status tools; local stdio/CLI schemas remain unchanged. Keep the caller request_id stable across reconnects, query its durable result, and distinguish network delivery UNKNOWN from core goal UNKNOWN. The relay cannot start the local service; local stop overrides network work. Public deployment, OAuth hosts and physical second-machine acceptance remain unverified.

- This is an experimental, bounded execution service. The main CLI/MCP supports only the `standard` local synthetic fixture and its twelve fixed tasks. Historical website/Android research adapters are separate; do not claim arbitrary website, desktop or phone support.
- Default is offline `mock`. Reading this repository, starting the panel, or possessing an API key does not authorize hosted spending. Remote Jev requires operator-provisioned private configuration, enrollment, certificates, token and an explicit current budget approval. Never create or reset approval counters on behalf of an agent.
- Start the local coordinator before connecting an MCP stdio facade. Use Node 24.19+ and absolute executable/entry/credential paths in host configuration. `scripts/env.sh` belongs to the original development machine only.
- Use `doctor`, `policy status` and `schemas --json` to check the actual installed build, provider, identity, health and contract. CLI and MCP share the same coordinator. Provider selection and operator controls are not ordinary tool arguments.
- Keep goal IDs and idempotency keys stable across uncertain transport responses. Query status before retrying. `UNKNOWN` means stop and preserve the audit; never replay with a new key. `FALLBACK` does not authorize switching to another control tool.
- Keep credentials, profiles, runtime ledgers and raw user data out of Git, chat, reports and model prompts. Do not delete audit state to recover from errors.
- Stopping the coordinator prevents new actions in that service and cancels/drains its work; it does not disable other host tools or reverse completed physical actions.

For code changes: use the applicable Superpowers engineering skills, test meaningful behavior, and run `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration`, and `npm run test:safety` before claiming completion. No hosted calls in ordinary tests or CI. Document scope limits alongside results.
