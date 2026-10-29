#!/usr/bin/env python3
"""Build and validate a small, privately signed T3 Code Nightly APK.

Requires Python 3.12+, git, a JDK (17+), and Android command-line tools.
Downloads the revision's exact Node/pnpm versions into the persistent state directory.

Examples:
  ./scripts/build-android-apk.py --confirm-arm64 'realme P3 Ultra 5G (Dimensity 8350)'
  ./scripts/build-android-apk.py --source . --ref p2code/custom --confirm-arm64 'ARM64 phone'
  ./scripts/build-android-apk.py --tag v0.1.4-nightly.20261028.3824 --abi x86_64

Keep the state directory: it contains your signing identity. A differently signed
APK cannot update an official installation in place. This script never installs
or uninstalls phone apps. Native-library compression saves download bytes; Android
extracts those libraries during installation, so installed storage differs.
"""

import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib
import urllib.request
import zipfile

UPSTREAM = 'https://github.com/pingdotgg/t3code.git'
PACKAGE = 'com.t3tools.t3code.preview'
PROPERTIES = {
    'android.enableShrinkResourcesInReleaseBuilds': 'true',
    'expo.useLegacyPackaging': 'true',
    'android.enableBundleCompression': 'true',
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(args, cwd=None, env=None, capture=False):
    result = subprocess.run([str(x) for x in args], cwd=cwd, env=env,
                            text=True, stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    if result.returncode:
        if capture:
            print(result.stdout, file=sys.stderr)
            print(result.stderr, file=sys.stderr)
        raise RuntimeError(f'{Path(str(args[0])).name} failed ({result.returncode})')
    return result.stdout.strip() if capture else ''


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def file_sha(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, data):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, indent=2) + '\n')
    temporary.replace(path)


def version_key(tag):
    match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)-nightly\.(\d+(?:\.\d+)*)', tag)
    require(match, f'Unexpected nightly tag: {tag}')
    return tuple(int(x) for x in re.findall(r'\d+', tag))


def checkout_source(args, checkout):
    if Path(args.source) == checkout:
        require(args.ref, 'Building in place needs --ref')
        require(not run(['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=checkout, capture=True),
                'Build checkout has changes; preserve/commit them before building')
        sha = run(['git', 'rev-parse', '--verify', f'{args.ref}^{{commit}}'], cwd=checkout, capture=True)
        require(run(['git', 'rev-parse', 'HEAD'], cwd=checkout, capture=True) == sha,
                f'Check out {args.ref} before building in place')
        return {'repository': args.source, 'revision': args.ref, 'tag': None, 'sha': sha}
    if not (checkout / '.git').exists():
        require(not checkout.exists() or not any(checkout.iterdir()), 'Checkout directory is not empty')
        run(['git', 'clone', '--no-checkout', '--no-tags', '--filter=blob:none', args.source, checkout])
    head = run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=checkout, capture=True)
    # A new --no-checkout clone has an empty index; no source files exist yet.
    populated = (checkout / 'package.json').exists()
    if populated:
        require(not run(['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=checkout, capture=True),
                'Build checkout has changes; preserve/commit them before building')
    if args.ref:
        run(['git', 'fetch', '--no-tags', args.source, args.ref], cwd=checkout)
        sha = run(['git', 'rev-parse', 'FETCH_HEAD^{commit}'], cwd=checkout, capture=True)
        source_tag = None
        revision = args.ref
    else:
        if args.tag:
            version_key(args.tag)
            source_tag = args.tag
        else:
            remote = run(['git', 'ls-remote', '--tags', '--refs', args.source, 'v*-nightly.*'], capture=True)
            tags = [row.split('refs/tags/', 1)[1] for row in remote.splitlines()]
            require(tags, 'No upstream nightly tags found')
            source_tag = max(tags, key=version_key)
        # Fetch only the selected versioned tag, never the moving android-nightly tag.
        run(['git', 'fetch', '--no-tags', args.source,
             f'refs/tags/{source_tag}:refs/tags/{source_tag}'], cwd=checkout)
        sha = run(['git', 'rev-parse', f'{source_tag}^{{commit}}'], cwd=checkout, capture=True)
        revision = source_tag
    if head != sha or not populated:
        run(['git', 'checkout', '--detach', sha], cwd=checkout)
    return {'repository': args.source, 'revision': revision, 'tag': source_tag, 'sha': sha}


def pinned_tools(checkout, state, env):
    package = json.loads((checkout / 'package.json').read_text())
    node_version = package['engines']['node']
    require(re.fullmatch(r'\d+\.\d+\.\d+', node_version), 'engines.node must be exact')
    manager = package['packageManager']
    match = re.fullmatch(r'pnpm@(\d+\.\d+\.\d+)(?:\+.+)?', manager)
    require(match, f'Unsupported packageManager: {manager}')
    pnpm_version = match[1]
    system = {'Darwin': 'darwin', 'Linux': 'linux'}.get(platform.system())
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64'}.get(platform.machine())
    require(system and arch, 'Supported hosts: native macOS/Linux arm64 or x64')
    node_dir = state / 'tools' / f'node-v{node_version}-{system}-{arch}'
    if not (node_dir / 'bin/node').exists():
        node_dir.parent.mkdir(parents=True, exist_ok=True)
        filename = node_dir.name + '.tar.gz'
        with tempfile.TemporaryDirectory(dir=node_dir.parent) as temp:
            archive = Path(temp) / filename
            base = f'https://nodejs.org/dist/v{node_version}/'
            urllib.request.urlretrieve(base + filename, archive)
            checksums = urllib.request.urlopen(base + 'SHASUMS256.txt').read().decode()
            expected = next(row.split()[0] for row in checksums.splitlines() if row.endswith('  ' + filename))
            require(file_sha(archive) == expected, 'Node checksum mismatch')
            with tarfile.open(archive) as bundle:
                bundle.extractall(temp, filter='data')
            shutil.move(str(Path(temp) / node_dir.name), node_dir)
    pnpm_dir = state / 'tools' / f'pnpm-{pnpm_version}'
    env['PATH'] = str(node_dir / 'bin') + os.pathsep + env['PATH']
    pnpm = pnpm_dir / 'node_modules/.bin/pnpm'
    if not pnpm.exists():
        run([node_dir / 'bin/npm', 'install', '--prefix', pnpm_dir,
             '--no-audit', '--no-fund', f'pnpm@{pnpm_version}'], env=env)
    with open(pnpm, 'rb') as stream:
        placeholder = stream.read(16).startswith(b'# pnpm')
    if placeholder:
        run([node_dir / 'bin/npm', 'rebuild', '--prefix', pnpm_dir, 'pnpm'], env=env)
    env['PATH'] = str(pnpm.parent) + os.pathsep + env['PATH']
    require(run(['node', '--version'], env=env, capture=True) == 'v' + node_version, 'Wrong Node version')
    require(run([pnpm, '--version'], env=env, capture=True) == pnpm_version, 'Wrong pnpm version')
    return pnpm, {'node': node_version, 'pnpm': pnpm_version}


def fill_public_env(checkout):
    path = checkout / '.env'
    existing = path.read_text() if path.exists() else ''
    keys = set(re.findall(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=', existing, re.M))
    aliases = {
        'T3CODE_CLERK_PUBLISHABLE_KEY': {'VITE_CLERK_PUBLISHABLE_KEY', 'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY'},
        'T3CODE_CLERK_JWT_TEMPLATE': {'VITE_CLERK_JWT_TEMPLATE', 'EXPO_PUBLIC_CLERK_JWT_TEMPLATE'},
        'T3CODE_CLERK_CLI_OAUTH_CLIENT_ID': {'VITE_CLERK_CLI_OAUTH_CLIENT_ID'},
        'T3CODE_RELAY_URL': {'VITE_T3CODE_RELAY_URL'},
    }
    additions = []
    for line in (checkout / '.env.example').read_text().splitlines():
        key, separator, _ = line.partition('=')
        if separator and key in aliases and not ({key} | aliases[key]) & keys:
            additions.append(line)
    if additions:
        path.write_text(existing + '\n' + '\n'.join(additions) + '\n')
    os.chmod(path, 0o600)


@contextlib.contextmanager
def native_cache_backup(android, state):
    backup = state / 'native-cache-backup'
    backup.mkdir(exist_ok=True)
    pairs = [('gradle', android / '.gradle'), ('cxx', android / 'app/.cxx')]
    # Also recover caches left by a killed previous prebuild.
    for name, destination in pairs:
        source = backup / name
        if source.exists():
            require(not destination.exists(), f'Ambiguous cache recovery: {source} and {destination}')
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), destination)
    for name, source in pairs:
        if source.exists():
            shutil.move(str(source), backup / name)
    try:
        yield
    finally:
        for name, destination in pairs:
            source = backup / name
            if source.exists():
                if destination.exists():
                    shutil.rmtree(destination)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(source), destination)
        backup.rmdir()


def validate_config(config):
    extra = config.get('extra', {})
    require(extra.get('appVariant') == 'preview', 'Embedded config is not preview')
    require(config.get('name') == 'T3 Code Preview', 'Unexpected preview branding')
    require(config.get('android', {}).get('package') == PACKAGE, 'Wrong Android package')
    require('nightly' in config.get('icon', '').lower(), 'Nightly icon is missing')
    clerk = extra.get('clerk', {})
    relay = extra.get('relay', {}).get('url')
    require((clerk.get('publishableKey') or '').startswith('pk_') and clerk.get('jwtTemplate') and relay,
            'T3 Connect sign-in is disabled; check existing .env overrides')
    return {'enabled': True, 'relay': relay, 'publishableKey': clerk['publishableKey'],
            'jwtTemplate': clerk['jwtTemplate']}


def signing_identity(state, env):
    signing = state / 'signing'
    signing.mkdir(mode=0o700, exist_ok=True)
    os.chmod(signing, 0o700)
    password = signing / 'password'
    key = signing / 'nightly.p12'
    require(not key.exists() or password.exists(), 'Existing signing key is missing its password file')
    if not password.exists():
        with open(password, 'x', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            stream.write(secrets.token_urlsafe(36))
    os.chmod(password, 0o600)
    env['T3_APK_SIGNING_PASSWORD'] = password.read_text().strip()
    if not key.exists():
        run(['keytool', '-genkeypair', '-keystore', key, '-storetype', 'PKCS12',
             '-alias', 'nightly', '-storepass:env', 'T3_APK_SIGNING_PASSWORD',
             '-keypass:env', 'T3_APK_SIGNING_PASSWORD', '-keyalg', 'RSA', '-keysize', '3072',
             '-validity', '10000', '-dname', 'CN=T3 Code Personal Nightly'], env=env)
    os.chmod(key, 0o600)
    cert = subprocess.run(['keytool', '-exportcert', '-keystore', str(key), '-alias', 'nightly',
                           '-storepass:env', 'T3_APK_SIGNING_PASSWORD'], env=env, capture_output=True, check=True).stdout
    fingerprint = hashlib.sha256(cert).hexdigest()
    pin = signing / 'certificate.sha256'
    if pin.exists():
        require(pin.read_text().strip() == fingerprint, 'Persistent signing certificate changed')
    else:
        pin.write_text(fingerprint + '\n')
    return key, fingerprint


def prepare_gradle_distribution(android, gradle_home):
    properties = dict(line.split('=', 1) for line in
                      (android / 'gradle/wrapper/gradle-wrapper.properties').read_text().splitlines()
                      if '=' in line and not line.startswith('#'))
    url = properties['distributionUrl'].replace('\\:', ':')
    require(url.startswith('https://services.gradle.org/distributions/'),
            'Unexpected Gradle distribution origin; review it before building')
    filename = url.rsplit('/', 1)[1]
    value = int(hashlib.md5(url.encode()).hexdigest(), 16)
    key = ''
    while value:
        value, remainder = divmod(value, 36)
        key = '0123456789abcdefghijklmnopqrstuvwxyz'[remainder] + key
    directory = gradle_home / 'wrapper/dists' / filename.removesuffix('.zip') / key
    if (directory / (filename + '.ok')).exists():
        return
    directory.mkdir(parents=True, exist_ok=True)
    expected = properties.get('distributionSha256Sum') or urllib.request.urlopen(
        url + '.sha256', timeout=120).read().decode().strip().split()[0]
    archive = directory / filename
    if not archive.exists() or file_sha(archive) != expected:
        print('Downloading and verifying the pinned Gradle wrapper distribution', flush=True)
        temporary = archive.with_suffix('.download')
        with urllib.request.urlopen(url, timeout=120) as response, open(temporary, 'wb') as target:
            shutil.copyfileobj(response, target)
        require(file_sha(temporary) == expected, 'Gradle distribution checksum mismatch')
        temporary.replace(archive)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', default=UPSTREAM, help='Git URL or local repository')
    revision = parser.add_mutually_exclusive_group()
    revision.add_argument('--tag', help='Explicit upstream versioned nightly tag')
    revision.add_argument('--ref', help='Branch/ref from --source (builds its committed HEAD)')
    parser.add_argument('--checkout', type=Path,
                        help='Default: the local --source when --ref is given (build in place), else <state-dir>/checkout')
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.cache/t3-android')
    parser.add_argument('--output', type=Path, help='Default: <state-dir>/apks')
    parser.add_argument('--abi', default='arm64-v8a', help='Comma-separated RN Android ABIs')
    parser.add_argument('--confirm-arm64', help='Phone model / evidence of ARM64 support (required for ARM64-only)')
    parser.add_argument('--sdk', type=Path, help='Android SDK; otherwise ANDROID_HOME/ANDROID_SDK_ROOT')
    parser.add_argument('--java-home', type=Path, help='JDK 17+ location')
    args = parser.parse_args()
    require(platform.system() in ('Darwin', 'Linux'), 'Use native macOS/Linux. WSL requires separate approval.')
    if platform.system() == 'Linux':
        require('microsoft' not in platform.release().lower(), 'WSL is not enabled by this script')
    abis = args.abi.split(',')
    require(len(set(abis)) == len(abis) and set(abis) <= {'arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'}, 'Invalid ABI list')
    require(args.abi != 'arm64-v8a' or args.confirm_arm64, 'Confirm the phone supports ARM64 with --confirm-arm64')
    started = time.monotonic()
    builder_sha = file_sha(Path(__file__))
    memory_bytes = os.sysconf('SC_PHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
    print(f'Host RAM: {memory_bytes / 2**30:.1f} GiB; Gradle: 2 workers, 3 GiB heap', flush=True)
    if memory_bytes < 16 * 2**30:
        print('Warning: builds can approach 12–14 GiB total memory; avoid competing workloads', flush=True)
    state = args.state_dir.expanduser().resolve()
    state.mkdir(parents=True, exist_ok=True)
    local = Path(args.source).exists()
    if local:
        args.source = str(Path(args.source).resolve())
    checkout = (args.checkout or (Path(args.source) if local and args.ref else state / 'checkout')).expanduser().resolve()
    lock = open(state / 'build.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('Another APK build is running in this state directory')
    env = dict(os.environ, APP_VARIANT='preview', NODE_ENV='production', CI='1',
               EXPO_NO_GIT_STATUS='1')
    if args.java_home:
        env['JAVA_HOME'] = str(args.java_home.resolve())
    if env.get('JAVA_HOME'):
        env['PATH'] = str(Path(env['JAVA_HOME']) / 'bin') + os.pathsep + env['PATH']
    java = subprocess.run(
        ['java', '-version'], env=env, capture_output=True, text=True, check=True).stderr.strip()
    require(re.search(r'version "(\d+)', java) and int(re.search(r'version "(\d+)', java)[1]) >= 17,
            'JDK 17 or later is required')
    sdk_value = args.sdk or env.get('ANDROID_HOME') or env.get('ANDROID_SDK_ROOT')
    require(sdk_value, 'Set --sdk or ANDROID_HOME to an installed Android SDK')
    sdk = Path(sdk_value).expanduser().resolve()
    env['ANDROID_HOME'] = env['ANDROID_SDK_ROOT'] = str(sdk)
    env['GRADLE_USER_HOME'] = str(state / 'gradle')
    sdkmanager = sdk / 'cmdline-tools/latest/bin/sdkmanager'
    require(sdkmanager.exists(), f'Missing {sdkmanager}; install Android command-line tools')
    source = checkout_source(args, checkout)
    print(f"Source: {source['revision']} @ {source['sha']}", flush=True)
    pnpm, versions = pinned_tools(checkout, state, env)
    versions['java'] = java
    fill_public_env(checkout)
    mobile = checkout / 'apps/mobile'
    android = mobile / 'android'
    stamp = state / 'installed-revision.json'
    installed = json.loads(stamp.read_text()) if stamp.exists() else {}
    if installed.get('sha') != source['sha'] or not (mobile / 'node_modules').exists():
        run([pnpm, 'install', '--filter=@t3tools/mobile...', '--frozen-lockfile'], cwd=checkout, env=env)
        write_json(stamp, {'sha': source['sha'], **versions})
    requirements = tomllib.loads((mobile / 'node_modules/react-native/gradle/libs.versions.toml').read_text())['versions']
    requirements = {k: requirements[k] for k in ['compileSdk', 'buildTools', 'ndkVersion', 'agp']}
    requirements['cmake'] = env.get('CMAKE_VERSION', '3.22.1')
    platform_package = 'android-' + requirements['compileSdk']
    if requirements['compileSdk'] == '37':
        platform_package += '.0'
    sdk_packages = ['platforms;' + platform_package, 'build-tools;' + requirements['buildTools'],
                    'ndk;' + requirements['ndkVersion'], 'cmake;' + requirements['cmake']]
    if any(not (sdk.joinpath(*package.split(';')) / 'source.properties').exists() for package in sdk_packages):
        run([sdkmanager, *sdk_packages], env=env)
    sdk_identity = {package: file_sha(sdk.joinpath(*package.split(';')) / 'source.properties')
                    for package in sdk_packages}
    tools = sdk / 'build-tools' / requirements['buildTools']
    instructions = {str(p.relative_to(checkout)): file_sha(p) for p in
                    [mobile / 'README.md', checkout / 'docs/operations/development.md'] if p.exists()}
    native_stamp = state / 'native-fingerprint.json'
    previous = json.loads(native_stamp.read_text()) if native_stamp.exists() else {}
    env_files = {str(p.relative_to(checkout)): file_sha(p) for root in [checkout, mobile]
                 for p in root.glob('.env*') if p.is_file()}
    transient = {'TMPDIR', 'TMP', 'TEMP', 'PWD', 'OLDPWD', 'SHLVL', '_',
                 'TERM_SESSION_ID', 'SSH_AUTH_SOCK', 'FNM_MULTISHELL_PATH'}
    stable_env = {k: v for k, v in env.items() if k not in transient and not k.startswith(
        ('CODEX_', 'XPC_', 'T3_BOOT_', 'T3_SERVICE_'))}
    fingerprint = digest({'source': source, 'env': stable_env, 'envFiles': env_files,
                          'tools': versions, 'sdk': str(sdk), 'sdkIdentity': sdk_identity, 'script': builder_sha, 'abi': args.abi})
    native_valid = (android / 'app/build.gradle').exists() and re.search(
        r'applicationId\s+[\'"]' + re.escape(PACKAGE) + r'[\'"]', (android / 'app/build.gradle').read_text())
    regenerate = previous.get('fingerprint') != fingerprint or not native_valid
    cache_state = 'warm caches present' if (state / 'gradle/caches').exists() else 'cold Gradle compilation caches'
    with tempfile.TemporaryDirectory(prefix='metro-', dir=state) as metro_tmp:
        env['TMPDIR'] = env['TMP'] = env['TEMP'] = metro_tmp
        if regenerate:
            print('Regenerating native Android project; preserving .gradle and .cxx only', flush=True)
            with native_cache_backup(android, state):
                for output in [android / 'build', android / 'app/build']:
                    if output.exists():
                        shutil.rmtree(output)
                run([pnpm, 'exec', 'expo', 'prebuild', '--clean', '--platform', 'android', '--no-install'], cwd=mobile, env=env)
            write_json(native_stamp, {'fingerprint': fingerprint})
        else:
            print('Unchanged native inputs: skipping prebuild', flush=True)
        gradle = (android / 'app/build.gradle').read_text()
        require(re.search(r'applicationId\s+[\'"]' + re.escape(PACKAGE) + r'[\'"]', gradle), 'Wrong generated applicationId')
        for prop in PROPERTIES:
            require(prop in gradle, f'Upstream generated app does not honor {prop}')
        require('enableMinifyInReleaseBuilds' in gradle, 'Upstream release minification wiring changed')
        require(re.search(r'enableBundleCompression\s*=.*android\.enableBundleCompression', gradle),
                'Hermes compression wiring changed')
        config = json.loads(run([pnpm, 'exec', 'expo', 'config', '--type', 'public', '--json'], cwd=mobile, env=env, capture=True))
        cloud = validate_config(config)
        prepare_gradle_distribution(android, state / 'gradle')
        signing_env = env.copy()
        key, certificate = signing_identity(state, signing_env)
        gradle_args = ['./gradlew', ':app:assembleRelease', f'-PreactNativeArchitectures={args.abi}',
                       '--build-cache', '--max-workers=2', '--no-daemon', '--no-configuration-cache',
                       '-Dorg.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=768m',
                       '-Pkotlin.compiler.execution.strategy=in-process',
                       *[f'-P{k}={v}' for k, v in PROPERTIES.items()], '--console=plain']
        build_started = time.monotonic()
        run(gradle_args, cwd=android, env=env)
        gradle_seconds = time.monotonic() - build_started
        candidates = list((android / 'app/build/outputs/apk/release').glob('*.apk'))
        require(len(candidates) == 1, f'Expected one release APK, found {len(candidates)}')
        output = (args.output or state / 'apks').expanduser().resolve()
        output.mkdir(parents=True, exist_ok=True)
        name = f"t3code-nightly-{source['sha'][:12]}-{args.abi.replace(',', '_')}-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"
        apk = output / (name + '.apk')
        aligned = Path(metro_tmp) / 'aligned.apk'
        run([tools / 'zipalign', '-P', '16', '-f', '4', candidates[0], aligned], env=env)
        run([tools / 'apksigner', 'sign', '--v4-signing-enabled', 'false', '--ks', key, '--ks-key-alias', 'nightly',
             '--ks-pass', 'env:T3_APK_SIGNING_PASSWORD', '--key-pass', 'env:T3_APK_SIGNING_PASSWORD',
             '--out', apk, aligned], env=signing_env)
        signature = run([tools / 'apksigner', 'verify', '--verbose', '--print-certs', apk], env=env, capture=True)
        fingerprints = re.findall(r'certificate SHA-256 digest: ([a-fA-F0-9]+)', signature)
        require(fingerprints == [certificate], 'APK signer differs from persistent certificate')
        run([tools / 'zipalign', '-c', '-P', '16', '4', apk], env=env)
        badging = run([tools / 'aapt', 'dump', 'badging', apk], env=env, capture=True)
        require(f"package: name='{PACKAGE}'" in badging, 'APK package mismatch')
        activity = re.search(r"launchable-activity: name='([^']+)'", badging)
        require(activity, 'No launchable activity')
        with zipfile.ZipFile(apk) as bundle:
            info = bundle.getinfo('assets/index.android.bundle')
            require(info.compress_type == zipfile.ZIP_DEFLATED and info.file_size > 0, 'Hermes bundle is not compressed')
            libraries = [entry for entry in bundle.infolist() if entry.filename.startswith('lib/') and entry.filename.endswith('.so')]
            require(libraries, 'APK has no native libraries')
            require(all(entry.compress_type == zipfile.ZIP_DEFLATED for entry in bundle.infolist()
                        if entry.filename.endswith('.so')), 'Some native libraries are not compressed')
            require({entry.filename.split('/')[1] for entry in libraries} == set(abis), 'APK contains unexpected ABIs')
            embedded = json.loads(bundle.read('assets/app.config'))
            require(validate_config(embedded) == cloud, 'Embedded sign-in configuration differs from Expo config')
        version = re.search(r"versionName='([^']+)'", badging)[1]
        version_code = re.search(r"versionCode='([^']+)'", badging)[1]
        versions['gradle'] = run(['./gradlew', '--version', '--no-daemon'], cwd=android, env=env, capture=True)
        versions['sdkPackages'] = run([sdkmanager, '--list_installed'], env=env, capture=True)
        versions['jdkToolchains'] = {str(p.relative_to(state / 'gradle/jdks')): p.read_text()
                                     for p in (state / 'gradle/jdks').rglob('release')}
        receipt = {'source': source, 'builderSha256': builder_sha,
                   'tools': versions, 'instructions': instructions,
                   'nativeRequirements': requirements, 'package': PACKAGE, 'version': version,
                   'versionCode': version_code, 'launchableActivity': activity[1], 'abis': abis,
                   'abiEvidence': args.confirm_arm64, 'certificateSha256': certificate,
                   'cloud': cloud, 'bytes': apk.stat().st_size, 'sha256': file_sha(apk),
                   'sizeSettings': PROPERTIES, 'nativeLibraries': len(libraries),
                   'upstreamMinificationPreserved': True, 'cacheState': cache_state,
                   'hostMemoryBytes': memory_bytes, 'prebuildRegenerated': bool(regenerate), 'gradleSeconds': round(gradle_seconds, 2),
                   'totalSeconds': round(time.monotonic() - started, 2),
                   'validation': {'signature': True, 'certificate': True, 'package': True,
                                  'launchableActivity': True, 'abi': True, 'embeddedPreview': True,
                                  'cloudConfig': True, 'zipalign16KiB': True,
                                  'hermesBundleDeflated': True, 'allNativeLibrariesDeflated': True},
                   'phoneInstallation': 'unverified'}
        receipts = state / 'receipts'
        receipts.mkdir(exist_ok=True)
        receipt_path = receipts / (name + '.receipt.json')
        write_json(receipt_path, receipt)
        print(f"APK: {apk}\nReceipt: {receipt_path}\n"
              f"Bytes: {apk.stat().st_size}\nDuration: {receipt['totalSeconds']}s total; "
              f"{receipt['gradleSeconds']}s Gradle ({cache_state})", flush=True)


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError, ValueError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
