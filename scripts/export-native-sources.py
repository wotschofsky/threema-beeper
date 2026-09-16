"""Preserve checksum-pinned native source inputs and notices from the tested context."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise ValueError('Usage: export-native-sources.py <new-directory-under-.local>')
output = Path(sys.argv[1]).resolve()
if not output.is_relative_to(root / '.local') or output.exists():
    raise ValueError('Use a fresh directory under .local')
verification_path = root / 'docs/LINUX-ALERTS-VERIFICATION.json'
verification = json.loads(verification_path.read_text())
context = (root / verification['context']).resolve()
if not context.is_relative_to(root / '.local'):
    raise ValueError('Invalid build context')
commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--verify', verification['sourceCommit'] + '^{commit}']).decode().strip()


def source(path):
    return subprocess.check_output(['git', '-C', str(root), 'show', commit + ':' + path])


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


plans = []
for component, folder in [('FFMPEG', 'ffmpeg'), ('JPEG', 'jpeg'), ('WEBP', 'webp'), ('OPENH264', 'openh264'),
                          ('OPUS', 'opus'), ('AVIF', 'avif'), ('DAV1D', 'avif'), ('LCMS', 'avif')]:
    pin = json.loads(source(f'docs/{component}-PINS.json'))
    plans.append({'component': component.lower(), 'path': context / '.artifacts' / folder / pin['archive'],
                  'archive': pin['archive'], 'sha256': pin['sha256'], 'url': pin['url'], 'version': pin['version']})
node = json.loads(source('docs/NODE-CLEANUP-BUILD.json'))
plans.append({'component': 'node', 'path': context / node['archive'], 'archive': node['archive'],
              'sha256': node['archiveSha256'], 'url': node['archiveUrl'], 'version': node['version']})
for plan in plans:
    if not plan['path'].is_file() or plan['path'].is_symlink() or digest(plan['path']) != plan['sha256']:
        raise ValueError('Source input changed: ' + plan['component'])
output.mkdir(mode=0o700)
(output / 'sources').mkdir()
archives = []
for plan in plans:
    target = output / 'sources' / plan['archive']
    shutil.copyfile(plan['path'], target)
    if digest(target) != plan['sha256']:
        raise ValueError('Source copy changed')
    notices = []
    with tarfile.open(target) as archive:
        for entry in archive:
            path = PurePosixPath(entry.name)
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('Unsafe source archive path')
            if not entry.isfile() or not path.name.lower().startswith(('license', 'licence', 'copying', 'copyright', 'notice', 'authors')):
                continue
            if entry.size > 16 * 1024 * 1024:
                raise ValueError('Unexpectedly large notice')
            with archive.extractfile(entry) as stream:
                data = stream.read()
            destination = output / 'LICENSES' / plan['component'] / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            notices.append({'path': str(path), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    if not notices:
        raise ValueError('Source archive has no recognized notices')
    archives.append({key: value for key, value in plan.items() if key != 'path'} | {'bytes': target.stat().st_size, 'notices': notices})
    print(f"Verified {plan['component']} source and {len(notices)} notice files", flush=True)
# Keep build recipes and project patches at the image source revision.
tracked = subprocess.check_output(['git', '-C', str(root), 'ls-tree', '-rz', commit, '--', 'native', 'deploy/docker/Dockerfile.native', 'spikes/gate0/Dockerfile.native']).decode().split('\0')
recipes = []
for entry in filter(None, tracked):
    header, path = entry.split('\t', 1)
    mode = header.split(' ')[0]
    if mode not in ['100644', '100755']:
        raise ValueError('Unexpected build input mode')
    data = source(path)
    destination = output / 'build' / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    destination.chmod(0o755 if mode == '100755' else 0o644)
    recipes.append({'path': path, 'sha256': hashlib.sha256(data).hexdigest()})
for path, expected in node['patches'].items():
    if digest(output / 'build' / path) != expected:
        raise ValueError('Node patch differs from recorded source build')
manifest = {'schemaVersion': 1, 'sourceCommit': commit, 'verificationSha256': digest(verification_path),
            'images': [{'architecture': image['architecture'], 'imageId': image['observation']['imageId'], 'inputSha256': image['observation']['inputSha256']} for image in verification['images']],
            'archives': archives, 'buildFiles': recipes, 'completeCorrespondingSource': False,
            'scope': 'Original archive checksums match pinned source inputs in the tested image context. Notices are preserved verbatim. This is not a new signature verification, legal review, independently signed build attestation, or complete runtime dependency source bundle.'}
(output / 'native-source.json').write_text(json.dumps(manifest, indent=2) + '\n')
files = sorted(path for path in output.rglob('*') if path.is_file())
(output / 'SHA256SUMS').write_text(''.join(f'{digest(path)}  {path.relative_to(output).as_posix()}\n' for path in files))
print(f'Native source supplement ready: {len(archives)} archives; completeness remains open')
