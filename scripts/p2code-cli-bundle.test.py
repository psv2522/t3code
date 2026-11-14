import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('p2code-cli-bundle.py')
ENTITLEMENTS = SCRIPT.parent.parent / 'apps/server/resources/cli-entitlements.plist'
IDENTITY = os.environ.get('P2CODE_SIGN_IDENTITY', '-')


class CliBundleTests(unittest.TestCase):
    def test_versions_share_a_bundle_identity_and_keep_runtime_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            requirements = []
            for version, executable, exit_code in [('1.0.1', '/usr/bin/true', 0),
                                                    ('1.0.2', '/usr/bin/false', 1)]:
                stem = f't3-{version}-darwin-arm64'
                source = root / 'source' / stem
                source.mkdir(parents=True)
                shutil.copy(executable, source / 't3')
                for name in ('client', 'node_modules', 'resource-monitor'):
                    (source / name).mkdir()
                    (source / name / 'fixture').write_text(name)
                (source / 'node_modules/package').symlink_to('fixture')
                archive = root / f'{stem}.tar.gz'
                subprocess.run(['tar', '-czf', str(archive), '-C', str(source.parent), stem],
                               check=True)
                subprocess.run(['python3', str(SCRIPT), '--archive', str(archive),
                                '--version', version, '--identity', IDENTITY,
                                '--entitlements', str(ENTITLEMENTS)], check=True)
                destination = root / version
                destination.mkdir()
                subprocess.run(['tar', '-xzf', str(archive), '-C', str(destination)], check=True)
                runtime = destination / stem
                app = runtime / 'T3 Code Service.app'
                main = app / 'Contents/MacOS/t3'
                self.assertEqual((runtime / 't3').resolve(), main)
                self.assertFalse(main.is_symlink())
                self.assertEqual(subprocess.run([str(runtime / 't3')]).returncode, exit_code)
                with (app / 'Contents/Info.plist').open('rb') as file:
                    info = plistlib.load(file)
                self.assertEqual(info['CFBundleIdentifier'], 'com.t3tools.t3code.service')
                self.assertEqual(info['CFBundleExecutable'], 't3')
                self.assertEqual(info['CFBundleShortVersionString'], version)
                self.assertTrue(info['LSBackgroundOnly'])
                for name in ('client', 'node_modules', 'resource-monitor'):
                    self.assertEqual((runtime / name / 'fixture').read_text(), name)
                    self.assertEqual((main.parent / name / 'fixture').read_text(), name)
                self.assertTrue((runtime / 'node_modules/package').is_symlink())
                subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)],
                               check=True)
                signature = subprocess.run(['codesign', '-dvv', '-r-', str(app)],
                                           check=True, capture_output=True, text=True)
                details = signature.stdout + signature.stderr
                requirement = details.split('designated => ', 1)[1].splitlines()[0].strip()
                self.assertIn('Identifier=com.t3tools.t3code.service', details)
                requirements.append(requirement)
                if IDENTITY != '-':
                    subprocess.run(['codesign', '--verify', '-R', f'={requirements[0]}', str(app)],
                                   check=True)
                (runtime / 'client/fixture').write_text('modified')
                self.assertNotEqual(subprocess.run(
                    ['codesign', '--verify', '--strict', str(app)],
                    capture_output=True).returncode, 0)
            if IDENTITY != '-':
                self.assertEqual(requirements[0], requirements[1])


if __name__ == '__main__':
    unittest.main()
