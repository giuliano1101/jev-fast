# Public relay deployment plan

> **For agentic workers:** Use Superpowers subagent-driven-development for the deployment helper and its reviews; parent performs the actual browser operations and acceptance checks.

**Goal:** Deploy the verified manual-admission relay to the user-selected Ubuntu server without buying a domain or affecting existing services.

**Architecture:** Reuse Nginx 80/443 with a separate IP-mapped sslip.io virtual host and a publicly trusted certificate. Run Node 24.19+ as a dedicated non-root user, HTTPS backend on 127.0.0.1:8443 and operator console on 127.0.0.1:47832. Nginx verifies a private backend certificate and preserves the external Host. New AI/device instances stay disabled; operator authority stays private.

**Scope:** User-authorized existing server only; no cloud purchases, existing site changes, user data uploads, API key upload, automatic approvals, or expansion beyond the bounded synthetic executor. Hosted Jev controls require a new explicit budget. Browser operations remain through CUA; Jev may choose only sanitized pre-reviewed action IDs, never account data or arbitrary shell.

- [x] Inspect existing runtime, resource capacity and Nginx site routing through the connected Chrome terminal.
- [x] Prepare an explicitly staged, fail-closed deployment helper with separate prepare/publish stages, source SHA256 validation, official Node binary checksum verification, existing-path refusal, non-root service, private files, backend TLS verification, and no modification to existing vhosts. Recovery is limited to the separately reviewed Node-only prefix; this is not a general resumable installer.
- [x] Test helper generation and negative inputs offline; obtain independent spec and quality review.
- [x] Upload source and helper through the existing server browser UI. Prepare service privately and verify listener isolation and non-root health.
- [x] Present concrete final public-access and ACME agreement action for action-time confirmation when required by CUA policy.
- [x] After confirmation publish only the new vhost, verify trusted external TLS/MCP pending initialization, isolation and existing-service health.
- [x] Configure private operator access and the Mac connector within the user's manual-switch preference. Do not self-approve connections.
- [x] Record actual Jev versus ordinary CUA operations and any untested acceptance items accurately. Update deployment docs/report, run required repository checks, commit and push GitHub.
