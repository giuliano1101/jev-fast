# Network deployment templates

Current primary mode is `accessMode: "manual"`: no AI/device login, OAuth or preconfigured network token. New connections appear by self-reported name and start disabled until the operator enables their instance in the loopback console.

- `server.example.json`: manual HTTPS relay on8443 plus loopback admin console47832. Replace domain, paths and identity labels; publicHost matches externalURLHost including nondefault port.
- `connector.example.json`: tokenless outbound Mac connector with a display name; credentialFile is the existing LOCAL client-a file, not a network key.
- `server.bearer.example.json`, `connector.bearer.example.json`: previous S14 optional Bearer mode for compatibility.
- `jev-network.service`: non-root example; verify actualNodepath. Private config/TLS files0600, directparents0700. Abrupt crashes retain owner locks for operator inspection; no automatic delete/restart.

Names are labels, not verified identities. Connection/session handles are internal capabilities. Keep the operator console loopback-only and access it through an operator tunnel/provider control boundary; never expose it as a public self-approval endpoint. TLS remains mandatory for network traffic. No API key or model budget authorization is created by manual admission.

See [manual admission](../../docs/manual-admission.md) and [deployment guide](../../docs/server-deployment.md). These are templates, not an already deployed or Linux-tested installation.
