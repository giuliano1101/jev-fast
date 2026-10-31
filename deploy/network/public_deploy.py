#!/usr/bin/env python3
"""Ubuntu 24.04 operator helper. prepare is private; publish requires confirmation.

No hosted provider configuration, admission approval, firewall changes, package
installation, or deletion of audit/configuration is performed. Run offline tests
with: python3 -m unittest discover -s deploy/network/tests -v
"""
import argparse
import grp
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

NODE_VERSION = '24.19.0'
SERVICE = 'jev-network.service'
ACCOUNT_ROOT = Path('/etc/letsencrypt/accounts/acme-v02.api.letsencrypt.org/directory')
BUILD_ROOTS = {'src', 'fixtures', 'tests', 'bench'}
BUILD_FILES = {'package.json', 'package-lock.json', 'tsconfig.json', 'scripts/build.mjs'}
# Archives may contain repository documentation/evidence, but these never install.
OTHER_ROOTS = {'docs', 'artifacts', '.github', 'deploy', 'scripts'}
OTHER_FILES = {'.gitattributes', '.gitignore', '.nvmrc', 'AGENTS.md', 'CHANGELOG.md',
               'CONTRIBUTING.md', 'README.md', 'SECURITY.md', 'LICENSE',
               'eslint.config.js', 'eslint.config.mjs', '打开Jev控制面板.command'}
MAX_SOURCE_BYTES = 256 * 1024 * 1024


class Paths:
    def __init__(self, root=Path('/')):
        self.root = root
        self.code = root / 'opt/jev-fast'
        self.node = root / f'opt/jev-node-v{NODE_VERSION}'
        self.config = root / 'etc/jev-network'
        self.state = root / 'var/lib/jev-network'
        self.logs = root / 'var/log/jev-network'
        self.trust = root / 'etc/nginx/jev-network-trust.pem'
        self.unit = root / f'etc/systemd/system/{SERVICE}'
        self.site = root / 'etc/nginx/sites-available/jev-network.conf'
        self.enabled = root / 'etc/nginx/sites-enabled/jev-network.conf'
        self.hook = root / 'etc/letsencrypt/renewal-hooks/deploy/jev-network'

    def reserved(self):
        return [self.code, self.node, self.config, self.state, self.logs,
                self.trust, self.unit, self.site, self.enabled, self.hook]


def validate_hostname(value):
    if len(value) > 253 or '.' not in value:
        raise ValueError('a lower-case external DNS hostname is required')
    if not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', x)
               for x in value.split('.')):
        raise ValueError('invalid hostname')
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise ValueError('use a DNS hostname, not an IP address')


def validate_digest(value):
    if not re.fullmatch(r'[a-f0-9]{64}', value):
        raise ValueError('SHA256 must be exactly 64 lower-case hexadecimal characters')
    return value


def digest_file(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def source_members(archive):
    selected, names, total = [], set(), 0
    for member in archive:
        name = member.name.rstrip('/')
        parts = name.split('/')
        if ('\\' in name or name.startswith('/') or any(x in ('', '.', '..') for x in parts)
                or parts[0] != 'jev-fast' or member.issym() or member.islnk()
                or not (member.isfile() or member.isdir()) or name in names):
            raise ValueError('unsafe or duplicate source archive member')
        names.add(name)
        if len(parts) == 1:
            if not member.isdir():
                raise ValueError('archive root must be a directory')
            continue
        relative = '/'.join(parts[1:])
        root = parts[1]
        if root not in BUILD_ROOTS | OTHER_ROOTS and relative not in BUILD_FILES | OTHER_FILES:
            raise ValueError('unexpected source archive path: ' + relative)
        total += member.size
        if total > MAX_SOURCE_BYTES or len(names) > 20000:
            raise ValueError('source archive exceeds deployment bounds')
        if root in BUILD_ROOTS or relative in BUILD_FILES:
            selected.append((member, relative))
    required = {'package.json', 'package-lock.json', 'tsconfig.json', 'scripts/build.mjs', 'src/network/main.ts'}
    files = {name for member, name in selected if member.isfile()}
    if not required.issubset(files):
        raise ValueError('source archive is missing required build inputs')
    return selected


def extract_source(path, expected, destination):
    validate_digest(expected)
    # Copy into a private immutable snapshot before verifying/extracting (no TOCTOU).
    with tempfile.TemporaryFile() as snapshot:
        with Path(path).open('rb') as source:
            shutil.copyfileobj(source, snapshot)
        snapshot.seek(0)
        h = hashlib.sha256()
        for block in iter(lambda: snapshot.read(1024 * 1024), b''):
            h.update(block)
        if h.hexdigest() != expected:
            raise ValueError('source SHA256 mismatch')
        snapshot.seek(0)
        with tarfile.open(fileobj=snapshot, mode='r:gz') as archive:
            selected = source_members(archive)  # validate entire archive before writing
            destination.mkdir(mode=0o700, parents=False, exist_ok=False)
            for member, relative in selected:
                target = destination / relative
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with target.open('xb') as output, archive.extractfile(member) as source:
                        shutil.copyfileobj(source, output)
                    target.chmod(0o644)


def check_collisions(paths, user_exists, group_exists):
    if user_exists or group_exists:
        raise FileExistsError('jev user/group already exists; no account reuse')
    for path in paths.reserved():
        if path.exists() or path.is_symlink():
            raise FileExistsError('reserved path already exists: ' + str(path))


def check_prepare_state(paths, resume, users, groups):
    matched_users = [user for user in users if user.pw_name == 'jev']
    matched_groups = [group for group in groups if group.gr_name == 'jev']
    if not resume:
        check_collisions(paths, bool(matched_users), bool(matched_groups))
        return None
    # This is only the reviewed prefix: dedicated account + immutable Node,
    # before any source install, private configuration, service or audit exists.
    for path in paths.reserved():
        if path != paths.node and (path.exists() or path.is_symlink()):
            raise FileExistsError('resume refuses any state beyond the Node-only prefix: ' + str(path))
    if len(matched_users) != 1 or len(matched_groups) != 1:
        raise ValueError('resume requires the already-created dedicated jev user and group')
    user, group = matched_users[0], matched_groups[0]
    if (not 0 < user.pw_uid < 1000 or not 0 < group.gr_gid < 1000
            or user.pw_gid != group.gr_gid or user.pw_dir != '/nonexistent'
            or user.pw_shell != '/usr/sbin/nologin' or group.gr_mem
            or any(other.pw_name != 'jev' and (other.pw_uid == user.pw_uid or other.pw_gid == group.gr_gid) for other in users)
            or any(other.gr_name != 'jev' and (other.gr_gid == group.gr_gid or 'jev' in other.gr_mem) for other in groups)):
        raise ValueError('resume account/group does not match the expected dedicated nonlogin system account')
    if paths.node.is_symlink() or not paths.node.is_dir():
        raise ValueError('resume requires the existing real Node installation directory')
    return user


def tree_entries(root):
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Node tree root must be a real directory')
    entries = {'.': root}
    def fail(error):
        raise error
    for parent, dirs, files in os.walk(root, followlinks=False, onerror=fail):
        for name in dirs + files:
            path = Path(parent) / name
            entries[str(path.relative_to(root))] = path
    return entries


def verify_node_installation(installed, official, owner=(0, 0)):
    actual, expected = tree_entries(installed), tree_entries(official)
    if actual.keys() != expected.keys():
        raise ValueError('existing Node tree has missing or extra paths')
    for name, expected_path in expected.items():
        actual_path = actual[name]
        before, reference = actual_path.lstat(), expected_path.lstat()
        if (before.st_uid, before.st_gid) != owner:
            raise ValueError('existing Node tree is not entirely root-owned')
        if stat.S_IFMT(before.st_mode) != stat.S_IFMT(reference.st_mode):
            raise ValueError('existing Node path type differs from official archive')
        if stat.S_ISLNK(reference.st_mode):
            if os.readlink(actual_path) != os.readlink(expected_path):
                raise ValueError('existing Node symlink differs from official archive')
        elif stat.S_ISDIR(reference.st_mode) or stat.S_ISREG(reference.st_mode):
            expected_mode = 0o555 if stat.S_ISDIR(reference.st_mode) or reference.st_mode & 0o111 else 0o444
            if before.st_mode & 0o7777 != expected_mode:
                raise ValueError('existing Node permissions differ from the read-only installation')
            if stat.S_ISREG(reference.st_mode) and (before.st_size != reference.st_size or digest_file(actual_path) != digest_file(expected_path)):
                raise ValueError('existing Node content differs from the officially verified archive')
        else:
            raise ValueError('unexpected special file in Node archive')


def build_source(source, node, cache, launcher):
    if not Path(launcher).is_absolute():
        raise ValueError('builder launcher must be an absolute preflight-resolved executable')
    env = {'PATH': str(node / 'bin') + ':/usr/bin:/bin',
           'HOME': str(cache), 'npm_config_cache': str(cache),
           'npm_config_audit': 'false', 'npm_config_fund': 'false',
           'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD': '1'}
    for command in [['npm', 'ci', '--ignore-scripts'], ['npm', 'run', 'build']]:
        run([launcher, '-u', 'jev', '--', str(node / 'bin' / command[0]), *command[1:]], cwd=source, env=env)


def server_config(host):
    return {'accessMode': 'manual', 'host': '127.0.0.1', 'port': 8443,
            'publicHost': validate_hostname(host), 'allowedOrigins': [],
            'deviceId': 'jev-executor', 'agentId': 'primary-ai',
            'storeDir': '/var/lib/jev-network/relay',
            'tlsKeyFile': '/etc/jev-network/server.key',
            'tlsCertFile': '/etc/jev-network/server.pem', 'adminPort': 47832}


def service_unit():
    return f'''[Unit]
Description=Jev manual admission relay (bounded synthetic executor)
After=network.target
[Service]
Type=simple
User=jev
Group=jev
WorkingDirectory=/opt/jev-fast
ExecStart=/opt/jev-node-v{NODE_VERSION}/bin/node /opt/jev-fast/dist/src/network/main.js server --config /etc/jev-network/server.json
Restart=no
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=/var/lib/jev-network /var/log/jev-network
StandardOutput=append:/var/log/jev-network/service.log
StandardError=append:/var/log/jev-network/service.log
TimeoutStopSec=90
[Install]
WantedBy=multi-user.target
'''


def nginx_common(host):
    return f'''    server_name {validate_hostname(host)};
    access_log off;
    error_log /var/log/jev-network/nginx-error.log crit;
    client_max_body_size 65536;
    client_header_buffer_size 1k;
    large_client_header_buffers 2 8k;
    client_header_timeout 5s;
    client_body_timeout 2s;
'''


def http_vhost(host):
    return ('server {\n    listen 80;\n' + nginx_common(host) + '''    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type text/plain;
        autoindex off;
        limit_except GET { deny all; }
    }
    location / { return 404; }
}
''')


def https_vhost(host):
    host = validate_hostname(host)
    proxy = '''        proxy_pass https://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_ssl_verify on;
        proxy_ssl_verify_depth 1;
        proxy_ssl_server_name on;
        proxy_ssl_name localhost;
        proxy_ssl_trusted_certificate /etc/nginx/jev-network-trust.pem;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 15s;
        proxy_send_timeout 5s;
'''
    locations = ''.join('    location = ' + path + ' {\n' + proxy + '    }\n'
                        for path in ['/mcp', '/connector/register', '/connector/sync', '/health'])
    return ('server {\n    listen 443 ssl;\n' + nginx_common(host)
            + f'    ssl_certificate /etc/letsencrypt/live/{host}/fullchain.pem;\n'
            + f'    ssl_certificate_key /etc/letsencrypt/live/{host}/privkey.pem;\n'
            + '    ssl_protocols TLSv1.2 TLSv1.3;\n' + locations
            + '    location / { return 404; }\n}\n')


def renewal_hook(host):
    host = validate_hostname(host)
    return f'''#!/bin/sh
# Only this certificate may trigger the Jev reload hook.
[ "$RENEWED_LINEAGE" = "/etc/letsencrypt/live/{host}" ] || exit 0
/usr/sbin/nginx -t && /bin/systemctl reload nginx
'''


def require_public_confirmation(confirmed):
    if not confirmed:
        raise ValueError('publish requires --confirm-public-access-and-acme-terms; operator must approve public endpoints and ACME terms')


def acme_arguments(root, account, email):
    existing = sorted(p.parent.name for p in root.glob('*/regr.json')
                      if re.fullmatch('[a-f0-9]{32}', p.parent.name))
    if account:
        if account not in existing:
            raise ValueError('selected ACME account does not exist')
        return ['--account', account]
    if len(existing) == 1:
        return ['--account', existing[0]]
    if existing:
        raise ValueError('multiple ACME accounts; select --acme-account')
    if not email or not re.fullmatch(r'[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', email):
        raise ValueError('no existing ACME account; explicitly provide --acme-email to create one after confirming terms')
    return ['--email', email, '--agree-tos', '--no-eff-email']


def run(args, **kwargs):
    # Never echo commands or output that could include the private console URL.
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise RuntimeError('command failed: ' + Path(args[0]).name + '; private output retained only in process memory')
    return result.stdout.decode().strip()


def finish_prepare(command, host):
    command(['systemctl', 'daemon-reload'])
    command(['systemctl', 'start', SERVICE])  # no boot enable or nginx publication
    last = None
    for _ in range(20):
        try:
            command(['curl', '--fail', '--silent', '--show-error', '--noproxy', '*',
                     '--connect-timeout', '2', '--max-time', '3',
                     '--cacert', '/etc/jev-network/server.pem',
                     '--header', 'Host: ' + host, 'https://localhost:8443/health'])
            return
        except RuntimeError as error:
            last = error
            time.sleep(0.5)
    raise RuntimeError('private backend health check failed; inspect private logs') from last


def write_new(path, content, mode=0o600, owner=None):
    # O_EXCL refuses existing files and symlinks without following them.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'w') as output:
        output.write(content)
    if owner:
        os.chown(path, *owner)


def own_tree(path, uid, gid, readonly=False):
    # Never follow links created by a build. Internal npm bin links are allowed.
    for parent, dirs, files in os.walk(path, followlinks=False):
        for target in [Path(parent)] + [Path(parent) / x for x in dirs + files]:
            if target.is_symlink():
                if not target.resolve().is_relative_to(path.resolve()):
                    raise ValueError('build contains a link outside its tree')
                os.lchown(target, uid, gid)
            else:
                os.chown(target, uid, gid)
                executable = target.is_dir() or bool(target.stat().st_mode & 0o111)
                target.chmod((0o555 if executable else 0o444) if readonly else (0o755 if executable else 0o644))


def preflight(host):
    if os.geteuid() != 0:
        raise ValueError('run as the operator with sudo on Ubuntu 24.04')
    release = Path('/etc/os-release').read_text()
    if 'ID=ubuntu\n' not in release or 'VERSION_ID="24.04"' not in release:
        raise ValueError('only Ubuntu 24.04 is supported')
    validate_hostname(host)
    commands = {}
    for command in ['nginx', 'certbot', 'curl', 'openssl', 'systemctl', 'runuser', 'useradd']:
        found = shutil.which(command)
        if not found:
            raise ValueError('required existing command unavailable: ' + command)
        commands[command] = str(Path(found).resolve(strict=True))
    run([commands['nginx'], '-t'])
    return commands


def check_site_hostname(host):
    # nginx -T includes loaded vhosts. Refuse duplicate explicit names before changes.
    config = run(['nginx', '-T'])
    for names in re.findall(r'(?<![A-Za-z0-9_])server_name\s+([^;]+);', config):
        if host in [name.strip("\"'") for name in names.split()]:
            raise FileExistsError('hostname already configured in nginx')


def port_available(port):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', port))


def download_node(work):
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    if not arch:
        raise ValueError('unsupported machine architecture')
    filename = f'node-v{NODE_VERSION}-linux-{arch}.tar.xz'
    base = f'https://nodejs.org/dist/v{NODE_VERSION}/'
    for name in [filename, 'SHASUMS256.txt']:
        run(['curl', '--fail', '--silent', '--show-error', '--proto', '=https',
             '--tlsv1.2', '--location', '--proto-redir', '=https',
             '--output', str(work / name), base + name])
    sums = (work / 'SHASUMS256.txt').read_text()
    expected = [line.split()[0] for line in sums.splitlines()
                if len(line.split()) == 2 and line.split()[1] == filename]
    if len(expected) != 1 or digest_file(work / filename) != validate_digest(expected[0]):
        raise ValueError('official Node SHASUMS verification failed')
    destination = work / 'node'
    destination.mkdir()
    with tarfile.open(work / filename, 'r:xz') as archive:
        # Python 3.12's data filter rejects escaping paths/links/special files.
        archive.extractall(destination, filter='data')
    return destination / filename.removesuffix('.tar.xz')


def prepare(args):
    paths = Paths()
    host = validate_hostname(args.hostname)
    validate_digest(args.sha256)
    commands = preflight(host)
    resumed_user = check_prepare_state(paths, args.resume_verified_node, pwd.getpwall(), grp.getgrall())
    check_site_hostname(host)
    for port in [8443, 47832]:
        port_available(port)
    for path in [Path('/etc/letsencrypt/live') / host, Path('/etc/letsencrypt/renewal') / (host + '.conf')]:
        if path.exists() or path.is_symlink():
            raise FileExistsError('certificate lineage already exists: ' + str(path))
    # No service/user/config changes until source validation and Node download succeed.
    with tempfile.TemporaryDirectory(prefix='jev-prepare-', dir='/var/tmp') as temp:
        work = Path(temp)
        source = work / 'source'
        extract_source(Path(args.source), args.sha256, source)
        node = download_node(work)
        if resumed_user:
            verify_node_installation(paths.node, node)
            user = resumed_user
        else:
            run([commands['useradd'], '--system', '--user-group', '--no-create-home', '--home-dir',
                 '/nonexistent', '--shell', '/usr/sbin/nologin', 'jev'])
            user = pwd.getpwnam('jev')
            # Node installation is root-owned before any builder execution.
            shutil.copytree(node, paths.node, symlinks=True)
            own_tree(paths.node, 0, 0, readonly=True)
        owner = (user.pw_uid, user.pw_gid)
        work.chmod(0o711)
        own_tree(source, *owner)
        cache = work / 'cache'
        cache.mkdir(mode=0o700)
        os.chown(cache, *owner)
        build_source(source, paths.node, cache, commands['runuser'])
        if not (source / 'dist/src/network/main.js').is_file():
            raise ValueError('build did not produce network server entry')
        shutil.copytree(source, paths.code, symlinks=True)
        own_tree(paths.code, 0, 0, readonly=True)
    for directory in [paths.config, paths.state, paths.logs]:
        directory.mkdir(mode=0o700)
        os.chown(directory, *owner)
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes',
         '-days', '3650', '-subj', '/CN=localhost',
         '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
         '-addext', 'basicConstraints=critical,CA:TRUE',
         '-keyout', str(paths.config / 'server.key'), '-out', str(paths.config / 'server.pem')])
    for name in ['server.key', 'server.pem']:
        cert = paths.config / name
        cert.chmod(0o600)
        os.chown(cert, *owner)
    write_new(paths.trust, (paths.config / 'server.pem').read_text(), 0o644)
    write_new(paths.config / 'server.json', json.dumps(server_config(host), indent=2) + '\n', owner=owner)
    write_new(paths.config / 'http.conf', http_vhost(host))
    write_new(paths.config / 'https.conf', https_vhost(host))
    write_new(paths.unit, service_unit(), 0o644)
    # Private logs include the console capability; never journal them or print them.
    for name in ['service.log', 'nginx-error.log']:
        write_new(paths.logs / name, '', owner=owner)
    finish_prepare(run, host)
    write_new(paths.code / 'prepared.json', json.dumps({'hostname': host, 'source_sha256': args.sha256,
              'node_version': NODE_VERSION, 'backend_cert_sha256': digest_file(paths.trust)}, indent=2) + '\n', 0o444)
    print('Private backend prepared and healthy. No nginx site enabled. Public access remains pending publish confirmation.')


def prepare_acme_webroot(webroot):
    if webroot.is_symlink() or (webroot.exists() and not webroot.is_dir()):
        raise ValueError('ACME webroot is not a real directory')
    if not webroot.exists():
        # Existing /var/www is an operator prerequisite; do not change its mode.
        webroot.mkdir(mode=0o755)
        webroot.chmod(0o755)  # bypass the private process umask for this new public path only


def publish(args):
    require_public_confirmation(args.confirm_public_access_and_acme_terms)
    host = validate_hostname(args.hostname)
    preflight(host)
    paths = Paths()
    manifest = json.loads((paths.code / 'prepared.json').read_text())
    if manifest['hostname'] != host or manifest['backend_cert_sha256'] != digest_file(paths.trust):
        raise ValueError('prepared hostname/backend trust pin mismatch')
    if json.loads((paths.config / 'server.json').read_text()) != server_config(host):
        raise ValueError('prepared server configuration changed')
    for path in [paths.site, paths.enabled, paths.hook,
                 Path('/etc/letsencrypt/live') / host,
                 Path('/etc/letsencrypt/renewal') / (host + '.conf')]:
        if path.exists() or path.is_symlink():
            raise FileExistsError('publication path already exists: ' + str(path))
    check_site_hostname(host)
    acme = acme_arguments(ACCOUNT_ROOT, args.acme_account, args.acme_email)
    run(['systemctl', 'is-active', SERVICE])
    run(['curl', '--fail', '--silent', '--noproxy', '*', '--cacert', str(paths.trust),
         '--header', 'Host: ' + host, 'https://localhost:8443/health'])
    webroot = Path('/var/www/acme')
    prepare_acme_webroot(webroot)
    # Only our newly created vhost changes. On any failure disable only our link.
    write_new(paths.site, http_vhost(host), 0o644)
    os.symlink(paths.site, paths.enabled)
    try:
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
        run(['certbot', 'certonly', '--non-interactive', '--webroot', '-w', str(webroot),
             '--server', 'https://acme-v02.api.letsencrypt.org/directory',
             '--cert-name', host, '-d', host, *acme])
        # This is our exclusively created file; replace only it after certificate issuance.
        paths.site.write_text(http_vhost(host) + https_vhost(host))
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
        paths.hook.parent.mkdir(parents=True, exist_ok=True)
        write_new(paths.hook, renewal_hook(host), 0o755)
        print('Public Jev vhost enabled. Verify external TLS/MCP and private listener isolation separately.')
    except Exception:
        if paths.enabled.is_symlink() and paths.enabled.resolve() == paths.site:
            paths.enabled.unlink()
            run(['nginx', '-t'])
            run(['systemctl', 'reload', 'nginx'])
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    private = sub.add_parser('prepare', help='validate/build and start loopback backend only')
    private.add_argument('--source', type=Path, required=True)
    private.add_argument('--sha256', required=True)
    private.add_argument('--hostname', required=True)
    private.add_argument('--resume-verified-node', action='store_true',
                         help='operator-reviewed recovery only for the existing account + exact read-only Node prefix, with no other installation/state')
    public = sub.add_parser('publish', help='operator-confirmed new HTTP/HTTPS vhost and ACME certificate')
    public.add_argument('--hostname', required=True)
    public.add_argument('--confirm-public-access-and-acme-terms', action='store_true')
    public.add_argument('--acme-account', help='required when multiple existing production ACME accounts exist')
    public.add_argument('--acme-email', help='explicit new ACME registration email if no account exists')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        (prepare if args.mode == 'prepare' else publish)(args)
    except Exception as error:
        # No command output, admin capabilities, key material, or raw server data.
        print('Deployment stopped: ' + str(error) + '. Preserve partial state and audit; do not rerun or delete it automatically.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
