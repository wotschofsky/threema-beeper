"""Download exact OS source versions in an account-free inspection container."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise ValueError('Usage: collect-debian-sources.py <new-directory-under-.local>')
output = Path(sys.argv[1]).resolve()
if not output.is_relative_to(root / '.local') or output.exists() or ',' in str(output):
    raise ValueError('Use a fresh directory under .local without commas')
record_path = root / 'docs/OS-NOTICE-VERIFICATION.json'
record = json.loads(record_path.read_text())
requirements = record['sourcePackagesRequired']
for item in requirements:
    if not re.fullmatch('[a-z0-9][a-z0-9+.-]*', item['name']) or not re.fullmatch('[a-zA-Z0-9.+:~_-]+', item['version']):
        raise ValueError('Invalid exact source requirement')
if len({item['name'] for item in requirements}) != len(requirements):
    raise ValueError('Multiple source versions require separate download directories')
image = next(item for item in record['images'] if item['architecture'] == 'arm64')['imageId']
if not re.fullmatch('sha256:[a-f0-9]{64}', image):
    raise ValueError('Invalid collector image')
output.mkdir(mode=0o700)
(output / 'required.txt').write_text(''.join(f"{item['name']}={item['version']}\n" for item in requirements))
shutil.copyfile(root / 'scripts/collect-debian-sources.sh', output / 'collect.sh')
(output / 'request.json').write_text(json.dumps({'schemaVersion': 1, 'collectorImageId': image,
    'requirementsSha256': hashlib.sha256(record_path.read_bytes()).hexdigest(), 'sourcePackagesRequired': requirements}, indent=2) + '\n')
result = subprocess.run(['docker', 'run', '--rm', '--pull=never', '--platform=linux/arm64', '--user=0:0',
                         '--cap-drop=ALL', '--cap-add=SETUID', '--cap-add=SETGID', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE',
                         '--security-opt=no-new-privileges', '--entrypoint=/bin/sh',
                         '--mount', f'type=bind,src={output},dst=/work', image, '/work/collect.sh'])
if result.returncode:
    raise SystemExit('Source collection incomplete; inspect results.tsv and fetch logs. Existing output is retained; no versions were substituted.')
print('Exact source download pass finished; descriptor and payload verification is still required')
