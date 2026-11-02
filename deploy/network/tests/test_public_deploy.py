"""Offline security and render tests; never execute system changes or downloads."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

HELPER = Path(__file__).parents[1] / 'public_deploy.py'


class DeploymentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not HELPER.exists():
            raise AssertionError('deployment helper does not exist yet')
        spec = importlib.util.spec_from_file_location('public_deploy', HELPER)
        cls.d = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.d)

    def archive(self, directory, entries=None):
        path = Path(directory) / 'source.tar.gz'
        defaults = {f'jev-fast/{name}': b'{}' for name in
                    ('package.json', 'package-lock.json', 'tsconfig.json', 'scripts/build.mjs', 'src/network/main.ts')}
        with tarfile.open(path, 'w:gz') as archive:
            for name, data in (entries or defaults).items():
                member = tarfile.TarInfo(name)
                if data is None:
                    member.type = tarfile.SYMTYPE
                    member.linkname = '/etc/shadow'
                    archive.addfile(member)
                else:
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_hostname_and_digest_refuse_injection_or_ambiguous_host(self):
        for host in ['example.com; id', 'https://example.com', '*.example.com', 'foo/bar', 'a\nserver {}', '127.0.0.1', '-x.example', 'UPPER.example', 'example.com:443', 'a..com']:
            with self.subTest(host=host), self.assertRaises(ValueError):
                self.d.validate_hostname(host)
        self.assertEqual(self.d.validate_hostname('jev.43-160-233-161.sslip.io'), 'jev.43-160-233-161.sslip.io')
        for digest in ['a' * 63, 'Z' * 64, '-abc', 'a' * 64 + '\n']:
            with self.assertRaises(ValueError):
                self.d.validate_digest(digest)

    def test_hash_mismatch_or_unsafe_archive_never_extracts_any_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, digest = self.archive(tmp)
            out = Path(tmp) / 'extract'
            with self.assertRaises(ValueError):
                self.d.extract_source(path, '0' * 64, out)
            self.assertFalse(out.exists())
            for name in ['jev-fast/../../outside', '/tmp/outside', 'jev-fast/src/../evil', 'other/src/a', 'jev-fast/.runtime/key', 'jev-fast/src/evil\\x']:
                path, digest = self.archive(tmp, {'jev-fast/package.json': b'{}', name: b'bad'})
                with self.subTest(name=name), self.assertRaises(ValueError):
                    self.d.extract_source(path, digest, out)
                self.assertFalse(out.exists())
            path, digest = self.archive(tmp, {'jev-fast/src/link': None})
            with self.assertRaises(ValueError):
                self.d.extract_source(path, digest, out)
            self.assertFalse(out.exists())

    def test_duplicate_links_special_members_and_oversized_archive_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'evil.tar.gz'
            for kind in ['duplicate', 'hardlink', 'fifo', 'oversized']:
                with tarfile.open(path, 'w:gz') as archive:
                    member = tarfile.TarInfo('jev-fast/src/x')
                    if kind == 'hardlink':
                        member.type, member.linkname = tarfile.LNKTYPE, 'jev-fast/src/y'
                    elif kind == 'fifo':
                        member.type = tarfile.FIFOTYPE
                    elif kind == 'oversized':
                        member.size = self.d.MAX_SOURCE_BYTES + 1
                    if kind == 'oversized':
                        # Inspect metadata directly without allocating an oversized body.
                        with self.assertRaises(ValueError):
                            self.d.source_members([member])
                        continue
                    archive.addfile(member)
                    if kind == 'duplicate':
                        archive.addfile(member)
                if kind != 'oversized':
                    with tarfile.open(path) as archive, self.assertRaises(ValueError):
                        self.d.source_members(archive)

    def test_existing_symlink_collision_and_immutable_install_permissions(self):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            paths = self.d.Paths(Path(tmp))
            paths.site.parent.mkdir(parents=True)
            paths.site.symlink_to('/nonexistent')
            with self.assertRaises(FileExistsError):
                self.d.check_collisions(paths, False, False)
            tree = Path(tmp) / 'code'
            tree.mkdir()
            (tree / 'entry').write_text('code')
            (tree / 'entry').chmod(0o755)
            (tree / 'data').write_text('{}')
            (tree / 'link').symlink_to('entry')
            self.d.own_tree(tree, os.getuid(), os.getgid(), readonly=True)
            self.assertEqual((tree / 'entry').stat().st_mode & 0o777, 0o555)
            self.assertEqual((tree / 'data').stat().st_mode & 0o777, 0o444)
            tree.chmod(0o755)
            (tree / 'escape').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                self.d.own_tree(tree, os.getuid(), os.getgid(), readonly=True)
            tree.chmod(0o755)

    def test_collision_detects_hostname_even_in_inline_nginx_configuration(self):
        original = self.d.run
        self.d.run = lambda command: 'server { listen 443; server_name jev.example.com other.example.com; }'
        try:
            with self.assertRaises(FileExistsError):
                self.d.check_site_hostname('jev.example.com')
        finally:
            self.d.run = original

    def test_extract_selects_build_inputs_without_archived_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, digest = self.archive(tmp)
            with tarfile.open(path, 'r:gz') as archive:
                names = {member.name: archive.extractfile(member).read() for member in archive}
            names['jev-fast/artifacts/private.log'] = b'not installed'
            path, digest = self.archive(tmp, names)
            out = Path(tmp) / 'extract'
            self.d.extract_source(path, digest, out)
            self.assertTrue((out / 'src/network/main.ts').exists())
            self.assertFalse((out / 'artifacts').exists())
            with self.assertRaises(FileExistsError):
                self.d.extract_source(path, digest, out)

    def test_collision_preflight_does_not_mutate_any_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = self.d.Paths(Path(tmp))
            for collision in paths.reserved():
                collision.parent.mkdir(parents=True, exist_ok=True)
                collision.write_text('existing')
                before = sorted(str(p.relative_to(tmp)) for p in Path(tmp).rglob('*'))
                with self.subTest(path=collision), self.assertRaises(FileExistsError):
                    self.d.check_collisions(paths, user_exists=False, group_exists=False)
                self.assertEqual(before, sorted(str(p.relative_to(tmp)) for p in Path(tmp).rglob('*')))
                self.assertEqual(collision.read_text(), 'existing')
                collision.unlink()
            with self.assertRaises(FileExistsError):
                self.d.check_collisions(paths, user_exists=True, group_exists=False)
            with self.assertRaises(FileExistsError):
                self.d.check_collisions(paths, user_exists=False, group_exists=True)

    def test_prepare_configs_are_private_loopback_and_do_not_enable_nginx(self):
        config = self.d.server_config('jev.example.com')
        self.assertEqual(config['host'], '127.0.0.1')
        self.assertEqual(config['port'], 8443)
        self.assertEqual(config['adminPort'], 47832)
        self.assertEqual(config['allowedOrigins'], [])
        self.assertEqual(config['accessMode'], 'manual')
        unit = self.d.service_unit()
        for setting in ['User=jev', 'Group=jev', 'Restart=always', 'RestartSec=3', 'StartLimitIntervalSec=0', '--recover-lock /var/lib/jev-network/relay/owner.lock', '--recover-lock /var/lib/jev-network/relay/manual-registry/owner.lock', '--recover-lock /var/lib/jev-network/relay/manual-requests/owner.lock', 'UMask=0077', 'ProtectSystem=strict', 'StandardOutput=append:/var/log/jev-network/service.log']:
            self.assertIn(setting, unit)
        self.assertNotIn('0.0.0.0', unit)
        # Preparation is tested as an orchestration boundary, independent of root/Ubuntu.
        events = []
        self.d.finish_prepare(lambda args: events.append(args), 'jev.example.com')
        self.assertTrue(any('start' in call for call in events))
        flat = ' '.join(' '.join(call) for call in events)
        self.assertNotIn('nginx', flat)
        self.assertNotIn('certbot', flat)
        self.assertIn('--cacert', flat)
        self.assertIn('Host: jev.example.com', flat)
        self.assertNotIn('--insecure', flat)

    def test_public_vhost_is_exact_scoped_verified_and_private(self):
        http = self.d.http_vhost('jev.example.com')
        https = self.d.https_vhost('jev.example.com')
        self.assertIn('listen 80;', http)
        self.assertIn('location ^~ /.well-known/acme-challenge/', http)
        self.assertIn('root /var/www/acme;', http)
        self.assertNotIn('proxy_pass', http)
        for content in (http, https):
            self.assertIn('access_log off;', content)
            self.assertIn('error_log /var/log/jev-network/nginx-error.log crit;', content)
            self.assertIn('location / { return 404; }', content)
            self.assertNotIn('47832', content)
        for directive in ['proxy_ssl_verify on;', 'proxy_ssl_name localhost;', 'proxy_set_header Host $host;', 'proxy_buffering off;', 'proxy_request_buffering off;', 'client_max_body_size 16777216;', 'large_client_header_buffers 2 8k;', 'location = /mcp', 'location = /connector/register', 'location = /connector/sync', 'location = /health']:
            self.assertIn(directive, https)
        self.assertIn('https://127.0.0.1:8443', https)

    def test_acme_account_selection_requires_explicit_new_account_terms(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(ValueError):
                self.d.acme_arguments(root, account=None, email=None)
            args = self.d.acme_arguments(root, account=None, email='operator@example.com')
            self.assertIn('--agree-tos', args)
            account = root / ('a' * 32)
            account.mkdir()
            (account / 'regr.json').write_text('{}')
            args = self.d.acme_arguments(root, account=None, email=None)
            self.assertEqual(args, ['--account', 'a' * 32])
            (root / ('b' * 32)).mkdir()
            (root / ('b' * 32) / 'regr.json').write_text('{}')
            with self.assertRaises(ValueError):
                self.d.acme_arguments(root, account=None, email=None)
            self.assertEqual(self.d.acme_arguments(root, account='a' * 32, email=None), ['--account', 'a' * 32])

    def test_builder_uses_absolute_launcher_outside_restricted_child_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            launcher = root / 'sbin/runuser'
            launcher.parent.mkdir()
            launcher.write_text('#!/bin/sh\nprintf "%s\\n" "$PATH|$*" >> invocations\n')
            launcher.chmod(0o755)
            source, cache, node = root / 'source', root / 'cache', root / 'node'
            source.mkdir()
            cache.mkdir()
            self.d.build_source(source, node, cache, str(launcher))
            lines = (source / 'invocations').read_text().splitlines()
            self.assertEqual(len(lines), 2)
            self.assertTrue(all(line.startswith(str(node / 'bin') + ':/usr/bin:/bin|') for line in lines))
            self.assertIn('-u jev -- ' + str(node / 'bin/npm') + ' ci --ignore-scripts', lines[0])
            self.assertIn('-u jev -- ' + str(node / 'bin/npm') + ' run build', lines[1])

    def expected_account(self):
        from types import SimpleNamespace
        user = SimpleNamespace(pw_name='jev', pw_uid=995, pw_gid=995,
                               pw_dir='/nonexistent', pw_shell='/usr/sbin/nologin')
        group = SimpleNamespace(gr_name='jev', gr_gid=995, gr_mem=[])
        return user, group

    def test_fresh_and_explicit_node_only_resume_require_exact_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = self.d.Paths(Path(tmp))
            self.assertIsNone(self.d.check_prepare_state(paths, False, [], []))
            user, group = self.expected_account()
            with self.assertRaises(ValueError):
                self.d.check_prepare_state(paths, True, [], [])
            with self.assertRaises(ValueError):
                self.d.check_prepare_state(paths, True, [user], [group])
            paths.node.mkdir(parents=True)
            self.assertIs(self.d.check_prepare_state(paths, True, [user], [group]), user)
            with self.assertRaises(FileExistsError):
                self.d.check_prepare_state(paths, False, [user], [group])
            for collision in paths.reserved():
                if collision == paths.node:
                    continue
                collision.parent.mkdir(parents=True, exist_ok=True)
                collision.write_text('preserve')
                with self.subTest(collision=collision), self.assertRaises(FileExistsError):
                    self.d.check_prepare_state(paths, True, [user], [group])
                self.assertEqual(collision.read_text(), 'preserve')
                collision.unlink()
            for field, value in [('pw_shell', '/bin/bash'), ('pw_dir', '/root'), ('pw_uid', 0), ('pw_gid', 0)]:
                old = getattr(user, field)
                setattr(user, field, value)
                with self.subTest(field=field), self.assertRaises(ValueError):
                    self.d.check_prepare_state(paths, True, [user], [group])
                setattr(user, field, old)
            group.gr_mem = ['unexpected']
            with self.assertRaises(ValueError):
                self.d.check_prepare_state(paths, True, [user], [group])

    def node_tree(self, root):
        (root / 'bin').mkdir(parents=True)
        (root / 'bin/node').write_bytes(b'official executable')
        (root / 'bin/node').chmod(0o755)
        (root / 'package.json').write_text('{}')
        (root / 'bin/node-link').symlink_to('node')

    def test_resume_node_contents_modes_links_and_owners_must_match_official_tree(self):
        import os
        import shutil
        owner = (os.getuid(), os.getgid())
        with tempfile.TemporaryDirectory() as tmp:
            expected, actual = Path(tmp) / 'official', Path(tmp) / 'installed'
            self.node_tree(expected)
            shutil.copytree(expected, actual, symlinks=True)
            self.d.own_tree(actual, *owner, readonly=True)
            self.d.verify_node_installation(actual, expected, owner)
            with self.assertRaises(ValueError):
                self.d.verify_node_installation(actual, expected, (owner[0] + 1, owner[1]))
            for mutation in ['content', 'mode', 'extra', 'link']:
                actual.chmod(0o755)
                (actual / 'bin').chmod(0o755)
                node = actual / 'bin/node'
                node.chmod(0o755)
                if mutation == 'content':
                    node.write_bytes(b'tampered executable')
                elif mutation == 'extra':
                    (actual / 'extra').write_text('unexpected')
                elif mutation == 'link':
                    (actual / 'bin/node-link').unlink()
                    (actual / 'bin/node-link').symlink_to('/etc/passwd')
                if mutation != 'mode':
                    # Normalize modes so each case isolates its intended mismatch.
                    for p in [actual, actual / 'bin', node]:
                        p.chmod(0o555)
                    if (actual / 'extra').exists():
                        (actual / 'extra').chmod(0o444)
                with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                    self.d.verify_node_installation(actual, expected, owner)
                actual.chmod(0o755)
                (actual / 'bin').chmod(0o755)
                node.chmod(0o755)
                node.write_bytes(b'official executable')
                if (actual / 'extra').exists():
                    (actual / 'extra').unlink()
                if mutation == 'link':
                    (actual / 'bin/node-link').unlink()
                    (actual / 'bin/node-link').symlink_to('node')
                self.d.own_tree(actual, *owner, readonly=True)
            actual.chmod(0o755)
            (actual / 'bin').chmod(0o755)

    def test_prepare_fresh_and_reviewed_resume_validate_before_builder_stage(self):
        import os
        from types import SimpleNamespace
        from unittest.mock import patch
        class BuilderReached(Exception):
            pass
        real_temporary = tempfile.TemporaryDirectory
        real_own_tree = self.d.own_tree
        real_verify = self.d.verify_node_installation
        owner = (os.getuid(), os.getgid())
        for resume in [False, True]:
            with self.subTest(resume=resume), real_temporary() as tmp:
                root = Path(tmp)
                paths = self.d.Paths(root / 'host')
                paths.node.parent.mkdir(parents=True)
                source, digest = self.archive(root)
                user, group = self.expected_account()
                events = []
                if resume:
                    self.node_tree(paths.node)
                    real_own_tree(paths.node, *owner, readonly=True)
                def official_download(work):
                    events.append('official_download_verified')
                    node = work / 'official-node'
                    self.node_tree(node)
                    return node
                def verify(existing, official):
                    real_verify(existing, official, owner)
                    events.append('existing_node_verified')
                def build(*args):
                    events.append('builder')
                    raise BuilderReached()
                def command(args, **kwargs):
                    events.append('useradd' if args[0] == '/absolute/useradd' else 'unexpected_command')
                    return ''
                args = SimpleNamespace(hostname='stage.example.invalid', sha256=digest,
                                       source=source, resume_verified_node=resume)
                with patch.object(self.d, 'Paths', return_value=paths), \
                     patch.object(self.d, 'preflight', return_value={'runuser': '/absolute/runuser', 'useradd': '/absolute/useradd'}), \
                     patch.object(self.d.pwd, 'getpwall', return_value=[user] if resume else []), \
                     patch.object(self.d.grp, 'getgrall', return_value=[group] if resume else []), \
                     patch.object(self.d.pwd, 'getpwnam', return_value=user), \
                     patch.object(self.d, 'check_site_hostname'), patch.object(self.d, 'port_available'), \
                     patch.object(self.d, 'download_node', side_effect=official_download), \
                     patch.object(self.d, 'verify_node_installation', side_effect=verify), \
                     patch.object(self.d, 'build_source', side_effect=build), \
                     patch.object(self.d, 'run', side_effect=command), \
                     patch.object(self.d.os, 'chown'), \
                     patch.object(self.d.os, 'lchown'), \
                     patch.object(self.d, 'own_tree', side_effect=lambda path, uid, gid, readonly=False: real_own_tree(path, *owner, readonly=readonly)), \
                     patch.object(self.d.tempfile, 'TemporaryDirectory', side_effect=lambda **kwargs: real_temporary(dir=root)):
                    with self.assertRaises(BuilderReached):
                        self.d.prepare(args)
                expected = ['official_download_verified', 'existing_node_verified' if resume else 'useradd', 'builder']
                self.assertEqual(events, expected)
                self.assertTrue(paths.node.is_dir())
                self.assertTrue(all(not path.exists() for path in paths.reserved() if path != paths.node))
                # Permit test cleanup only; production never rewrites the existing prefix.
                for parent, dirs, files in os.walk(paths.node):
                    Path(parent).chmod(0o755)

    def test_acme_webroot_is_readable_under_private_umask_and_preserves_existing_permissions(self):
        import os
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'acme'
            previous = os.umask(0o077)
            try:
                self.d.prepare_acme_webroot(path)
                self.assertEqual(path.stat().st_mode & 0o777, 0o755)
                path.chmod(0o750)
                self.d.prepare_acme_webroot(path)
                self.assertEqual(path.stat().st_mode & 0o777, 0o750)
                link = Path(tmp) / 'linked-acme'
                link.symlink_to(path, target_is_directory=True)
                with self.assertRaises(ValueError):
                    self.d.prepare_acme_webroot(link)
            finally:
                os.umask(previous)

    def test_publish_terms_are_checked_before_mutation(self):
        from types import SimpleNamespace
        events = []
        original = self.d.preflight
        self.d.preflight = lambda host: events.append(host)
        try:
            with self.assertRaises(ValueError):
                self.d.publish(SimpleNamespace(confirm_public_access_and_acme_terms=False))
        finally:
            self.d.preflight = original
        self.assertEqual(events, [])
        hook = self.d.renewal_hook('jev.example.com')
        self.assertIn('RENEWED_LINEAGE', hook)
        self.assertIn('/etc/letsencrypt/live/jev.example.com', hook)
        self.assertIn('/usr/sbin/nginx -t && /bin/systemctl reload nginx', hook)


if __name__ == '__main__':
    unittest.main()
