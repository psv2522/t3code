import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile


def bundle_archive(archive, version, identity, entitlements):
    archive = archive.resolve()
    stem = archive.name.removesuffix('.tar.gz')
    with tempfile.TemporaryDirectory(prefix='.p2code-cli-', dir=archive.parent) as temp:
        work = Path(temp)
        subprocess.run(['tar', '-xzf', str(archive), '-C', str(work)], check=True)
        runtime = work / stem
        entries = list(runtime.iterdir())
        app = runtime / 'T3 Code Service.app'
        macos = app / 'Contents/MacOS'
        resources = app / 'Contents/Resources'
        macos.mkdir(parents=True)
        resources.mkdir()
        for entry in entries:
            if entry.name == 't3':
                entry.rename(macos / entry.name)
                entry.symlink_to(f'{app.name}/Contents/MacOS/t3')
            else:
                entry.rename(resources / entry.name)
                entry.symlink_to(f'{app.name}/Contents/Resources/{entry.name}')
                (macos / entry.name).symlink_to(f'../Resources/{entry.name}')
        with (app / 'Contents/Info.plist').open('wb') as file:
            plistlib.dump({
                'CFBundleIdentifier': 'com.t3tools.t3code.service',
                'CFBundleName': 'T3 Code Service',
                'CFBundleExecutable': 't3',
                'CFBundlePackageType': 'APPL',
                'CFBundleInfoDictionaryVersion': '6.0',
                'CFBundleVersion': version,
                'CFBundleShortVersionString': version,
                'LSBackgroundOnly': True,
            }, file)
        subprocess.run(['codesign', '--force', '--timestamp=none', '--sign', identity,
                        '--entitlements', str(entitlements), str(app)], check=True)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        output = work / 'bundled.tar.gz'
        subprocess.run(['tar', '-czf', str(output), '-C', str(work), stem], check=True)
        os.replace(output, archive)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--identity', required=True)
    parser.add_argument('--entitlements', type=Path, required=True)
    args = parser.parse_args()
    bundle_archive(args.archive, args.version, args.identity, args.entitlements)
