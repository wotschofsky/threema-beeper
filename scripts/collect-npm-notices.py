"""Preserve notice evidence for the reviewed npm entries without inventing provenance."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import urllib.request

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 3:
    raise ValueError('Usage: collect-npm-notices.py <verified-npm-input-export> <new-output-under-.local>')
base, output = map(lambda value: Path(value).resolve(), sys.argv[1:])
if not output.is_relative_to(root / '.local') or output.exists():
    raise ValueError('Use a fresh directory under .local')
verification = json.loads((root / 'docs/NPM-INPUT-VERIFICATION.json').read_text())
expected = next(item['sha256'] for item in verification['evidence'] if item['path'].endswith('/npm-inputs.json'))
data = (base / 'npm-inputs.json').read_bytes()
if hashlib.sha256(data).hexdigest() != expected:
    raise ValueError('Package input manifest changed')
manifest = json.loads(data)
packages = {package['name']: package for package in manifest['packages']}
missing = {p['name'] for p in manifest['packages'] if not p['noticeFiles']}
if missing != {'cookie-signature', 'glob-to-regexp', 'hash.js', 'simple-app', 'simple-app-subdir', 'ip-cidr', 'launder', 'mkdirp', 'postgres'}:
    raise ValueError('Notice review set changed')
output.mkdir(mode=0o700)
records = []


def preserve(target, contents):
    path = output / target
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents)
    return {'path': target, 'sha256': hashlib.sha256(contents).hexdigest(), 'bytes': len(contents)}


for name, filename in [('cookie-signature', 'Readme.md'), ('glob-to-regexp', 'README.md'), ('hash.js', 'README.md'), ('pkginfo', 'LICENSE')]:
    package = packages[name]
    file = next(item for item in package['files'] if item['path'] == filename)
    data = (base / package['directory'] / filename).read_bytes()
    if hashlib.sha256(data).hexdigest() != file['sha256']:
        raise ValueError('Embedded notice changed')
    covered = [name] if name != 'pkginfo' else ['simple-app', 'simple-app-subdir']
    if name == 'pkginfo' and any(not packages[p]['imagePath'].startswith(package['imagePath'].removesuffix('package.json') + 'examples/') for p in covered):
        raise ValueError('Example is not inside pkginfo')
    records.append({'packages': covered, 'method': 'embedded-readme' if name != 'pkginfo' else 'containing-package-license',
                    'sourceImagePath': package['imagePath'], 'notice': preserve(name + '/' + filename, data)})
for name in ['ip-cidr', 'launder', 'mkdirp', 'postgres']:
    package = packages[name]
    url = f'https://registry.npmjs.org/{name}/{package["version"]}'
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError('Oversized registry response')
    metadata = json.loads(data)
    if (metadata['name'], metadata['version']) != (name, package['version']):
        raise ValueError('Registry package identity mismatch')
    record = {'packages': [name], 'version': package['version'], 'registryUrl': url,
              'registryMetadata': preserve(name + '/registry.json', data), 'notices': []}
    revision = metadata.get('gitHead')
    if not revision:
        record['unresolved'] = 'Exact source revision absent from version metadata; no current-branch substitution'
        records.append(record)
        continue
    repository = re.fullmatch(r'git\+https://github.com/([\w.-]+/[\w.-]+)\.git', metadata['repository']['url'])
    if not repository or not re.fullmatch('[a-f0-9]{40}', revision):
        raise ValueError('Unsupported exact source provenance')
    repo = repository[1]
    cache = root / '.local/notice-source-git' / repo / revision
    cache.mkdir(parents=True, exist_ok=True)
    def git(*args):
        return subprocess.check_output(['git', '-c', 'credential.helper=', '-C', str(cache), *args],
                                       env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'}, timeout=180)
    if not (cache / 'HEAD').exists():
        git('init', '--bare', '--quiet')
    try:
        git('rev-parse', '--verify', '--quiet', revision + '^{commit}')
    except subprocess.CalledProcessError:
        git('fetch', '--quiet', '--depth=1', 'https://github.com/' + repo + '.git', revision)
    if git('rev-parse', revision + '^{commit}').decode().strip() != revision:
        raise ValueError('Git source identity mismatch')
    tree = git('ls-tree', '-rz', revision)
    record['sourceTree'] = preserve(name + '/source-tree.bin', tree)
    for row in tree.decode().split('\0'):
        if not row:
            continue
        header, filename = row.split('\t', 1)
        path = PurePosixPath(filename)
        if path.parent != PurePosixPath('.') or not path.name.lower().startswith(('license', 'licence', 'unlicense', 'copying', 'notice', 'copyright')):
            continue
        mode, kind, blob = header.split(' ')
        if kind != 'blob' or mode not in ['100644', '100755']:
            raise ValueError('Unexpected notice source')
        contents = git('show', revision + ':' + filename)
        if hashlib.sha1(b'blob ' + str(len(contents)).encode() + b'\0' + contents).hexdigest() != blob:
            raise ValueError('Notice Git identity mismatch')
        record['notices'].append(preserve(name + '/' + filename, contents) | {'gitBlob': blob, 'sourcePath': filename})
    record.update({'method': 'npm-version-git-revision', 'repository': repo, 'revision': revision})
    if not record['notices']:
        record['unresolved'] = 'No conventionally named root notice at the recorded revision'
    records.append(record)
report = {'schemaVersion': 1, 'npmInputManifestSha256': expected, 'records': records,
          'licenseReviewComplete': False, 'scope': 'Notice evidence for nine flagged entries. Embedded notices and containing-package attribution are preserved; remote revisions come from exact-version npm metadata, not independently verified release signatures. This is not a complete legal or nested-notice review.'}
(output / 'notices.json').write_text(json.dumps(report, indent=2) + '\n')
print('Unresolved packages:', [name for item in records if item.get('unresolved') for name in item['packages']])
