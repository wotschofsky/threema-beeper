"""Verify a Cargo vendor export against pinned lock and recorded build metadata."""
import hashlib
import json
from pathlib import Path
import sys
import tomllib


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def check(condition, message):
    if not condition:
        raise ValueError(message)


check(len(sys.argv) in [4, 5], 'Usage: verify-matrix-vendor.py <export> <build-metadata> <new-report> [matrix|libthreema]')
directory, metadata_path, report_path = map(Path, sys.argv[1:4])
component = sys.argv[4] if len(sys.argv) == 5 else 'matrix'
check(component in ['matrix', 'libthreema'], 'Unsupported source component')
check(not report_path.exists(), 'Refusing to replace existing report')
root = Path(__file__).resolve().parent.parent
coverage = json.loads((root / 'docs/NATIVE-SOURCE-COVERAGE.json').read_text())['matrixNativeCrypto' if component == 'matrix' else 'libthreema']
lock_path = 'Cargo.lock' if component == 'matrix' else 'packages/libthreema-wasm/libs/libthreema/Cargo.lock'
expected_lock = next(item['sha256'] for item in coverage['inputs'] if item['repositoryPath'] == lock_path)
check(digest(directory / 'Cargo.lock') == expected_lock, 'Export lock differs from pinned source')
builds = coverage['observedBuilds'].values() if component == 'matrix' else [coverage['observedBuild']]
known_metadata = {entry['sha256'] for build in builds
                  for entry in build['evidenceFiles'] if entry['filename'] == 'cargo-metadata.json'}
check(digest(metadata_path) in known_metadata, 'Unknown build metadata')
locked = tomllib.loads((directory / 'Cargo.lock').read_text())['package']
remote = [package for package in locked if package.get('source')]
metadata = json.loads(metadata_path.read_text())
expected = {(package['name'], package['version'], package['source']) for package in metadata['packages'] if package['source']}
records = []
found = set()
for crate in sorted((directory / 'vendor').iterdir()):
    check(crate.is_dir() and not crate.is_symlink(), 'Unexpected vendor entry')
    package = tomllib.loads((crate / 'Cargo.toml').read_text())['package']
    candidates = [item for item in remote if item['name'] == package['name'] and item['version'] == package['version']]
    check(len(candidates) == 1, f'Ambiguous or unlocked crate: {crate.name}')
    pin = candidates[0]
    key = (pin['name'], pin['version'], pin['source'])
    check(key not in found, 'Duplicate vendored crate')
    found.add(key)
    checksums = json.loads((crate / '.cargo-checksum.json').read_text())
    check(checksums['package'] == pin.get('checksum'), f'Package checksum differs: {crate.name}')
    files = {}
    for path in sorted(crate.rglob('*')):
        check(not path.is_symlink(), f'Unexpected symlink: {path}')
        if path.is_file() and path.name != '.cargo-checksum.json':
            files[path.relative_to(crate).as_posix()] = digest(path)
    check(files == checksums['files'], f'Vendor file inventory or checksum differs: {crate.name}')
    notices = {name: value for name, value in files.items()
               if Path(name).name.lower().startswith(('license', 'licence', 'notice', 'copying', 'copyright'))}
    records.append({'name': pin['name'], 'version': pin['version'], 'source': pin['source'],
                    'packageChecksum': pin.get('checksum'), 'files': len(files),
                    'licenseExpression': package.get('license'), 'licenseFile': package.get('license-file'),
                    'notices': notices, 'buildMetadataIncludesPackage': key in expected})
check(expected <= found, 'Recorded build dependencies missing from export')
missing_locked = sorted(set((p['name'], p['version'], p['source']) for p in remote) - found)
report = {'schemaVersion': 1, 'component': component,
          'sourceCommit': coverage['sourceCommit'] if component == 'matrix' else coverage['source']['commit'],
          'lockSha256': expected_lock, 'buildMetadataSha256': digest(metadata_path),
          'vendorConfigSha256': digest(directory / 'config.toml'),
          'packages': records, 'missingLockedPackages': missing_locked,
          'recordedBuildDependencyCoverage': True, 'completeCorrespondingSource': False,
          'scope': 'Cargo-vendored sources and file checksums checked against the pinned lock and recorded metadata. Git sources rely on Cargo locked revision selection; this is not an independent source attestation or complete license review.'}
report_path.write_text(json.dumps(report, indent=2) + '\n')
print(f'Checked {len(records)} vendored packages; {len(expected)} recorded build dependencies; {len(missing_locked)} unused locked packages absent')
