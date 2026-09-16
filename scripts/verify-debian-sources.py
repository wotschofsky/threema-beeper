"""Check exact Debian descriptors and payloads against apt's captured source records."""
import hashlib
import json
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 3:
    raise ValueError('Usage: verify-debian-sources.py <download-directory> <new-report>')
directory, report_path = map(Path, sys.argv[1:])
if report_path.exists():
    raise ValueError('Refusing to overwrite a report')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def paragraphs(text):
    current = {}
    key = None
    for line in text.splitlines() + ['']:
        if line.startswith('-----BEGIN PGP SIGNATURE-----'):
            if current:
                yield current
            return
        if not line:
            if current:
                yield current
            current, key = {}, None
        elif line[0].isspace() and key:
            current[key] += '\n' + line.strip()
        elif re.match(r'^[A-Za-z][A-Za-z0-9-]*:', line):
            key, value = line.split(':', 1)
            if key in current:
                raise ValueError('Duplicate descriptor field')
            current[key] = value.strip()


def checksums(fields):
    result = {}
    for line in fields['Checksums-Sha256'].splitlines():
        if not line.strip():
            continue
        sha, size, name = line.split()
        if not re.fullmatch('[a-f0-9]{64}', sha) or not size.isdigit() or Path(name).name != name or name in ['.', '..'] or name in result:
            raise ValueError('Invalid source checksum entry')
        result[name] = {'sha256': sha, 'bytes': int(size)}
    if not result:
        raise ValueError('Missing source payload checksums')
    return result


request = json.loads((directory / 'request.json').read_text())
record_path = root / 'docs/OS-NOTICE-VERIFICATION.json'
record = json.loads(record_path.read_text())
if digest(record_path) != request['requirementsSha256'] or record['sourcePackagesRequired'] != request['sourcePackagesRequired']:
    raise ValueError('Source request differs from verified OS inventory')
results = {}
for line in (directory / 'results.tsv').read_text().splitlines():
    name, version, status = line.split('\t')
    if (name, version) in results or status not in ['ok', 'failed']:
        raise ValueError('Invalid download result')
    results[name, version] = status
required = {(p['name'], p['version']) for p in request['sourcePackagesRequired']}
if set(results) != required:
    raise ValueError('Download pass did not finish the required list')
verified, unresolved = [], []
for name, version in sorted(required):
    if results[name, version] != 'ok':
        unresolved.append({'name': name, 'version': version, 'reason': 'Exact-version apt source download failed; see fetch.log'})
        continue
    folder = directory / 'downloads' / name
    descriptors = list(folder.glob('*.dsc'))
    if len(descriptors) != 1:
        raise ValueError('Expected one source descriptor: ' + name)
    descriptor = descriptors[0]
    matches = [p for p in paragraphs(descriptor.read_text()) if p.get('Source') == name and p.get('Version') == version]
    if len(matches) != 1:
        raise ValueError('Descriptor name/version differs: ' + name)
    index_path = folder / 'source-index.txt'
    indexes = [p for p in paragraphs(index_path.read_text()) if p.get('Package') == name and p.get('Version') == version]
    if not indexes:
        raise ValueError('Exact source version absent from captured apt metadata')
    indexed = checksums(indexes[0])
    if any(checksums(item) != indexed for item in indexes[1:]):
        raise ValueError('Conflicting source indexes')
    payloads = checksums(matches[0])
    expected = {**payloads, descriptor.name: {'sha256': digest(descriptor), 'bytes': descriptor.stat().st_size}}
    if expected != indexed:
        raise ValueError('Descriptor/payload checksums differ from apt source index: ' + name)
    files = []
    for filename, properties in sorted(expected.items()):
        path = folder / filename
        if path.is_symlink() or not path.is_file() or path.stat().st_size != properties['bytes'] or digest(path) != properties['sha256']:
            raise ValueError('Source file differs: ' + filename)
        files.append({'path': path.relative_to(directory).as_posix(), **properties})
    verified.append({'name': name, 'version': version, 'files': files, 'sourceIndexSha256': digest(index_path)})
report = {'schemaVersion': 1, 'requestSha256': digest(directory / 'request.json'), 'collectorImageId': request['collectorImageId'],
          'verified': verified, 'unresolved': unresolved, 'allRequiredSourcesDownloaded': not unresolved,
          'aptSourceIndexesSha256': digest(directory / 'apt-source-indexes.tar.gz'), 'completeCorrespondingSource': False,
          'scope': 'Exact Debian source descriptors and payloads checked against captured apt source metadata and their SHA-256 hashes. Apt authenticated repository indexes during download. No source was built, installed or executed; no independent rebuild or full license review is claimed.'}
report_path.write_text(json.dumps(report, indent=2) + '\n')
print(f'Verified {len(verified)} exact source packages; {len(unresolved)} unresolved')
