"""Bundle verified source supplements without treating them as a complete source release."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parent.parent
if len(sys.argv) not in (2, 4):
    raise ValueError('Usage: export-source-supplements.py <new-directory-under-.local> [verification-json primary-source-record-json]')
output = Path(sys.argv[1]).resolve()
if not output.is_relative_to(root / '.local') or output.exists():
    raise ValueError('Use a fresh directory under .local')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


verification_path = root / 'docs/LINUX-ALERTS-VERIFICATION.json'
verification = json.loads(verification_path.read_text())
input_hash = verification['images'][0]['observation']['inputSha256']
source_commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', verification['sourceCommit'] + '^{commit}']).decode().strip()
selected = {}


def add(path, expected):
    full = root / path
    resolved = full.resolve()
    if not resolved.is_relative_to(root) or full.is_symlink() or not full.is_file() or digest(full) != expected:
        raise ValueError('Source evidence missing or changed: ' + path)
    target = 'files/' + Path(path).relative_to('.local').as_posix() if path.startswith('.local/') else path
    if target in selected and selected[target]['sha256'] != expected:
        raise ValueError('Conflicting source bundle entry')
    selected[target] = {'source': path, 'sha256': expected, 'bytes': full.stat().st_size}


names = ['PRIMARY-SOURCE-VERIFICATION', 'MATRIX-DEPENDENCY-SOURCE-VERIFICATION', 'MATRIX-NOTICE-VERIFICATION',
         'LIBTHREEMA-DEPENDENCY-SOURCE-VERIFICATION', 'LIBTHREEMA-NOTICE-VERIFICATION',
         'NATIVE-SOURCE-SUPPLEMENT-VERIFICATION', 'DATABASE-SOURCE-VERIFICATION', 'NPM-INPUT-VERIFICATION',
         'NPM-NOTICE-VERIFICATION', 'BASE-PACKAGE-INPUT-VERIFICATION', 'OS-NOTICE-VERIFICATION', 'OS-SOURCE-VERIFICATION',
         'PROXY-SOURCE-VERIFICATION', 'GO-SOURCE-VERIFICATION']
records = {}
for name in names:
    path = 'docs/' + name + '.json'
    record = json.loads((root / path).read_text())
    records[name] = record
    if 'inputSha256' in record and record['inputSha256'] != input_hash:
        raise ValueError('Source supplement belongs to a different context')
    add(path, digest(root / path))
    for item in record.get('evidence', []):
        add(item['path'], item['sha256'])
primary = records['PRIMARY-SOURCE-VERIFICATION']
if primary['sourceCommit'] != source_commit or primary['verificationSha256'] != digest(verification_path):
    raise ValueError('Primary sources belong to a different candidate')
primary_commits = {archive['name']: archive['commit'] for archive in primary['archives']}
proxy = records['PROXY-SOURCE-VERIFICATION']
if proxy['commit'] != primary_commits['bridge-manager'] or records['GO-SOURCE-VERIFICATION']['version'] != proxy['goVersion']:
    raise ValueError('Proxy or Go source version differs')
for binary in proxy['binaryModules']:
    path = root / verification['context'] / '.artifacts/bbctl' / ('bbctl-linux-' + binary['architecture'])
    if digest(path) != binary['binarySha256']:
        raise ValueError('Proxy source evidence is for a different binary')
for record_name, repository in [('MATRIX-DEPENDENCY-SOURCE-VERIFICATION', 'matrix-rust-sdk-crypto-nodejs'),
                                ('LIBTHREEMA-DEPENDENCY-SOURCE-VERIFICATION', 'threema-desktop')]:
    if records[record_name]['sourceCommit'] != primary_commits[repository]:
        raise ValueError('Dependency supplement belongs to a different source revision')
expected_images = {(image['architecture'], image['observation']['imageId']) for image in verification['images']}
for record_name in ['NATIVE-SOURCE-SUPPLEMENT-VERIFICATION', 'NPM-INPUT-VERIFICATION', 'OS-NOTICE-VERIFICATION']:
    record = records[record_name]
    images = record.get('images', record.get('imageInventories', []))
    if {(image['architecture'], image['imageId']) for image in images} != expected_images:
        raise ValueError('Supplement image identities differ')
os_notices = records['OS-NOTICE-VERIFICATION']
os_sources = records['OS-SOURCE-VERIFICATION']
if os_sources['osNoticeRecordSha256'] != digest(root / 'docs/OS-NOTICE-VERIFICATION.json'):
    raise ValueError('OS source requirements changed')
required_os = {(p['name'], p['version']) for p in os_notices['sourcePackagesRequired']}
if (not os_sources['allRequiredSourcesDownloaded'] or os_sources['unresolved'] or
        {(p['name'], p['version']) for p in os_sources['sourcePackages']} != required_os):
    raise ValueError('OS source collection is incomplete')
for image in os_notices['images']:
    for archive in image['archives']:
        add(os_notices['directory'] + '/' + archive['path'], archive['sha256'])
add(os_notices['manifest']['path'], os_notices['manifest']['sha256'])
add(primary['directory'] + '/source.json', primary['manifestSha256'])
for archive in primary['archives']:
    add(primary['directory'] + '/' + archive['file'], archive['sha256'])
for name in ['DATABASE-SOURCE-VERIFICATION', 'BASE-PACKAGE-INPUT-VERIFICATION']:
    record = records[name]
    for package in record['packages']:
        archive = package['archive']
        if isinstance(archive, dict):
            add(record['directory'] + '/' + archive['path'], archive['sha256'])
        else:
            add(record['directory'] + '/' + archive, package['sha256'])
    if 'manifest' in record:
        add(record['manifest']['path'], record['manifest']['sha256'])
add('docs/LINUX-ALERTS-VERIFICATION.json', digest(verification_path))
extension = None
if len(sys.argv) == 4:
    # Preserve the original records as original records. Reuse their dependency
    # inputs only after comparing both complete contexts and observed runtimes.
    new_verification_path = Path(sys.argv[2])
    new_primary_path = Path(sys.argv[3])
    new_verification = json.loads((root / new_verification_path).read_text())
    new_primary = json.loads((root / new_primary_path).read_text())
    contexts = []
    for candidate in (verification, new_verification):
        directory = root / candidate['context']
        subprocess.run(['node', str(root / 'scripts/entry.verify-linux-context.ts'), str(directory)], check=True)
        manifest = json.loads((directory / 'context-integrity.json').read_text())
        if any(image['observation']['inputSha256'] != manifest['sha256'] for image in candidate['images']):
            raise ValueError('Image/context identity differs')
        contexts.append({entry['path']: entry for entry in manifest['entries']})
    old_entries, new_entries = contexts
    changed = sorted(path for path in old_entries.keys() | new_entries.keys()
                     if old_entries.get(path) != new_entries.get(path))
    for path in changed:
        if not (path.startswith(('src/', 'tests/')) or path == 'docs/NODE-CLEANUP-BUILD.json'):
            raise ValueError('Dependency/build input changed; recollect source evidence: ' + path)
    new_commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', new_verification['sourceCommit'] + '^{commit}']).decode().strip()
    if (new_primary['sourceCommit'] != new_commit or
            new_primary['verificationSha256'] != digest(root / new_verification_path) or
            new_primary['inputSha256'] != new_verification['images'][0]['observation']['inputSha256']):
        raise ValueError('New primary sources belong to a different candidate')
    new_commits = {item['name']: item['commit'] for item in new_primary['archives']}
    if {k: v for k, v in new_commits.items() if k != 'threema-beeper'} != {
            k: v for k, v in primary_commits.items() if k != 'threema-beeper'}:
        raise ValueError('Upstream primary sources changed')
    for path in changed:
        if path not in new_entries:
            continue
        entry = new_entries[path]
        original = subprocess.check_output(['git', '-C', str(root), 'show', new_commit + ':' + path])
        if entry['kind'] != 'file' or hashlib.sha256(original).hexdigest() != entry['sha256']:
            raise ValueError('New source archive does not represent staged change: ' + path)
    old_images = {i['architecture']: i['observation'] for i in verification['images']}
    new_images = {i['architecture']: i['observation'] for i in new_verification['images']}
    if set(old_images) != set(new_images):
        raise ValueError('Architecture coverage changed')
    for architecture, observed in new_images.items():
        old_runtime, new_runtime = old_images[architecture]['runtime'], observed['runtime']
        for field in ('nodeExecutableSha256', 'bbctlSha256', 'matrixArtifact', 'debianPackages'):
            if old_runtime[field] != new_runtime[field]:
                raise ValueError('Runtime dependency changed: ' + field)
        if [(b['path'], b['sha256']) for b in old_runtime['binaries']] != [
                (b['path'], b['sha256']) for b in new_runtime['binaries']]:
            raise ValueError('Native dependency binaries changed')
    add(new_verification_path.as_posix(), digest(root / new_verification_path))
    add(new_primary_path.as_posix(), digest(root / new_primary_path))
    add(new_primary['directory'] + '/source.json', new_primary['manifestSha256'])
    for archive in new_primary['archives']:
        add(new_primary['directory'] + '/' + archive['file'], archive['sha256'])
    extension = {'previousSourceCommit': source_commit, 'previousInputSha256': input_hash,
                 'changedContextPaths': changed, 'dependencyInputsIdentical': True,
                 'observedNativeDependenciesIdentical': True,
                 'primarySourceRecord': new_primary_path.as_posix(),
                 'scope': 'Earlier records retain their original image identities. Unchanged dependency inputs and observed native binaries permit reuse; application sources come from the new primary archive.'}
    source_commit = new_commit
    input_hash = new_primary['inputSha256']
report = {'schemaVersion': 1, 'sourceCommit': source_commit, 'inputSha256': input_hash,
          'completeCorrespondingSource': False, 'releaseReady': False,
          'extension': extension,
          'files': [{'archivePath': target, **record} for target, record in sorted(selected.items())],
          'remaining': ['OS source license review and reproducibility', 'Preferred sources for generated/bundled npm packages',
                        'SQLCipher original source and regeneration provenance', 'Unresolved npm notices and full license review',
                        'Complete build-tool inputs, reproducibility and signed provenance'],
          'scope': 'Verified preservation supplements collected for this private candidate. Included records retain their original limitations. This bundle does not certify complete corresponding source or authorize distribution.'}
data = (json.dumps(report, indent=2) + '\n').encode()
output.mkdir(mode=0o700)
archive_path = output / 'sources.tar.gz'
with tarfile.open(archive_path, 'w:gz', compresslevel=1) as archive:
    for target, item in sorted(selected.items()):
        archive.add(root / item['source'], arcname=target, recursive=False)
    entry = tarfile.TarInfo('sources.json')
    entry.size = len(data)
    entry.mode = 0o644
    archive.addfile(entry, io.BytesIO(data))
seen = set()
with tarfile.open(archive_path) as archive:
    for entry in archive:
        if not entry.isfile() or entry.name in seen:
            raise ValueError('Unexpected bundle entry')
        seen.add(entry.name)
        expected = hashlib.sha256(data).hexdigest() if entry.name == 'sources.json' else selected[entry.name]['sha256']
        with archive.extractfile(entry) as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != expected:
                raise ValueError('Archived source evidence changed')
if seen != set(selected) | {'sources.json'}:
    raise ValueError('Source bundle inventory differs')
(output / 'sources.json').write_bytes(data)
(output / 'SHA256SUMS').write_text(''.join(f'{digest(output / name)}  {name}\n' for name in ['sources.tar.gz', 'sources.json']))
print(f'Bundled and verified {len(selected)} source/evidence files; source completeness remains open')
