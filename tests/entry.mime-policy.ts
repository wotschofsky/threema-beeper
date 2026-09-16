import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MimePolicy} from '../src/media/mime-policy.ts';

await test('libmagic checks content signatures independently of claimed MIME', async () => {
    const policy = new MimePolicy();
    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
    );
    await policy.verify(png, 'image/png');
    await policy.verify(png, 'application/octet-stream');
    await assert.rejects(policy.verify(png, 'image/jpeg'), /MIME_MISMATCH/);
    await policy.verify(Buffer.from('%PDF-1.7\n'), 'application/pdf');
    await policy.verify(Buffer.from('plain text\n'), 'text/plain');
    await assert.rejects(
        policy.verify(Buffer.from('#!/bin/sh\necho renamed file\n'), 'image/png'),
        /MIME_MISMATCH/,
    );
    await assert.rejects(policy.verify(Buffer.alloc(4097), 'application/octet-stream'), /Invalid/);
    await assert.rejects(policy.verify(png, 'image/png; command=anything'), /Invalid/);
    await assert.rejects(
        new MimePolicy('/definitely-missing-file-command').verify(png, 'image/png'),
        /DETECTOR_FAILED/,
    );
});

await test('audio-only MP4 accepts the shared container signature without accepting unrelated files', async () => {
    const policy = new MimePolicy();
    const ftyp = Buffer.from('0000001c6674797069736f350000020069736f3569736f366d703431', 'hex');
    await policy.verify(ftyp, 'audio/mp4');
    await assert.rejects(policy.verify(Buffer.from('not an MP4'), 'audio/mp4'), /MIME_MISMATCH/);
    await assert.rejects(policy.verify(ftyp, 'image/png'), /MIME_MISMATCH/);
});
