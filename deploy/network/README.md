# Deployment templates

These files are templates, not a deployment already installed or a tested Linux image.
See [deployment guide](../../docs/server-deployment.md) before using them.

- `server.example.json`: direct HTTPS on8443; change domain, paths and identity. The Host in publicHost must exactly match the external URL including nondefault port. Prefer standard443 when the actual server/proxy is prepared.
- `connector.example.json`: Mac makes outbound HTTPS only; the runtime credential must match the local panel/CLI. Omit caFile to use system CAs or add an absolute private0600 CA file.
- `jev-network.service`: non-root single relay instance; verify the server's actual Node path. No automatic restart: abrupt crashes preserve an owner lock requiring operator inspection. Run under the same `jev` owner as private config/TLS/token/store files.

Do not copy token values, certificates/private keys or runtime state into this directory. Generate credentials in private directories, separately from Jev model spending approvals. Do not deploy the local operator panel to the Internet. No cloud browser, Android service or API key is needed for this relay.
