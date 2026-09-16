"""Preserve Debian notices and source-version mappings from stopped image containers."""
import hashlib
import json
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise ValueError('Usage: export-os-notices.py <new-directory-under-.local>')
output = Path(sys.argv[1]).resolve()
if not output.is_relative_to(root / '.local') or output.exists():
    raise ValueError('Use a fresh directory under .local')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def docker(*args):
    return subprocess.check_output(['docker', *args], timeout=120)


coverage = json.loads((root / 'docs/SBOM-COVERAGE.json').read_text())
verification = json.loads((root / 'docs/LINUX-ALERTS-VERIFICATION.json').read_text())
output.mkdir(mode=0o700)
results = []
for image in coverage['images']:
    expected = next(item['observation'] for item in verification['images'] if item['architecture'] == image['architecture'])
    if image['imageId'] != expected['imageId'] or image['inputSha256'] != expected['inputSha256']:
        raise ValueError('Image evidence differs')
    sbom_file = next(item for item in image['outputs'] if item['format'] == 'syft')
    if digest(root / sbom_file['path']) != sbom_file['sha256']:
        raise ValueError('Image inventory changed')
    sbom = json.loads((root / sbom_file['path']).read_text())
    deb = [item for item in sbom['artifacts'] if item['type'] == 'deb']
    image_id = image['imageId']
    if not re.fullmatch('sha256:[a-f0-9]{64}', image_id):
        raise ValueError('Invalid image ID')
    info = json.loads(docker('image', 'inspect', image_id))[0]
    if info['Id'] != image_id or info['Architecture'] != image['architecture'] or info['Config'].get('Volumes'):
        raise ValueError('Unexpected image configuration')
    container = docker('create', '--pull=never', '--platform=linux/' + image['architecture'], '--read-only', '--network=none', '--entrypoint=/bin/false', image_id).decode().strip()
    if not re.fullmatch('[a-f0-9]{64}', container):
        raise ValueError('Invalid inspection container ID')
    destination = output / image['architecture']
    destination.mkdir()
    archives = []
    contents = {}
    status = None
    try:
        for name, source in [('status', '/var/lib/dpkg/status'), ('doc', '/usr/share/doc'), ('common-licenses', '/usr/share/common-licenses')]:
            archive_path = destination / (name + '.tar')
            with archive_path.open('xb') as stream:
                subprocess.run(['docker', 'cp', container + ':' + source, '-'], stdout=stream, check=True, timeout=120)
            with tarfile.open(archive_path) as archive:
                for item in archive:
                    if item.isdir():
                        continue
                    if item.name.startswith('/') or '..' in item.name.split('/'):
                        raise ValueError('Unexpected archived path')
                    if name == 'status':
                        if not item.isfile() or item.name != 'status' or status is not None:
                            raise ValueError('Unexpected dpkg status archive')
                        status = archive.extractfile(item).read().decode()
                        continue
                    path = 'usr/share/' + item.name
                    if path in contents:
                        raise ValueError('Duplicate notice archive path')
                    if item.isfile():
                        with archive.extractfile(item) as stream:
                            sha = hashlib.file_digest(stream, 'sha256').hexdigest()
                        contents[path] = {'kind': 'file', 'sha256': sha, 'bytes': item.size}
                    elif item.issym():
                        contents[path] = {'kind': 'link', 'target': item.linkname}
                    else:
                        raise ValueError('Unexpected notice archive entry')
            archives.append({'path': archive_path.relative_to(output).as_posix(), 'bytes': archive_path.stat().st_size, 'sha256': digest(archive_path)})
        state = json.loads(docker('container', 'inspect', container))[0]
        if state['State']['Status'] != 'created' or state['Mounts']:
            raise ValueError('Inspection container ran or acquired mounts')
    finally:
        docker('container', 'rm', container)
    if status is None:
        raise ValueError('Missing dpkg status')
    installed = {}
    for paragraph in status.split('\n\n'):
        fields = dict(line.split(': ', 1) for line in paragraph.splitlines() if line and not line[0].isspace() and ': ' in line)
        if fields.get('Status') == 'install ok installed':
            key = (fields['Package'], fields['Version'], fields['Architecture'])
            if key in installed:
                raise ValueError('Duplicate installed package')
            installed[key] = fields
    if set(installed) != {(p['name'], p['version'], p['metadata']['architecture']) for p in deb}:
        raise ValueError('dpkg package set differs from SBOM')

    def resolve_notice(path):
        for _ in range(32):
            parts = path.split('/')
            for length in range(1, len(parts) + 1):
                prefix = '/'.join(parts[:length])
                entry = contents.get(prefix)
                if entry and entry['kind'] == 'link':
                    target = entry['target']
                    path = posixpath.normpath(posixpath.join(posixpath.dirname(prefix), target, *parts[length:])).lstrip('/')
                    if not path.startswith('usr/share/'):
                        return None
                    break
            else:
                entry = contents.get(path)
                return {'path': path, **entry} if entry and entry['kind'] == 'file' else None
        return None

    packages = []
    for (name, version, architecture), fields in sorted(installed.items()):
        source = re.fullmatch(r'([^ ]+)(?: \(([^)]+)\))?', fields.get('Source', name))
        if not source:
            raise ValueError('Unrecognized Debian source field')
        packages.append({'name': name, 'version': version, 'architecture': architecture, 'source': source[1],
                         'sourceVersion': source[2] or version, 'copyright': resolve_notice('usr/share/doc/' + name + '/copyright')})
    results.append({'architecture': image['architecture'], 'imageId': image_id, 'sbomSha256': sbom_file['sha256'], 'archives': archives, 'packages': packages})
    print(f"Verified {image['architecture']}: {len(packages)} installed packages; {sum(p['copyright'] is None for p in packages)} unresolved copyright paths", flush=True)
sources = sorted({(p['source'], p['sourceVersion']) for result in results for p in result['packages']})
report = {'schemaVersion': 1, 'images': results, 'sourcePackagesRequired': [{'name': name, 'version': version} for name, version in sources],
          'containersNeverStarted': True, 'sourceArchivesCollected': False, 'licenseReviewComplete': False,
          'scope': 'Installed Debian package identities checked against both SBOMs; notices and common license texts preserved with source-version mappings. OS source archives still need collection and verification.'}
(output / 'os-notices.json').write_text(json.dumps(report, indent=2) + '\n')
files = sorted(p for p in output.rglob('*') if p.is_file())
(output / 'SHA256SUMS').write_text(''.join(f'{digest(p)}  {p.relative_to(output).as_posix()}\n' for p in files))
