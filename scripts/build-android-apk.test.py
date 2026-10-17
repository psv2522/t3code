"""Focused tests for cache recovery, revision selection and embedded configuration."""
import importlib.util
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build-android-apk.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuilderTests(unittest.TestCase):
    def test_publishes_before_pruning_only_older_managed_apks_and_their_signatures(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            cache = directory / 'apks'
            cache.mkdir()
            source = directory / 'validated.apk'
            source.write_text('new artifact')
            old = cache / 't3code-nightly-old-arm64-20261101-010101.apk'
            latest = cache / 't3code-nightly-new-arm64-20261102-010101.apk'
            unrelated = cache / 'other.apk'
            for path in (old, unrelated, cache / (old.name + '.idsig')):
                path.write_text('artifact')
            with patch.object(builder.os, 'replace', side_effect=OSError('disk full')):
                with self.assertRaisesRegex(OSError, 'disk full'):
                    builder.publish_apk(source, latest, cache)
            self.assertEqual(old.read_text(), 'artifact')
            self.assertFalse(latest.exists())
            self.assertFalse(list(cache.glob('.t3code-apk-*')))
            builder.publish_apk(source, latest, cache)
            self.assertEqual(latest.read_text(), 'new artifact')
            self.assertEqual(sorted(path.name for path in cache.iterdir()),
                             sorted([latest.name, unrelated.name]))

            exported = directory / 'exports'
            exported.mkdir()
            (exported / old.name).write_text('keep')
            builder.publish_apk(source, exported / latest.name, cache)
            self.assertTrue((exported / old.name).exists())

    def test_taildrop_retains_one_apk_only_when_transfer_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cache = root / 'apks'
            cache.mkdir()
            for error in (None, RuntimeError('transfer failed')):
                signed = root / 'signed.apk'
                gradle = root / 'app-release.apk'
                destination = cache / 't3code-nightly-new.apk'
                old = cache / 't3code-nightly-old.apk'
                for path in (signed, gradle, old):
                    path.write_text('artifact')
                def transfer(args, **kwargs):
                    self.assertEqual(args, ['tailscale', 'file', 'cp', destination, 'phone:'])
                    self.assertTrue(destination.exists())
                    if error:
                        raise error
                with patch.object(builder, 'run', side_effect=transfer):
                    if error:
                        with self.assertRaisesRegex(RuntimeError, 'transfer failed'):
                            builder.send_apk(signed, gradle, destination, cache, 'phone:')
                    else:
                        builder.send_apk(signed, gradle, destination, cache, 'phone:')
                self.assertEqual(destination.exists(), error is not None)
                self.assertFalse(gradle.exists())
                self.assertFalse(signed.exists())
                self.assertFalse(old.exists())

    def test_native_environment_ignores_sessions_and_keeps_build_inputs(self):
        env = {'CLAUDE_CODE_SESSION_ID': 'one', 'T3CODE_THREAD_ID': 'thread',
               'EXPO_PUBLIC_KEY': 'key', 'T3CODE_RELAY_URL': 'relay',
               'ANDROID_HOME': '/sdk', 'JAVA_HOME': '/java', 'APP_VARIANT': 'preview'}
        selected = builder.native_environment(env)
        self.assertEqual(selected, {key: env[key] for key in (
            'EXPO_PUBLIC_KEY', 'T3CODE_RELAY_URL', 'ANDROID_HOME', 'JAVA_HOME', 'APP_VARIANT')})
        self.assertEqual(selected, builder.native_environment({**env, 'CLAUDE_CODE_SESSION_ID': 'two'}))
        self.assertNotEqual(selected, builder.native_environment({**env, 'T3CODE_RELAY_URL': 'other'}))

    def test_native_fingerprint_uses_expo_android_inputs(self):
        with patch.object(builder, 'run', return_value='T3_NATIVE_FINGERPRINT=' + 'a' * 40) as run:
            self.assertEqual(builder.native_fingerprint(Path('/mobile'), {}), 'a' * 40)
            args, kwargs = run.call_args
            self.assertEqual(args[0][:2], ['node', '--eval'])
            self.assertIn("platforms: ['android']", args[0][2])
            self.assertIn("ignorePaths: ['android/**', 'ios/**']", args[0][2])
            self.assertEqual(kwargs['cwd'], Path('/mobile'))
        with patch.object(builder, 'run', return_value='invalid'):
            with self.assertRaisesRegex(RuntimeError, 'native fingerprint'):
                builder.native_fingerprint(Path('/mobile'), {})

    def test_default_pdfium_respects_override_and_requires_library(self):
        with tempfile.TemporaryDirectory() as temp:
            cache = Path(temp) / '.cache/t3-android/pdfium'
            env = {}
            builder.default_pdfium(env, Path(temp))
            self.assertNotIn('ORG_GRADLE_PROJECT_pdfJsiPdfiumDir', env)
            library = cache / 'lib/arm64-v8a/libpdfn.so'
            library.parent.mkdir(parents=True)
            library.touch()
            builder.default_pdfium(env, Path(temp))
            self.assertEqual(env['ORG_GRADLE_PROJECT_pdfJsiPdfiumDir'], str(cache))
            env['ORG_GRADLE_PROJECT_pdfJsiPdfiumDir'] = 'custom'
            builder.default_pdfium(env, Path(temp))
            self.assertEqual(env['ORG_GRADLE_PROJECT_pdfJsiPdfiumDir'], 'custom')

    def test_numeric_nightly_order_excludes_moving_android_tag(self):
        self.assertGreater(builder.version_key('v0.1.4-nightly.20261028.3824'),
                           builder.version_key('v0.1.4-nightly.20261027.99999'))
        with self.assertRaises(RuntimeError):
            builder.version_key('android-nightly')

    def test_explicit_tag_fetch_avoids_moving_tag_and_preserves_dirty_checkout(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'source'
            source.mkdir()
            builder.run(['git', 'init', '-q', source])
            (source / 'package.json').write_text('{}')
            builder.run(['git', 'add', 'package.json'], cwd=source)
            builder.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                         '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], cwd=source)
            for tag in ['android-nightly', 'v0.1.4-nightly.20261028.2', 'v0.1.4-nightly.20261028.10']:
                builder.run(['git', '-c', 'tag.gpgSign=false', 'tag', tag], cwd=source)
            args = SimpleNamespace(source=str(source), ref=None, tag=None)
            checkout = root / 'checkout'
            result = builder.checkout_source(args, checkout)
            self.assertEqual(result['tag'], 'v0.1.4-nightly.20261028.10')
            self.assertEqual(builder.run(['git', 'tag'], cwd=checkout, capture=True), result['tag'])
            (checkout / 'package.json').write_text('unrelated edit')
            with self.assertRaisesRegex(RuntimeError, 'has changes'):
                builder.checkout_source(args, checkout)
            self.assertEqual((checkout / 'package.json').read_text(), 'unrelated edit')

    def test_in_place_build_needs_clean_tree_on_requested_ref(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp).resolve()
            commit = ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                      '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture']
            builder.run(['git', 'init', '-q', '-b', 'main', repo])
            builder.run(commit, cwd=repo)
            builder.run(['git', 'branch', 'custom'], cwd=repo)
            builder.run(commit, cwd=repo)
            args = SimpleNamespace(source=str(repo), ref='custom', tag=None)
            with self.assertRaisesRegex(RuntimeError, 'Check out custom'):
                builder.checkout_source(args, repo)
            builder.run(['git', 'checkout', '-q', 'custom'], cwd=repo)
            result = builder.checkout_source(args, repo)
            self.assertEqual(result['sha'], builder.run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture=True))
            (repo / 'edit').write_text('unrelated edit')
            with self.assertRaisesRegex(RuntimeError, 'has changes'):
                builder.checkout_source(args, repo)
            self.assertEqual((repo / 'edit').read_text(), 'unrelated edit')

    def test_native_caches_restore_after_failed_regeneration(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            android = root / 'android'
            for name in ['.gradle/history', 'app/.cxx/ninja']:
                path = android / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('old cache')
            with self.assertRaisesRegex(RuntimeError, 'prebuild failed'):
                with builder.native_cache_backup(android, root):
                    self.assertFalse((android / '.gradle').exists())
                    builder.shutil.rmtree(android)
                    raise RuntimeError('prebuild failed')
            self.assertEqual((android / '.gradle/history').read_text(), 'old cache')
            self.assertEqual((android / 'app/.cxx/ninja').read_text(), 'old cache')
            self.assertFalse((root / 'native-cache-backup').exists())

    def test_recovers_caches_from_interrupted_previous_run(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            backup = root / 'native-cache-backup/gradle'
            backup.mkdir(parents=True)
            (backup / 'history').write_text('saved')
            android = root / 'android'
            with builder.native_cache_backup(android, root):
                self.assertFalse((android / '.gradle').exists())
            self.assertEqual((android / '.gradle/history').read_text(), 'saved')

    def test_env_fill_preserves_existing_values(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            existing = 'T3CODE_RELAY_URL=https://my-relay.example\nEXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_custom\nUNRELATED=keep\n'
            (root / '.env').write_text(existing)
            (root / '.env.example').write_text(
                'T3CODE_RELAY_URL=https://relay.t3.codes\nT3CODE_CLERK_PUBLISHABLE_KEY=pk_default\n'
                'T3CODE_CLERK_JWT_TEMPLATE=t3-relay\nOTHER=ignored\n')
            builder.fill_public_env(root)
            self.assertEqual((root / '.env').read_text(), existing + '\nT3CODE_CLERK_JWT_TEMPLATE=t3-relay\n')
            self.assertEqual((root / '.env').stat().st_mode & 0o777, 0o600)

    def test_rejects_disabled_connect_and_wrong_variant(self):
        config = {'name': 'T3 Code Preview', 'icon': '../../nightly.png',
                  'android': {'package': builder.PACKAGE},
                  'extra': {'appVariant': 'preview', 'relay': {'url': 'https://relay.t3.codes'},
                            'clerk': {'publishableKey': 'pk_live_public', 'jwtTemplate': 't3-relay'}}}
        self.assertTrue(builder.validate_config(config)['enabled'])
        config['extra']['appVariant'] = 'production'
        with self.assertRaises(RuntimeError):
            builder.validate_config(config)
        config['extra']['appVariant'] = 'preview'
        config['extra']['clerk'] = {}
        with self.assertRaises(RuntimeError):
            builder.validate_config(config)


if __name__ == '__main__':
    unittest.main()
