"""Export native database/password inputs from the recorded Linux context."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tarfile

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise ValueError('Usage: export-database-sources.py <new-directory-under-.local>')
output = Path(sys.argv[1]).resolve()
if not output.is_relative_to(root / '.local') or output.exists():
    raise ValueError('Use a fresh directory under .local')
verification = json.loads((root / 'docs/LINUX-ALERTS-VERIFICATION.json').read_text())
context = (root / verification['context']).resolve()
if not context.is_relative_to(root / '.local'):
    raise ValueError('Invalid context path')
manifest = json.loads((context / 'context-integrity.json').read_text())
input_hash = hashlib.sha256(json.dumps(manifest['entries'], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
if input_hash != manifest['sha256'] or any(image['observation']['inputSha256'] != input_hash for image in verification['images']):
    raise ValueError('Context inventory is not the tested input')
entries = {entry['path']: entry for entry in manifest['entries']}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


plans = []
store = context / '.local/sources/threema-desktop/node_modules/.pnpm'
for name in ['better-sqlcipher', 'argon2']:
    matches = list(store.glob('*/node_modules/' + name + '/package.json'))
    if len(matches) != 1:
        raise ValueError('Ambiguous native package source')
    package = matches[0].parent
    files = []
    for path in sorted(package.rglob('*')):
        relative = path.relative_to(package)
        if 'node_modules' in relative.parts:
            continue
        if path.is_symlink():
            raise ValueError('Unexpected source symlink')
        if path.is_dir():
            continue
        entry = entries.get(path.relative_to(context).as_posix())
        if not entry or entry['kind'] != 'file' or not path.is_file() or digest(path) != entry['sha256'] or path.stat().st_mode & 0o777 != entry['mode']:
            raise ValueError('Native input changed: ' + str(relative))
        files.append({'path': relative.as_posix(), 'contextPath': path.relative_to(context).as_posix(), 'sha256': entry['sha256'], 'bytes': entry['bytes'], 'mode': entry['mode']})
    expected = {key[len(package.relative_to(context).as_posix()) + 1:] for key in entries if key.startswith(package.relative_to(context).as_posix() + '/') and 'node_modules' not in key[len(package.relative_to(context).as_posix()) + 1:].split('/')}
    if expected != {file['path'] for file in files}:
        raise ValueError('Native source inventory differs')
    metadata = json.loads(matches[0].read_text())
    if metadata['name'] != name:
        raise ValueError('Package identity differs')
    plans.append({'name': name, 'version': metadata['version'], 'files': files})
output.mkdir(mode=0o700)
for plan in plans:
    for file in plan['files']:
        target = output / 'packages' / plan['name'] / file['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(context / file['contextPath'], target)
        target.chmod(file['mode'])
        if digest(target) != file['sha256']:
            raise ValueError('Source copy differs')
    archive = output / (plan['name'] + '.tar.gz')
    with tarfile.open(archive, 'w:gz') as stream:
        stream.add(output / 'packages' / plan['name'], arcname=plan['name'])
    plan['archive'] = {'path': archive.name, 'bytes': archive.stat().st_size, 'sha256': digest(archive)}
    print(f"Verified {plan['name']} {plan['version']}: {len(plan['files'])} source/input files")
report = {'schemaVersion': 1, 'inputSha256': input_hash, 'sourceCommit': verification['sourceCommit'],
          'packages': plans, 'completeCorrespondingSource': False,
          'scope': 'Exact packaged native build inputs, excluding nested node_modules. SQLCipher is a generated amalgamation; its regeneration script names a private Threema repository. Preferred-source and regeneration coverage remain unproven. Transitive npm tooling and legal review are outside this supplement.'}
(output / 'database-source.json').write_text(json.dumps(report, indent=2) + '\n')
files = sorted(path for path in output.rglob('*') if path.is_file())
(output / 'SHA256SUMS').write_text(''.join(f'{digest(path)}  {path.relative_to(output).as_posix()}\n' for path in files))
