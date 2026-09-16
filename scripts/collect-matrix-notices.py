"""Collect repository notices at crate-recorded revisions; never substitute current HEAD."""
import concurrent.futures
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import subprocess
import os
import tomllib
import urllib.request
import urllib.error

root = Path(__file__).resolve().parent.parent
if len(sys.argv) not in [3, 4]:
    raise ValueError('Usage: collect-matrix-notices.py <verified-vendor-export> <new-output-under-.local> [matrix|libthreema]')
vendor, output = map(lambda value: Path(value).resolve(), sys.argv[1:3])
component = sys.argv[3] if len(sys.argv) == 4 else 'matrix'
if component not in ['matrix', 'libthreema']:
    raise ValueError('Unsupported source component')
if not output.is_relative_to(root / '.local') or output.exists():
    raise ValueError('Use a fresh directory under .local')
record_name = 'MATRIX' if component == 'matrix' else 'LIBTHREEMA'
record = json.loads((root / f'docs/{record_name}-DEPENDENCY-SOURCE-VERIFICATION.json').read_text())
coverage_bytes = (vendor / 'coverage.json').read_bytes()
expected = next(item['sha256'] for item in record['evidence'] if item['path'].endswith('/coverage.json'))
if hashlib.sha256(coverage_bytes).hexdigest() != expected:
    raise ValueError('Vendor coverage differs from verified evidence')
coverage = json.loads(coverage_bytes)
missing = set(record['packagesWithoutStandaloneNotice'])
groups = {}
for directory in sorted((vendor / 'vendor').iterdir()):
    package = tomllib.loads((directory / 'Cargo.toml').read_text())['package']
    name = package['name'] + '@' + package['version']
    if name not in missing:
        continue
    checksums = json.loads((directory / '.cargo-checksum.json').read_text())['files']
    for filename in ['Cargo.toml', '.cargo_vcs_info.json']:
        if (directory / filename).exists() and hashlib.sha256((directory / filename).read_bytes()).hexdigest() != checksums.get(filename):
            raise ValueError('Crate provenance changed: ' + name)
    repository = re.match(r'^https://github.com/([\w.-]+/[\w.-]+)(?:/|$)', package['repository'])
    if not repository:
        raise ValueError('Unsupported source repository: ' + name)
    repository = repository[1].removesuffix('.git')
    vcs_path = directory / '.cargo_vcs_info.json'
    if vcs_path.exists():
        vcs = json.loads(vcs_path.read_text())
        revision, crate_path = vcs['git']['sha1'], vcs['path_in_vcs']
    else:
        entry = next(p for p in coverage['packages'] if p['name'] == package['name'] and p['version'] == package['version'])
        if not entry['source'].startswith('git+https://github.com/' + repository + '#'):
            raise ValueError('Missing exact source revision: ' + name)
        revision = entry['source'].split('#')[1]
        crate_path = 'crates/' + package['name']
    if not re.fullmatch('[a-f0-9]{40}', revision):
        raise ValueError('Invalid source revision')
    if PurePosixPath(crate_path).is_absolute() or '..' in PurePosixPath(crate_path).parts:
        raise ValueError('Invalid crate source path')
    groups.setdefault((repository, revision), []).append({'package': name, 'cratePath': crate_path, 'declaredLicense': package.get('license')})
if {package['package'] for packages in groups.values() for package in packages} != missing:
    raise ValueError('Missing package provenance')


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'threema-beeper-source-notices', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read(32 * 1024 * 1024 + 1)
        if len(data) > 32 * 1024 * 1024:
            raise ValueError('Source response too large')
        return data


def source_tree(repository, revision):
    url = f'https://api.github.com/repos/{repository}/git/trees/{revision}?recursive=1'
    try:
        return fetch(url), url, 'github-api'
    except urllib.error.HTTPError as error:
        if error.code != 403 or error.headers.get('x-ratelimit-remaining') != '0':
            raise
    # Public Git transport is independent of the REST API quota. Fetch only the
    # recorded commit; do not switch accounts, tokens, revisions or IP addresses.
    cache = root / '.local/notice-source-git' / repository / revision
    cache.mkdir(parents=True, exist_ok=True)
    def git(*args):
        return subprocess.check_output(['git', '-c', 'credential.helper=', '-C', str(cache), *args],
                                       env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'}, timeout=180)
    if not (cache / 'HEAD').exists():
        git('init', '--bare', '--quiet')
    try:
        resolved = git('rev-parse', '--verify', '--quiet', revision + '^{commit}').decode().strip()
    except subprocess.CalledProcessError:
        git('fetch', '--quiet', '--depth=1', 'https://github.com/' + repository + '.git', revision)
        resolved = git('rev-parse', '--verify', revision + '^{commit}').decode().strip()
    if resolved != revision:
        raise ValueError('Fetched source revision mismatch')
    entries = []
    for row in git('ls-tree', '-rz', revision).decode().split('\0'):
        if not row:
            continue
        header, path = row.split('\t', 1)
        mode, kind, identity = header.split(' ')
        entries.append({'mode': mode, 'type': kind, 'sha': identity, 'path': path})
    tree = {'sha': git('rev-parse', revision + '^{tree}').decode().strip(), 'truncated': False, 'tree': entries}
    return json.dumps(tree).encode(), 'https://github.com/' + repository + '.git', 'git-commit'


output.mkdir(mode=0o700)


def collect(item):
    (repository, revision), packages = item
    tree_bytes, tree_url, tree_method = source_tree(repository, revision)
    tree = json.loads(tree_bytes)
    if tree.get('truncated'):
        raise ValueError('Truncated source tree')
    destination = output / repository / revision
    destination.mkdir(parents=True)
    (destination / 'tree.json').write_bytes(tree_bytes)
    notices = []
    for entry in tree['tree']:
        path = PurePosixPath(entry['path'])
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('Invalid source path')
        if entry['type'] != 'blob' or entry.get('mode') not in ['100644', '100755']:
            continue
        # r-efi puts its license grant and copyright list in AUTHORS.
        notice_name = path.name.lower().startswith(('license', 'licence', 'copying', 'copyright', 'notice', 'authors'))
        applies = []
        for package in packages:
            ancestors = {PurePosixPath('.'), *PurePosixPath(package['cratePath']).parents, PurePosixPath(package['cratePath'])}
            if (notice_name and path.parent in ancestors) or any(path.is_relative_to(parent / 'LICENSES') for parent in ancestors):
                applies.append(package['package'])
        if not applies:
            continue
        url = f'https://raw.githubusercontent.com/{repository}/{revision}/{path}'
        data = fetch(url)
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if blob != entry['sha']:
            raise ValueError('Git blob identity mismatch: ' + str(path))
        target = destination / 'notices' / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        notices.append({'path': str(path), 'url': url, 'gitBlob': blob, 'sha256': hashlib.sha256(data).hexdigest(), 'candidatePackages': applies})
    print(f'{repository}@{revision[:8]}: {len(notices)} notice files', flush=True)
    return {'repository': repository, 'revision': revision, 'packages': packages, 'treeUrl': tree_url, 'treeMethod': tree_method,
            'treeSha256': hashlib.sha256(tree_bytes).hexdigest(), 'notices': notices}


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    results = list(pool.map(collect, groups.items()))
covered = {name for result in results for notice in result['notices'] for name in notice['candidatePackages']}
manifest = {'schemaVersion': 1, 'component': component, 'vendorCoverageSha256': expected, 'repositories': results,
            'packagesWithoutRecoveredNotice': sorted(missing - covered), 'licenseReviewComplete': False,
            'scope': 'Unmodified notices recovered from crate-recorded repository revisions. Candidate applicability follows crate ancestor directories; no legal compatibility or complete third-party notice review is implied.'}
(output / 'notices.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Recovered notice candidates for {len(covered)} of {len(missing)} packages')
