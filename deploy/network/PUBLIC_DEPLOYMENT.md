# Operator deployment helper (Ubuntu 24.04)

`public_deploy.py` has two explicit stages. It uses existing Nginx, Certbot,
OpenSSL, curl, systemd, Python 3.12 and standard Ubuntu account tools. It does
not install OS packages, modify existing vhosts/firewall/global configuration,
configure a provider, upload keys, approve connections, or authorize spending.
Run it from a private operator terminal as root. Never expose that terminal or
copy the service log/console capability into public reports.

By default the helper is fail-closed: every installation path, `jev` user/group,
explicit duplicate Nginx hostname and certificate lineage must be absent. The
only reviewed recovery exception is the explicit Node-only prefix described below. A repeated invocation refuses existing state rather than overwriting
it. If a step fails, preserve its files and audit and review the partial state;
there is deliberately no automatic delete/reset or generic retry mode.

## Prepare: private backend only

Supply the exact source release SHA256 through a trusted channel. Example paths,
hostnames and digest below are placeholders, not deployment-specific IDs:

```sh
sudo python3 /private/operator/public_deploy.py prepare \
  --source /private/operator/jev-fast-source.tar.gz \
  --sha256 EXACT_64_LOWERCASE_SHA256 \
  --hostname jev.example.com
```

Preparation validates a private snapshot of the whole archive before extracting
only the source/fixture/test/benchmark inputs, package lock, TypeScript config
and build script. Absolute/traversing paths, unexpected roots, duplicate names,
links and special files are refused. Repository docs and evidence never install.
The exact supported exported archive root is `jev-fast/`.

The helper fetches pinned Node **v24.19.0** from `https://nodejs.org/dist/` for
x64/arm64, verifies its SHA256 against the official HTTPS `SHASUMS256.txt`, and
installs it separately under `/opt/jev-node-v24.19.0`. It leaves system Node
alone. This verifies the official transport/checksum manifest; it does not add
a separate OpenPGP release-signature verification step. `npm ci --ignore-scripts`
and `npm run build` execute as the non-login `jev` system user in temporary
source, with a private npm cache and no inherited operator credentials. Installed
code and Node become root-owned, read-only files/directories.

The service uses manual admission, no allowed browser origins, the supplied
external `publicHost`, relay `127.0.0.1:8443`, and operator console
`127.0.0.1:47832`. `/etc/jev-network` is 0700 with jev-owned 0600 config/key/cert;
state and logs are jev-owned 0700. A localhost-only self-signed certificate is
pinned by a root-owned public certificate in Nginx's trust path. The root-owned
read-only preparation receipt lives in `/opt/jev-fast/prepared.json`.

The systemd unit runs nonroot, with `Restart=no`, private stdout/stderr logs,
empty capabilities, filesystem protections and 0077 umask. Prepare starts only
this service, then verifies `/health` using the backend certificate and the
external Host header. HTTP/HTTPS templates are staged privately. It never
enables/reloads Nginx, obtains a public certificate, or enables service boot.
The private console URL is in `/var/log/jev-network/service.log`; read only in
the private operator session and reach it using an authenticated SSH tunnel.

## Narrow operator-reviewed recovery of the Node-only prefix

A private prepare attempt may have created only the `jev` system account/group
and `/opt/jev-node-v24.19.0`, then failed before dependency installation. After
the operator verifies this exact prefix, `prepare --resume-verified-node` may
continue using the same `--source`, `--sha256` and `--hostname` arguments.
The flag never applies automatically and does not enable generic partial-state
recovery.

Resume requires the existing dedicated nonlogin account: UID/GID below 1000
and above zero, home `/nonexistent`, shell `/usr/sbin/nologin`, matching private
primary group, no extra members/shared IDs or supplementary groups. The Node
path must be a real directory. Every other reserved code/config/state/log/unit/
trust/vhost/renew-hook path must still be absent. A missing expected prefix,
any existing audit/runtime/configuration, or additional installation state stops
recovery before reuse.

The source digest is checked again. The helper downloads the pinned Node release
again and verifies it against fresh official HTTPS SHASUMS. Before reusing the
existing Node tree, it compares every path/type, symlink target, file size/content,
root ownership and exact 0555/0444 read-only permissions to that verified
release. Missing/extra files, changed content, writable modes, unexpected owners
or links are refused. Existing account/Node files are never replaced, chmodded,
or deleted. The nonroot build uses the absolute `runuser` executable resolved
in preflight, so its deliberately restricted child PATH need not include sbin.

## Publish: explicit operator public-access and ACME confirmation

Before invoking publish, the operator must confirm the actual public exposure
and the current ACME subscriber agreement. The confirmation flag is an explicit
operator assertion; the helper cannot infer it from having run prepare.

```sh
sudo python3 /private/operator/public_deploy.py publish \
  --hostname jev.example.com \
  --confirm-public-access-and-acme-terms
```

If exactly one production Let's Encrypt account exists, it is reused. With
multiple accounts, add `--acme-account ACCOUNT_DIRECTORY_NAME`. With none,
publication stops unless the operator explicitly adds
`--acme-email operator@example.com` to create an account under the confirmed
terms. No silent new account or agreement occurs.

The parent `/var/www` must already exist. A newly created `/var/www/acme` gets
explicit 0755 permissions despite the private 0077 process umask; an existing
webroot's permissions remain unchanged.

Publish creates only `/etc/nginx/sites-available/jev-network.conf` and its new
sites-enabled link. First it serves only `/.well-known/acme-challenge/` over port
80 from `/var/www/acme` (other paths 404), obtains one named certificate using
`certbot certonly --webroot`, then adds HTTPS 443. Nginx proxies exactly `/mcp`,
`/connector/register`, `/connector/sync` and `/health` to the HTTPS loopback
backend; other paths 404. Backend verification is on with the pinned cert,
`proxy_ssl_name localhost`, SNI, and `Host $host`. Port 47832 is never proxied.

Body limit is the relay's 65,536 bytes. Nginx permits two 8 KiB large-header
buffers and the backend retains Node's 16 KiB total header bound. Header/body
and upstream deadlines are bounded. Request/response buffering and access logs
are disabled. The vhost's critical error log is inside the private log directory.
A new renewal deploy hook checks this exact certificate lineage before running
`nginx -t && systemctl reload nginx`; other hooks remain untouched.

If publication fails after linking the new vhost, the helper removes only that
new link and validates/reloads the existing Nginx configuration. It preserves
all partial files, certificate material and state for operator inspection. A
successful helper run is not acceptance evidence: separately verify external
trusted TLS, pending MCP registration, all connection switches default off,
loopback listener isolation, private operator access and existing-site health.
Service boot remains an operator decision (`systemctl enable jev-network`).

## Offline verification and limits

```sh
python3 -m unittest discover -s deploy/network/tests -v
```

Tests cover hostile hostname/digest inputs, hash mismatch, archive traversal,
links/special/duplicate/oversized members, extraction allowlists, untouched
collisions, read-only installs, hostname collisions, local-only preparation,
public route/TLS/logging settings, account selection and terms requirements, absolute launcher lookup under the
restricted environment, and strict Node-only resume-prefix/tree verification.
They never run root commands, download dependencies or contact a server/ACME.
Real Ubuntu/systemd/Nginx/Certbot/Node-download acceptance still requires the
operator's target-host checks. This deploys the bounded manual-admission relay;
it does not establish arbitrary website/desktop/phone execution support.
