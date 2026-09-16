"""Preserve the checksum-pinned Go source release and compare installed source files."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import urllib.request

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise ValueError('Usage: collect-go-source.py <new-directory-under-.local>')
output = Path(sys.argv[1]).resolve()
if not output.is_relative_to(root / '.local') or output.exists():
    raise ValueError('Use a fresh directory under .local')
pins = json.loads((root / 'docs/GO-SOURCE-PINS.json').read_text())
proxy = json.loads((root / 'docs/PROXY-SOURCE-VERIFICATION.json').read_text())
if pins['version'] != proxy['goVersion'] or subprocess.check_output(['go', 'version']).decode().split()[2] != pins['version']:
    raise ValueError('Go source version differs from proxy build or installed compiler')
goroot = Path(subprocess.check_output(['go', 'env', 'GOROOT']).decode().strip())
output.mkdir(mode=0o700)
archive_path = output / pins['archive']
digest = hashlib.sha256()
size = 0
with urllib.request.urlopen(pins['url'], timeout=60) as response, archive_path.open('xb') as destination:
    while chunk := response.read(1024 * 1024):
        size += len(chunk)
        if size > pins['bytes']:
            raise ValueError('Go archive exceeds expected size')
        digest.update(chunk)
        destination.write(chunk)
if size != pins['bytes'] or digest.hexdigest() != pins['sha256']:
    raise ValueError('Go archive differs from official pinned checksum')
matched = 0
missing, different, notices = [], [], []
with tarfile.open(archive_path) as archive:
    version = archive.extractfile('go/VERSION').read().decode().splitlines()[0]
    if version != pins['version']:
        raise ValueError('Go archive version marker differs')
    for entry in archive:
        path = PurePosixPath(entry.name)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('Invalid source archive path')
        if not entry.isfile():
            continue
        is_notice = path.name.lower().startswith(('license', 'licence', 'copyright', 'copying', 'notice', 'authors', 'patents'))
        if not entry.name.startswith('go/src/') and not is_notice:
            continue
        with archive.extractfile(entry) as stream:
            sha = hashlib.file_digest(stream, 'sha256').hexdigest()
        if is_notice:
            notices.append({'path': entry.name, 'sha256': sha})
        if entry.name.startswith('go/src/'):
            installed = goroot / Path(*path.parts[1:])
            if not installed.is_file() or installed.is_symlink():
                missing.append(entry.name)
            else:
                with installed.open('rb') as stream:
                    installed_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
                if installed_hash == sha:
                    matched += 1
                else:
                    different.append(entry.name)
report = {'schemaVersion': 1, 'version': pins['version'], 'archive': pins['archive'], 'sha256': pins['sha256'],
          'bytes': size, 'notices': notices, 'installedSourceComparison': {'matched': matched, 'missing': missing, 'different': different},
          'compilerBuildAttested': False, 'completeCorrespondingSource': False,
          'scope': 'Official checksum-pinned Go source release at the proxy compiler version; source files compared with the installed toolchain. This does not independently establish how the compiler executable was built or certify reproducible proxy binaries.'}
(output / 'go-source.json').write_text(json.dumps(report, indent=2) + '\n')
(output / 'SHA256SUMS').write_text(f"{pins['sha256']}  {pins['archive']}\n{hashlib.sha256((output / 'go-source.json').read_bytes()).hexdigest()}  go-source.json\n")
print(f'Preserved Go source; installed src comparison: {matched} matched, {len(missing)} missing, {len(different)} different')
