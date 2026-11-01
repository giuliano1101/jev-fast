"""Read-only native protocol checks; never launches, activates, or inspects app UI."""
import json
import os
import pathlib
import signal
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]

class MacDriverProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='jev-native-driver-')
        cls.binary = pathlib.Path(cls.tmp.name) / 'desktop-macos'
        source = ROOT / 'native/desktop-macos.swift'
        assert source.is_file(), 'native macOS driver is not implemented'
        subprocess.run(['/usr/bin/swiftc', '-parse-as-library', '-module-cache-path', '/private/tmp/jev-swift-module-cache', str(source), '-o', str(cls.binary)], check=True, capture_output=True, text=True)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'tmp'):
            cls.tmp.cleanup()

    def exchange(self, requests):
        result = subprocess.run([str(self.binary)], input=''.join(json.dumps(r)+'\n' for r in requests), capture_output=True, text=True, check=True)
        self.assertEqual(result.stderr, '')
        return [json.loads(line) for line in result.stdout.splitlines()]

    def test_dead_parent_fences_mutation_before_app_resolution(self):
        env = dict(os.environ, JEV_DESKTOP_PARENT_PID='2147483647')
        request = {'id':'fence', 'method':'launch_app', 'params':{'app':'/not/an/app.app'}}
        result = subprocess.run([str(self.binary)], input=json.dumps(request)+'\n', env=env, capture_output=True, text=True, check=True)
        reply = json.loads(result.stdout)
        self.assertEqual(reply['error']['code'], 'PARENT_GONE')
        self.assertEqual(result.stderr, '')

    def test_focus_and_per_post_fencing_without_observing_ui(self):
        binary = pathlib.Path(self.tmp.name) / 'focus-checks'
        subprocess.run(['/usr/bin/swiftc', '-parse-as-library', '-D', 'NATIVE_DESKTOP_TESTING', '-module-cache-path', '/private/tmp/jev-swift-module-cache', str(ROOT/'native/desktop-macos.swift'), str(ROOT/'tests/native/macos_focus_tests.swift'), '-o', str(binary)], check=True, capture_output=True, text=True)
        result = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
        self.assertIn('regression checks passed', result.stdout)

    def test_idle_termination_exits_cooperatively(self):
        for termination_signal in (signal.SIGTERM, signal.SIGINT):
            process = subprocess.Popen([str(self.binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                process.stdin.write(json.dumps({'id':'ready','method':'status','params':{}})+'\n')
                process.stdin.flush()
                self.assertTrue(json.loads(process.stdout.readline())['ok'])
                process.send_signal(termination_signal)
                self.assertEqual(process.wait(timeout=3), 0)
                self.assertEqual(process.stderr.read(), '')
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                process.stdin.close()
                process.stdout.close()
                process.stderr.close()

    def test_status_only_reports_capabilities(self):
        result, = self.exchange([{'id':'s', 'method':'status', 'params':{}}])
        self.assertTrue(result['ok'])
        self.assertEqual(result['result']['platform'], 'macos')
        self.assertEqual(result['result']['app_inventory_scope'], 'running')
        self.assertEqual(result['result']['screenshot_scopes'], ['window', 'display'])
        self.assertIsInstance(result['result']['accessibility'], bool)
        self.assertIsInstance(result['result']['screen_capture'], bool)

    def test_missing_observation_rejects_every_input_before_app_lookup(self):
        methods = ['click','type_text','press_key','set_value','scroll','drag','perform_action']
        replies = self.exchange([{'id':m,'method':m,'params':{'app':99999999,'observation_id':'missing'}} for m in methods])
        self.assertEqual([r['error']['code'] for r in replies], ['STALE_OBSERVATION']*len(methods))

    def test_protocol_errors_do_not_echo_private_input(self):
        replies = self.exchange([
            {'id':'a','method':'arbitrary_script','params':{'secret':'do not echo'}},
            {'id':'b','method':'get_state','params':{}},
            {'id':'c','method':'get_state','params':{'app':99999999}},
        ])
        self.assertEqual([r['error']['code'] for r in replies], ['METHOD_NOT_FOUND','INVALID_PARAMS','APP_NOT_RUNNING'])
        self.assertNotIn('do not echo', json.dumps(replies))

    def test_malformed_line_does_not_kill_following_request(self):
        result = subprocess.run([str(self.binary)], input='not json\n'+json.dumps({'id':'next','method':'status','params':{}})+'\n', capture_output=True, text=True, check=True)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(replies[0]['error']['code'], 'INVALID_REQUEST')
        self.assertEqual(replies[1]['id'], 'next')
        self.assertTrue(replies[1]['ok'])

if __name__ == '__main__':
    unittest.main()
