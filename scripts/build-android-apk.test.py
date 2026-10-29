"""Focused tests for cache recovery, revision selection and embedded configuration."""
import importlib.util
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace
import unittest

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build-android-apk.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BuilderTests(unittest.TestCase):
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
