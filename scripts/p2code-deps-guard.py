"""Fails when a rebase lowered a dependency version that p2code/custom carries above upstream,
or left two copies of a package that must stay single.

usage: p2code-deps-guard.py <pre-rebase-ref> [<post-rebase-ref>]
"""
import re
import subprocess
import sys

SECTIONS = {'importers': 8, 'catalogs': 6, 'overrides': 2}
# Two ProseMirror copies break the composer: marks and plugins fail instanceof checks.
SINGLE_COPY_PREFIXES = ('prosemirror-',)


def parse_lock(text):
    versions = {}
    section = None
    path = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        indent = len(line) - len(line.lstrip(' '))
        if indent == 0:
            section = line.rstrip(':') if line.rstrip(':') in SECTIONS else None
            path = []
            continue
        if section is None:
            continue
        stripped = line.strip()
        if stripped[0] in '\'"':
            end = stripped.index(stripped[0], 1)
            key, value = stripped[1:end], stripped[end + 1:].lstrip(':')
        else:
            key, _, value = stripped.partition(':')
        value = value.strip().strip("'\"")
        depth = indent // 2
        path = path[: depth - 1] + [key]
        leaf = SECTIONS[section]
        if section == 'overrides' and indent == leaf and value:
            versions[f'override {key}'] = value
        elif indent == leaf and key == 'version' and len(path) >= 3:
            owner = path[0] if section == 'importers' else f'catalog:{path[0]}'
            versions[f'{owner} {path[-2]}'] = value
    return versions


def concrete(version):
    version = version.split('(', 1)[0]
    if version.startswith(('link:', 'file:', 'workspace:', 'catalog:')) or version == '-':
        return None
    if '@' in version[1:]:
        version = version.rsplit('@', 1)[-1]
    version = version.lstrip('^~=v')
    return version if re.match(r'\d+(\.\d+)*', version) else None


def version_key(version):
    core, _, pre = version.partition('-')
    numbers = tuple(int(part) if part.isdigit() else 0 for part in core.split('+', 1)[0].split('.'))
    if not pre:
        return numbers, (1,)
    return numbers, (0,) + tuple((0, int(p), '') if p.isdigit() else (1, 0, p) for p in pre.split('.'))


def lowered(base, before, after):
    found = []
    for key, previous in before.items():
        if base.get(key) == previous or key not in after:
            continue
        old, new = concrete(previous), concrete(after[key])
        if old and new and version_key(new) < version_key(old):
            found.append((key, old, new))
    return sorted(found)


def duplicated(text):
    copies = {}
    in_packages = False
    for line in text.splitlines():
        if line and not line.startswith(' '):
            in_packages = line.rstrip() == 'packages:'
            continue
        if not in_packages or not line.startswith('  ') or line.startswith('   '):
            continue
        key = line.strip().rstrip(':').strip('\'"')
        name, _, version = key.rpartition('@')
        if name and name.startswith(SINGLE_COPY_PREFIXES):
            copies.setdefault(name, set()).add(version)
    return sorted((name, sorted(versions, key=version_key))
                  for name, versions in copies.items() if len(versions) > 1)


def lock_at(ref):
    return subprocess.run(['git', 'show', f'{ref}:pnpm-lock.yaml'], check=True,
                          capture_output=True, text=True).stdout


def main(argv):
    if len(argv) not in (2, 3):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    before_ref, after_ref = argv[1], argv[2] if len(argv) == 3 else 'HEAD'
    base_ref = subprocess.run(['git', 'merge-base', before_ref, after_ref], check=True,
                              capture_output=True, text=True).stdout.strip()
    after_lock = lock_at(after_ref)
    found = lowered(parse_lock(lock_at(base_ref)), parse_lock(lock_at(before_ref)),
                    parse_lock(after_lock))
    duplicates = duplicated(after_lock)
    for key, old, new in found:
        print(f'lowered: {key} {old} -> {new}')
    for name, versions in duplicates:
        print(f'duplicate: {name} {" ".join(versions)}')
    return 1 if found or duplicates else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
