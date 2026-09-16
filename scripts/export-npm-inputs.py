"""Preserve package inputs selected by the actual Linux image inventory."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tarfile

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise ValueError('Usage: export-npm-inputs.py <new-directory-under-.local>')
output = Path(sys.argv[1]).resolve()
if not output.is_relative_to(root / '.local') or output.exists():
    raise ValueError('Use a fresh directory under .local')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


verification = json.loads((root / 'docs/LINUX-ALERTS-VERIFICATION.json').read_text())
context = (root / verification['context']).resolve()
if not context.is_relative_to(root / '.local'):
    raise ValueError('Invalid build context')
inventory = json.loads((context / 'context-integrity.json').read_text())
input_hash = hashlib.sha256(json.dumps(inventory['entries'], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
if input_hash != inventory['sha256']:
    raise ValueError('Invalid context inventory')
entries = {entry['path']: entry for entry in inventory['entries']}
coverage = json.loads((root / 'docs/SBOM-COVERAGE.json').read_text())
package_sets = []
sboms = []
for image in coverage['images']:
    expected_image = next(item['observation'] for item in verification['images'] if item['architecture'] == image['architecture'])
    if image['inputSha256'] != input_hash or image['imageId'] != expected_image['imageId'] or expected_image['inputSha256'] != input_hash:
        raise ValueError('Image/context evidence differs')
    evidence = next(item for item in image['outputs'] if item['format'] == 'syft')
    if digest(root / evidence['path']) != evidence['sha256']:
        raise ValueError('Image inventory changed')
    sbom = json.loads((root / evidence['path']).read_text())
    packages = []
    for artifact in sbom['artifacts']:
        if artifact['type'] == 'npm':
            for location in artifact['locations']:
                packages.append((artifact['name'], artifact['version'], location['path']))
    package_sets.append(sorted(set(packages)))
    sboms.append({'architecture': image['architecture'], 'imageId': image['imageId'], 'sha256': evidence['sha256']})
if len(package_sets) != 2 or package_sets[0] != package_sets[1]:
    raise ValueError('Architecture package sets differ; separate exports required')
output.mkdir(mode=0o700)
packages, separate = [], []
for index, (name, version, image_path) in enumerate(package_sets[0]):
    if not image_path.startswith('/probe/') or '/node_modules/' not in image_path:
        separate.append({'name': name, 'version': version, 'imagePath': image_path,
                         'reason': 'base-image-package' if not image_path.startswith('/probe/') else 'project-source-repository'})
        continue
    package = (context / image_path.removeprefix('/probe/')).parent
    if not package.resolve().is_relative_to(context) or package.is_symlink():
        raise ValueError('Invalid package root')
    prefix = package.relative_to(context).as_posix() + '/'
    selected = {key[len(prefix):]: entry for key, entry in entries.items()
                if key.startswith(prefix) and 'node_modules' not in key[len(prefix):].split('/')}
    actual = {path.relative_to(package).as_posix() for path in package.rglob('*')
              if 'node_modules' not in path.relative_to(package).parts and not path.is_dir()}
    if actual != set(selected):
        raise ValueError('Package source inventory differs: ' + name)
    destination = output / 'packages' / f'{index:03d}'
    files = []
    for relative, entry in sorted(selected.items()):
        source = package / relative
        if entry['kind'] != 'file' or source.is_symlink() or digest(source) != entry['sha256'] or source.stat().st_mode & 0o777 != entry['mode']:
            raise ValueError('Package input differs: ' + name + '/' + relative)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(entry['mode'])
        if digest(target) != entry['sha256']:
            raise ValueError('Package copy differs')
        files.append({'path': relative, 'sha256': entry['sha256'], 'mode': entry['mode'], 'bytes': entry['bytes']})
    metadata = json.loads((destination / 'package.json').read_text())
    if (metadata['name'], metadata['version']) != (name, version):
        raise ValueError('Installed package identity differs')
    packages.append({'name': name, 'version': version, 'imagePath': image_path, 'directory': destination.relative_to(output).as_posix(),
                     'license': metadata.get('license'), 'repository': metadata.get('repository'), 'files': files,
                     'noticeFiles': [file['path'] for file in files if Path(file['path']).name.lower().startswith(('license', 'licence', 'copying', 'notice', 'copyright', 'authors'))]})
with tarfile.open(output / 'npm-package-inputs.tar.gz', 'w:gz') as archive:
    archive.add(output / 'packages', arcname='packages')
report = {'schemaVersion': 1, 'inputSha256': input_hash, 'imageInventories': sboms, 'packages': packages,
          'separateCoverageRequired': separate, 'completeCorrespondingSource': False,
          'archiveSha256': digest(output / 'npm-package-inputs.tar.gz'),
          'scope': 'Context-pinned installed package inputs selected by both image inventories. Includes existing local modifications and notices. Published JavaScript packages may omit preferred source or contain generated code; full source and license coverage are not established. Nested node_modules are collected only when separately inventoried.'}
(output / 'npm-inputs.json').write_text(json.dumps(report, indent=2) + '\n')
(output / 'SHA256SUMS').write_text(''.join(f'{digest(output / name)}  {name}\n' for name in ['npm-package-inputs.tar.gz', 'npm-inputs.json']))
print(f'Preserved {len(packages)} package entries; {len(separate)} require separate coverage')
