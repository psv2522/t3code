import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'scripts/p2code-update.sh'


class StatusTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.out = self.home / 'out'
        self.env = {**os.environ, 'HOME': str(self.home), 'P2CODE_OUT': str(self.out)}

    def status(self):
        return json.loads(subprocess.check_output([SCRIPT, '--status'], env=self.env, text=True))

    def write_status(self, phase):
        path = self.out / 'run/update-status.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'phase': phase, 'updatedAt': 1}, separators=(',', ':')))

    def test_idle_and_dead_job(self):
        self.assertEqual(self.status()['phase'], 'idle')
        self.write_status('syncing')
        (self.out / 'update.lock').write_text('99999999')
        self.assertEqual(self.status()['phase'], 'failed')

    def test_conflict_statuses(self):
        self.write_status('conflict')
        (self.out / 'run/conflict-thread').write_text('thread')
        t3 = self.home / '.local/bin/t3'
        t3.parent.mkdir(parents=True)
        t3.write_text('#!/bin/sh\n[ "$4" = "--json" ] || exit 1\nprintf "%s\\n" "$FAKE_THREAD_JSON"\n')
        t3.chmod(0o755)
        for state in ('preparing', 'queued', 'starting', 'running', 'waiting', 'completed', 'failed'):
            with self.subTest(state=state):
                (self.out / 'run/conflict-thread.status-cache').unlink(missing_ok=True)
                self.env['FAKE_THREAD_JSON'] = json.dumps({'thread': {'status': state}})
                self.assertEqual(self.status()['phase'], 'conflict' if state in (
                    'preparing', 'queued', 'starting', 'running', 'waiting') else 'failed')

        t3.write_text('#!/bin/sh\necho call >> "$HOME/thread-calls"\nprintf "%s\\n" "$FAKE_THREAD_JSON"\n')
        bin_dir = self.home / 'bin'
        bin_dir.mkdir()
        date = bin_dir / 'date'
        date.write_text('#!/bin/sh\necho "$FAKE_NOW"\n')
        date.chmod(0o755)
        self.env['PATH'] = str(bin_dir) + os.pathsep + self.env['PATH']
        self.env['FAKE_THREAD_JSON'] = json.dumps({'thread': {'status': 'running'}})
        self.env['FAKE_NOW'] = '100'
        self.assertEqual(self.status()['phase'], 'conflict')
        self.assertFalse((self.home / 'thread-calls').exists())
        self.env['FAKE_NOW'] = '1000'
        self.assertEqual(self.status()['phase'], 'conflict')
        self.assertEqual(self.status()['phase'], 'conflict')
        self.assertEqual((self.home / 'thread-calls').read_text().splitlines(), ['call'])
        self.env['FAKE_THREAD_JSON'] = json.dumps({'thread': {'status': 'completed'}})
        self.env['FAKE_NOW'] = '1030'
        self.assertEqual(self.status()['phase'], 'failed')
        self.assertEqual((self.home / 'thread-calls').read_text().splitlines(), ['call', 'call'])

    def test_detached_lock_failure_removes_job(self):
        self.out.mkdir(parents=True)
        (self.out / 'update.lock').write_text(str(os.getpid()))
        bin_dir = self.home / 'bin'
        bin_dir.mkdir()
        launchctl = bin_dir / 'launchctl'
        launchctl.write_text('#!/bin/sh\nprintf "%s\n" "$*" > "$HOME/launchctl-call"\n')
        launchctl.chmod(0o755)
        self.env['PATH'] = str(bin_dir) + os.pathsep + self.env['PATH']
        result = subprocess.run([SCRIPT, '--detached'], env=self.env, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already running', result.stderr)
        self.assertEqual((self.home / 'launchctl-call').read_text().strip(), 'remove com.p2code.update')

    def test_json_string(self):
        value = 'quote " slash \\ newline\n tab\t'
        output = subprocess.check_output(['bash', '-c', 'source "$1"; json_string "$2"',
                                          '_', str(ROOT / 'scripts/p2code-lib.sh'), value],
                                         env=self.env, text=True)
        self.assertEqual(json.loads(output), value)


if __name__ == '__main__':
    unittest.main()
