"""Preserve the patched proxy source and vendor graph linked to the tested binaries."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise ValueError('Usage: export-proxy-sources.py <new-directory-under-.local>')
output = Path(sys.argv[1]).resolve()
if not output.is_relative_to(root / '.local') or output.exists():
    raise ValueError('Use a fresh directory under .local')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


verification = json.loads((root / 'docs/LINUX-ALERTS-VERIFICATION.json').read_text())
context = (root / verification['context']).resolve()
build_manifest = root / '.local/bin/bbctl-status/manifest.json'
build = json.loads(build_manifest.read_text())
pins = build['dependencyPins']
if subprocess.check_output(['go', 'version']).decode().split()[2] != pins['goVersion']:
    raise ValueError('Go collector version differs from the recorded build')
if not re.fullmatch('[a-f0-9]{40}', build['commit']):
    raise ValueError('Invalid proxy revision')
binary_modules = []
for asset in build['assets']:
    binary = context / '.artifacts/bbctl' / asset['name']
    if digest(binary) != asset['sha256']:
        raise ValueError('Proxy binary differs from recorded source build')
    metadata = subprocess.check_output(['go', 'version', '-m', str(binary)]).decode()
    modules = []
    for line in metadata.splitlines():
        fields = line.strip().split('\t')
        if fields[0] == 'dep':
            modules.append({'path': fields[1], 'version': fields[2], 'sum': fields[3]})
        elif fields[0] == '=>':
            raise ValueError('Module replacement requires explicit source coverage')
    binary_modules.append({'architecture': asset['architecture'], 'binarySha256': asset['sha256'], 'modules': modules})
if len(binary_modules) != 2 or binary_modules[0]['modules'] != binary_modules[1]['modules']:
    raise ValueError('Proxy architecture module graphs differ')
output.mkdir(mode=0o700)
source = output / 'source'
source.mkdir()
archive = subprocess.check_output(['git', '-C', str(root / '.local/sources/bridge-manager'), 'archive', build['commit']])
if hashlib.sha256(archive).hexdigest() != build['sourceArchiveSha256']:
    raise ValueError('Proxy source archive differs from recorded build')
subprocess.run(['tar', '-xf', '-', '-C', str(source)], input=archive, check=True)
for name, expected in [('account-status.patch', build['patchSha256']), ('dependencies.patch', build['dependencyPatchSha256'])]:
    patch = root / 'native/bbctl' / name
    if digest(patch) != expected:
        raise ValueError('Proxy patch changed')
    subprocess.run(['patch', '-p1', '--batch', '--fuzz=0'], input=patch.read_bytes(), cwd=source, check=True, stdout=subprocess.DEVNULL)
for name, expected in pins['patchedFiles'].items():
    if digest(source / name) != expected:
        raise ValueError('Patched proxy dependency inputs differ')
env = {**os.environ, 'GOTOOLCHAIN': 'local', 'GOWORK': 'off', 'GOPATH': '/private/tmp/threema-go',
       'GOCACHE': '/private/tmp/threema-go-build', 'GOPROXY': 'off', 'CGO_ENABLED': '0'}
# Reuse checksum-checked modules already downloaded for the actual build. Never execute proxy code.
checked = subprocess.check_output(['go', 'mod', 'verify'], cwd=source, env=env)
(output / 'module-verification.txt').write_bytes(checked)
subprocess.run(['go', 'mod', 'vendor'], cwd=source, env=env, check=True)
for name, expected in pins['patchedFiles'].items():
    if digest(source / name) != expected:
        raise ValueError('Vendoring changed locked dependency inputs')
vendored = set()
for line in (source / 'vendor/modules.txt').read_text().splitlines():
    fields = line.split()
    if len(fields) >= 3 and fields[0] == '#' and fields[2].startswith('v'):
        vendored.add((fields[1], fields[2]))
locked = {tuple(line.split()) for line in (source / 'go.sum').read_text().splitlines()}
for module in binary_modules[0]['modules']:
    if (module['path'], module['version']) not in vendored or (module['path'], module['version'], module['sum']) not in locked:
        raise ValueError('Binary dependency absent from vendor graph or locked sums')
files = []
for path in sorted(source.rglob('*')):
    if path.is_symlink():
        raise ValueError('Unexpected source symlink')
    if path.is_file():
        files.append({'path': path.relative_to(source).as_posix(), 'bytes': path.stat().st_size,
                      'mode': path.stat().st_mode & 0o777, 'sha256': digest(path)})
archive_path = output / 'proxy-source.tar.gz'
with tarfile.open(archive_path, 'w:gz') as stream:
    stream.add(source, arcname='source')
report = {'schemaVersion': 1, 'commit': build['commit'], 'buildManifestSha256': digest(build_manifest),
          'goVersion': pins['goVersion'], 'binaryModules': binary_modules, 'vendoredModuleCount': len(vendored),
          'files': files, 'archiveSha256': digest(archive_path), 'inputSha256': verification['images'][0]['observation']['inputSha256'],
          'completeCorrespondingSource': False,
          'scope': 'Patched primary proxy source and vendored package graph cover all modules recorded in the two checksum-pinned binaries. Go module cache verification passed; no proxy executable was run. Standard-library/toolchain sources, complete dependency repositories and formal license review remain separate requirements.'}
(output / 'proxy-source.json').write_text(json.dumps(report, indent=2) + '\n')
(output / 'SHA256SUMS').write_text(''.join(f'{digest(output / name)}  {name}\n' for name in ['proxy-source.tar.gz', 'proxy-source.json', 'module-verification.txt']))
print(f'Preserved {len(files)} source files and {len(vendored)} vendored modules; covered {len(binary_modules[0]["modules"])} binary modules')
