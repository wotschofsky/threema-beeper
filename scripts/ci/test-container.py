#!/usr/bin/env python3
"""Exercise the packaged runtime offline, without mounting host source or accounts."""
import json
import subprocess
import sys
from pathlib import Path

image, arch = sys.argv[1:3]
context = sys.argv[3] if len(sys.argv) == 4 else '.local/linux-ci-context'
assert len(sys.argv) in (3, 4)
assert arch in ('amd64', 'arm64')
record = json.loads(Path('docs/LINUX-RECOVERY-VERIFICATION.json').read_text())
subprocess.run(['node', 'scripts/entry.inspect-linux-image.ts', context, arch, image], check=True)
base = ['docker', 'run', '--rm', '--platform', 'linux/' + arch, '--network', 'none',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']
for kind in ('package', 'codecs'):
    files = record['packageTestFiles'] + [
        'tests/entry.portal-migration-rollback.ts', 'tests/entry.local-echo-confirmation.ts',
        'tests/entry.media-reply-crash.ts', 'tests/entry.status-crash.ts',
        'tests/entry.retained-confirmation.ts', 'tests/entry.profile-sync.ts',
        'tests/entry.ffmpeg-security.ts',
    ] if kind == 'package' else record['codecTestFiles']
    files = [name.replace('spikes/gate0/', 'tests/probes/') for name in files]
    command = base + ['--tmpfs', record['packageTmpfs' if kind == 'package' else 'codecTmpfs']]
    if kind == 'codecs':
        for name, value in record['codecEnvironment'].items():
            command += ['-e', name + '=' + value]
        if arch == 'amd64':
            command += ['-e', 'MEDIA_TEST_ADDRESS_SPACE_BYTES=4294967296']
    command += ['--entrypoint', 'node', image, 'scripts/entry.test-files.ts'] + files
    subprocess.run(command, check=True)
