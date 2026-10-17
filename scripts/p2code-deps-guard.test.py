import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('p2code-deps-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def lock(pdf, diff, override, catalog):
    return f"""---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.14.0
        version: 12.14.0

---
lockfileVersion: '9.0'

catalogs:
  default:
    '@types/node':
      specifier: {catalog}
      version: {catalog}

overrides:
  react-native-pdf-jsi: {override}
  '@types/ws@^8': 8.18.2
  remark-math>micromark-extension-math: npm:micromark-extension-llm-math@3.1.0

importers:

  apps/mobile:
    dependencies:
      react-native-pdf-jsi:
        specifier: {pdf}
        version: {pdf}(expo@58.0.14)(react@19.3.0)
      '@t3tools/shared':
        specifier: workspace:*
        version: link:../../packages/shared
  apps/web:
    dependencies:
      diff:
        specifier: ^{diff}
        version: {diff}
"""


class GuardTests(unittest.TestCase):
    def test_parses_importers_catalogs_and_overrides(self):
        parsed = guard.parse_lock(lock('6.1.1', '9.0.0', '6.1.1', '26.6.6'))
        self.assertEqual(parsed['apps/mobile react-native-pdf-jsi'], '6.1.1(expo@58.0.14)(react@19.3.0)')
        self.assertEqual(parsed['apps/web diff'], '9.0.0')
        self.assertEqual(parsed['catalog:default @types/node'], '26.6.6')
        self.assertEqual(parsed['override react-native-pdf-jsi'], '6.1.1')
        self.assertEqual(parsed['override @types/ws@^8'], '8.18.2')
        self.assertEqual(parsed['. pnpm'], '12.14.0')

    def test_flags_only_carried_versions_a_rebase_lowered(self):
        base = guard.parse_lock(lock('5.0.0', '8.0.3', '5.0.0', '24.12.4'))
        before = guard.parse_lock(lock('6.1.1', '8.0.3', '6.1.1', '26.6.6'))
        after = guard.parse_lock(lock('5.0.0', '8.0.1', '6.1.1', '26.7.0'))
        self.assertEqual(guard.lowered(base, before, after),
                         [('apps/mobile react-native-pdf-jsi', '6.1.1', '5.0.0')])

    def test_flags_second_copies_of_single_copy_packages(self):
        packages = """lockfileVersion: '9.0'

packages:

  prosemirror-model@1.25.12:
    resolution: {integrity: sha512-a}

  prosemirror-model@1.25.4:
    resolution: {integrity: sha512-b}

  prosemirror-view@1.42.9:
    resolution: {integrity: sha512-c}

  '@tiptap/pm@3.33.0':
    resolution: {integrity: sha512-d}

  '@tiptap/pm@3.31.3':
    resolution: {integrity: sha512-e}

snapshots:

  prosemirror-model@1.25.4: {}
"""
        self.assertEqual(guard.duplicated(packages), [('prosemirror-model', ['1.25.4', '1.25.12'])])

    def test_orders_prereleases_below_their_release(self):
        self.assertLess(guard.version_key('2.0.0-beta.85'), guard.version_key('2.0.0'))
        self.assertLess(guard.version_key('2.0.0-beta.9'), guard.version_key('2.0.0-beta.85'))
        self.assertLess(guard.version_key('1.2.0-beta.15'), guard.version_key('1.2.0'))
        self.assertLess(guard.version_key('9.0.0'), guard.version_key('10.0.0'))


if __name__ == '__main__':
    unittest.main()
