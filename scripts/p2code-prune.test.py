import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class PruneNodeTests(unittest.TestCase):
    def test_failed_node_build_removes_only_its_own_work_directory(self):
        repo = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'p2code'
            other = output / 'node-pc/src.other'
            other.mkdir(parents=True)
            fake_bin = root / 'bin'
            fake_bin.mkdir()
            for name, body in {'brew': 'echo /tmp', 'pkg-config': 'echo 1', 'curl': 'exit 1'}.items():
                executable = fake_bin / name
                executable.write_text('#!/bin/sh\n' + body + '\n')
                executable.chmod(0o755)
            env = {**os.environ, 'P2CODE_OUT': str(output),
                   'PATH': str(fake_bin) + os.pathsep + os.environ['PATH']}
            result = subprocess.run(['bash', str(repo / 'scripts/p2code.sh'), 'build-node'],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Downloading source', result.stdout)
            self.assertEqual(list((output / 'node-pc').iterdir()), [other])

    def test_prunes_old_versions_but_keeps_current_recent_and_build_sources(self):
        repo = Path(__file__).resolve().parent.parent
        current = json.loads((repo / 'package.json').read_text())['engines']['node']
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'p2code'
            (output / 'backups').mkdir(parents=True)
            service_state = root / 't3/runtime/service-state.json'
            service_state.parent.mkdir(parents=True)
            service_state.write_text('{"activeVersion":"test"}')
            versions = output / 'node-pc-system-icu'
            for name, timestamp in [('v1.0.0', 1), ('v2.0.0', 2), ('v3.0.0', 3), (f'v{current}', 0)]:
                directory = versions / name
                directory.mkdir(parents=True)
                os.utime(directory, (timestamp, timestamp))
            source = output / 'node-pc/src.active'
            source.mkdir(parents=True)
            fake_bin = root / 'bin'
            fake_bin.mkdir()
            (fake_bin / 'ps').write_text('#!/bin/sh\nexit 0\n')
            (fake_bin / 'ps').chmod(0o755)
            env = {**os.environ, 'P2CODE_OUT': str(output), 'T3CODE_HOME': str(root / 't3'),
                   'PATH': str(fake_bin) + os.pathsep + os.environ['PATH']}
            command = ['bash', str(repo / 'scripts/p2code.sh'), 'prune']
            result = subprocess.run([*command, '--yes'], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse((versions / 'v1.0.0').exists())
            for name in ('v2.0.0', 'v3.0.0', f'v{current}'):
                self.assertTrue((versions / name).exists())
            self.assertTrue(source.exists())


if __name__ == '__main__':
    unittest.main()
