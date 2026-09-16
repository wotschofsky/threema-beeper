"""Preserve inventoried base-image package files without starting a container."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise ValueError('Usage: export-base-package-inputs.py <new-directory-under-.local>')
output = Path(sys.argv[1]).resolve()
if not output.is_relative_to(root / '.local') or output.exists():
    raise ValueError('Use a fresh directory under .local')
record = json.loads((root / 'docs/NPM-INPUT-VERIFICATION.json').read_text())
verification = json.loads((root / 'docs/LINUX-ALERTS-VERIFICATION.json').read_text())
packages = [item for item in record['separateCoverageRequired'] if item['reason'] == 'base-image-package']
if {(p['name'], p['imagePath']) for p in packages} != {('corepack', '/usr/local/lib/node_modules/corepack/package.json'), ('yarn', '/opt/yarn-v1.22.22/package.json')}:
    raise ValueError('Base package selection changed; review required')


def docker(*args):
    return subprocess.check_output(['docker', *args], timeout=120)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


output.mkdir(mode=0o700)
results = []
for image in record['imageInventories']:
    expected = next(item['observation'] for item in verification['images'] if item['architecture'] == image['architecture'])
    if image['imageId'] != expected['imageId'] or expected['inputSha256'] != record['inputSha256']:
        raise ValueError('Candidate image evidence changed')
    image_id = image['imageId']
    if not re.fullmatch('sha256:[a-f0-9]{64}', image_id):
        raise ValueError('Invalid immutable image ID')
    info = json.loads(docker('image', 'inspect', image_id))[0]
    if info['Id'] != image_id or info['Architecture'] != image['architecture'] or info['Config'].get('Volumes'):
        raise ValueError('Unexpected image identity or volume configuration')
    container = docker('create', '--pull=never', '--read-only', '--network=none', '--entrypoint=/bin/false', image_id).decode().strip()
    if not re.fullmatch('[a-f0-9]{64}', container):
        raise ValueError('Invalid created container ID')
    try:
        for package in packages:
            directory = PurePosixPath(package['imagePath']).parent
            archive_path = output / f"{image['architecture']}-{package['name']}.tar"
            with archive_path.open('xb') as stream:
                subprocess.run(['docker', 'cp', f'{container}:{directory}', '-'], stdout=stream, check=True, timeout=120)
            files = []
            metadata = None
            seen = set()
            with tarfile.open(archive_path) as archive:
                for item in archive:
                    path = PurePosixPath(item.name)
                    if path.is_absolute() or '..' in path.parts or not path.is_relative_to(directory.name):
                        raise ValueError('Unexpected package archive path')
                    if item.isdir():
                        continue
                    if item.name in seen:
                        raise ValueError('Duplicate package archive entry')
                    seen.add(item.name)
                    if item.isfile():
                        with archive.extractfile(item) as stream:
                            contents_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
                        files.append({'path': item.name, 'kind': 'file', 'sha256': contents_hash, 'bytes': item.size, 'mode': item.mode})
                        if path == directory.name / PurePosixPath('package.json'):
                            metadata = json.load(archive.extractfile(item))
                    elif item.issym():
                        files.append({'path': item.name, 'kind': 'symlink', 'target': item.linkname})
                    else:
                        raise ValueError('Unexpected package archive entry type')
            if not metadata or (metadata['name'], metadata['version']) != (package['name'], package['version']):
                raise ValueError('Inventoried package identity differs from image files')
            results.append({'architecture': image['architecture'], 'imageId': image_id, 'name': package['name'], 'version': package['version'],
                            'archive': archive_path.name, 'sha256': digest(archive_path), 'bytes': archive_path.stat().st_size,
                            'files': sorted(files, key=lambda entry: entry['path'])})
        state = json.loads(docker('container', 'inspect', container))[0]
        if state['State']['Status'] != 'created' or state['Mounts']:
            raise ValueError('Inspection container unexpectedly ran or acquired mounts')
    finally:
        docker('container', 'rm', container)
for package in packages:
    copies = [item for item in results if item['name'] == package['name']]
    if len(copies) != 2 or copies[0]['files'] != copies[1]['files']:
        raise ValueError('Base package differs across architectures; review required')
report = {'schemaVersion': 1, 'inputSha256': record['inputSha256'], 'packages': results,
          'containersNeverStarted': True, 'architectureContentsIdentical': True, 'completeCorrespondingSource': False,
          'scope': 'Exact Corepack and Yarn installed files, including notices, copied from immutable tested images. Generated/bundled code may require additional preferred source and build inputs. No container process was started or account storage mounted.'}
(output / 'base-package-inputs.json').write_text(json.dumps(report, indent=2) + '\n')
files = sorted(path for path in output.iterdir() if path.is_file())
(output / 'SHA256SUMS').write_text(''.join(f'{digest(path)}  {path.name}\n' for path in files))
print('Preserved Corepack and Yarn from both images; contents identical; inspection containers removed')
