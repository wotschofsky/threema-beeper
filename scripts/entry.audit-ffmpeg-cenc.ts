import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {auditCencGuards} from './ffmpeg-cenc-audit.ts';
import {verifyContextIntegrity} from './linux-context-integrity.ts';

const root = resolve(import.meta.dirname, '..');
const [context, observationsPath] = process.argv.slice(2);
assert(process.argv.length === 2 || (process.argv.length === 4 && context && observationsPath),
    'Usage: node scripts/entry.audit-ffmpeg-cenc.ts [build-context image-observations.json]');
const pins = JSON.parse(readFileSync(join(root, 'docs/FFMPEG-PINS.json'), 'utf8'));
assert.equal(pins.version, '8.0.3', 'Re-review a changed FFmpeg release');
const archive = context ? join(resolve(context), '.artifacts/ffmpeg', pins.archive)
    : join(root, '.local/codec-sources', pins.archive);
let buildEvidence: {buildContextSha256: string; images: Record<string, string>} | undefined;
if (context && observationsPath) {
    const buildContextSha256 = verifyContextIntegrity(resolve(context));
    const observations = JSON.parse(readFileSync(resolve(observationsPath), 'utf8'));
    assert.equal(observations.schemaVersion, 1);
    assert(Array.isArray(observations.images));
    assert.equal(observations.images.length, 2, 'Require both image architectures');
    const images: Record<string, string> = {};
    for (const image of observations.images) {
        assert(['amd64', 'arm64'].includes(image.architecture));
        assert(!Object.hasOwn(images, image.architecture), 'Duplicate architecture');
        assert.equal(image.inputSha256, buildContextSha256, 'Image belongs to another build context');
        assert.match(image.imageId, /^sha256:[a-f0-9]{64}$/);
        images[image.architecture] = image.imageId;
    }
    buildEvidence = {buildContextSha256, images};
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(readFileSync(archive)), pins.sha256, 'FFmpeg source archive changed');
const patch = readFileSync(join(root, 'native/security-evidence/ffmpeg-cenc-upstream.patch'));
assert.equal(hash(patch), '39064098f0e4bc7d663d59e0cb37534bc36174026626f360291e1c8971c899d7', 'Upstream evidence patch changed');
const source = execFileSync('tar', ['-xOf', archive, 'ffmpeg-8.0.3/libavformat/mov.c'], {maxBuffer: 8 * 1024 * 1024});
const functions = auditCencGuards(source.toString('utf8'));
// CVE-2026-66040 concerns PNG EXIF serialization introduced after this source.
// Bind this absence assessment to the exact reviewed file, not just a version label.
const pngSource = execFileSync('tar', ['-xOf', archive, 'ffmpeg-8.0.3/libavcodec/pngenc.c']);
assert.equal(hash(pngSource), '11e94ec737d349b730913c6150a494920856823da2610d2eae8c6ee3be63d9a3',
    'Re-review PNG encoder security when its source changes');
assert(!/add_exif_profile_size|AV_FRAME_DATA_EXIF|eXIf/.test(pngSource.toString('utf8')),
    'Re-review PNG EXIF serialization');
console.log(JSON.stringify({
    cve: 'CVE-2026-40962', assessment: 'fix-present-in-pinned-source',
    version: pins.version, archiveSha256: pins.sha256, sourceSha256: hash(source),
    fixCommit: 'e392fb8c9c3949d975531d2b23c645d2465a7ebc',
    backportCommit: '2b14ba12669d75f5f73d8634c6db36e704144532',
    patchSha256: hash(patch), checkedFunctions: functions,
    pngExifReview: {cve: 'CVE-2026-66040', assessment: 'affected-code-absent', sourceSha256: hash(pngSource)},
    scope: 'Source backport presence; not a blanket FFmpeg safety assessment or a crafted-media exploit test',
    ...buildEvidence,
}, null, 2));
