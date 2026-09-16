import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';

const aliases: Readonly<Record<string, string>> = {
    'image/jpg': 'image/jpeg',
    'audio/x-wav': 'audio/wav',
    'audio/vnd.wave': 'audio/wav',
    'audio/x-flac': 'audio/flac',
    // libmagic identifies generic ISO-BMFF brands as video/mp4 even for audio-only tracks.
    'audio/mp4': 'video/mp4',
    'audio/x-m4a': 'video/mp4',
    'application/x-zip-compressed': 'application/zip',
};
function normalized(value: string): string {
    return aliases[value.toLowerCase()] ?? value.toLowerCase();
}

/** Uses libmagic through file(1). Header-only detection is a type check, not malware scanning. */
export class MimePolicy {
    private readonly executable: string;
    private readonly timeoutMs: number;
    constructor(executable = '/usr/bin/file', timeoutMs = 5000) {
        if (
            !isAbsolute(executable) ||
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 30000
        )
            throw new Error('Invalid MIME detector options');
        this.executable = executable;
        this.timeoutMs = timeoutMs;
    }
    async verify(header: Buffer, declared: string): Promise<void> {
        if (
            !Buffer.isBuffer(header) ||
            header.length > 4096 ||
            !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(declared)
        )
            throw new Error('Invalid MIME check');
        const detected = await this.detect(header);
        const expected = normalized(declared),
            actual = normalized(detected);
        // Generic binary files intentionally make no more specific type claim.
        if (expected === 'application/octet-stream' || actual === expected) return;
        throw new Error('MEDIA_MIME_MISMATCH');
    }
    private detect(header: Buffer): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(this.executable, ['--brief', '--mime-type', '-'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'},
            });
            let output = '',
                total = 0,
                settled = false;
            const timer = setTimeout(() => fail(), this.timeoutMs);
            function fail(): void {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.kill('SIGKILL');
                reject(new Error('MEDIA_MIME_DETECTOR_FAILED'));
            }
            child.on('error', fail);
            child.stdin.on('error', fail);
            child.stdout.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > 1024) fail();
                else output += chunk.toString('utf8');
            });
            child.stderr.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > 1024) fail();
            });
            child.on('close', (code) => {
                if (settled) return;
                if (
                    code !== 0 ||
                    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(output.trim())
                ) {
                    fail();
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve(output.trim());
            });
            child.stdin.end(header);
        });
    }
}
