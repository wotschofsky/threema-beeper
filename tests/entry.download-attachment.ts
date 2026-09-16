import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCipheriv, createHash, randomBytes} from 'node:crypto';
import {mkdtemp, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {
    getRequestFn,
    setRequestFn,
} from '../.local/sources/matrix-appservice-bridge/node_modules/@vector-im/matrix-bot-sdk/lib/request.js';
import {downloadAttachment} from '../src/media/download-attachment.ts';
await test('SDK transport downloads authenticated ciphertext through the homeserver with bounded preparation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'download-media-'));
    const original = getRequestFn();
    const key = randomBytes(32),
        iv = randomBytes(16),
        plain = Buffer.from('fixture');
    const cipher = createCipheriv('aes-256-ctr', key, iv),
        encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const input = {
        bytes: plain.length,
        maxBytes: 100,
        mimeType: 'application/octet-stream',
        file: {
            v: 'v2',
            key: {kty: 'oct', alg: 'A256CTR', key_ops: ['decrypt'], k: key.toString('base64url')},
            iv: iv.toString('base64'),
            hashes: {sha256: createHash('sha256').update(encrypted).digest('base64')},
        },
        verifyMime: async () => {},
    };
    let status = 200,
        declared = String(plain.length),
        calls = 0;
    const client = {
        homeserverUrl: 'https://homeserver.invalid',
        accessToken: 'synthetic-token',
        doesServerSupportVersion: async () => true,
    };
    try {
        setRequestFn(async (url: URL, opts: any) => {
            calls++;
            assert.equal(url.origin, client.homeserverUrl);
            assert.equal(url.pathname, '/_matrix/client/v1/media/download/remote.invalid/opaque');
            assert.equal(url.searchParams.get('user_id'), '@bot:invalid');
            assert.equal(opts.headers.Authorization, 'Bearer synthetic-token');
            assert.ok(opts.dispatcher);
            assert.ok(opts.signal);
            return {
                statusCode: status,
                headers: {'content-length': declared},
                body:
                    status === 200
                        ? Readable.from([encrypted])
                        : new Readable({
                              read() {},
                              destroy(_error, callback) {
                                  callback(new Error('synthetic rejected response abort'));
                              },
                          }),
            };
        });
        const result = await downloadAttachment(
            client,
            '@bot:invalid',
            'mxc://remote.invalid/opaque',
            directory,
            input,
        );
        const parts: Buffer[] = [];
        for await (const part of result.stream()) parts.push(part);
        assert.deepEqual(Buffer.concat(parts), plain);
        await result.dispose();
        declared = '10000';
        await assert.rejects(
            downloadAttachment(
                client,
                '@bot:invalid',
                'mxc://remote.invalid/opaque',
                directory,
                input,
            ),
            /download or verification failed/,
        );
        declared = String(plain.length);
        status = 302;
        await assert.rejects(
            downloadAttachment(
                client,
                '@bot:invalid',
                'mxc://remote.invalid/opaque',
                directory,
                input,
            ),
        );
        assert.equal(calls, 3, 'Redirect responses are not retried at their location');
        await assert.rejects(
            downloadAttachment(
                client,
                '@bot:invalid',
                'https://remote.invalid/private',
                directory,
                input,
            ),
        );
        assert.equal(calls, 3);
        const stalled = {...client, doesServerSupportVersion: () => new Promise<boolean>(() => {})};
        await assert.rejects(
            downloadAttachment(
                stalled,
                '@bot:invalid',
                'mxc://remote.invalid/opaque',
                directory,
                input,
                10,
            ),
        );
        const beeper = {...client, homeserverUrl: 'https://matrix.beeper.com/_hungryserv/fixture'};
        let redirects = 0;
        let location =
            'https://prod-hungryserv-media-weur-2.' +
            'a'.repeat(32) +
            '.r2.cloudflarestorage.com/fixture?signature=synthetic';
        setRequestFn(async (url: URL, opts: any) => {
            if (url.origin === 'https://matrix.beeper.com') {
                assert.equal(opts.headers.Authorization, 'Bearer synthetic-token');
                return {statusCode: 307, headers: {location}, body: Readable.from([])};
            }
            redirects++;
            assert.equal(opts.headers?.Authorization, undefined, 'Never forward the Matrix token');
            return {
                statusCode: 200,
                headers: {'content-length': String(plain.length)},
                body: Readable.from([encrypted]),
            };
        });
        const redirected = await downloadAttachment(
            beeper,
            '@bot:invalid',
            'mxc://remote.invalid/opaque',
            directory,
            input,
        );
        await redirected.dispose();
        assert.equal(redirects, 1);
        for (location of [
            'https://evil.invalid/media',
            'http://127.0.0.1/private',
            'https://prod-hungryserv-media-weur-2.' +
                'a'.repeat(32) +
                '.r2.cloudflarestorage.com.evil.invalid/media',
        ])
            await assert.rejects(
                downloadAttachment(
                    beeper,
                    '@bot:invalid',
                    'mxc://remote.invalid/opaque',
                    directory,
                    input,
                ),
            );
        assert.equal(redirects, 1, 'Unapproved destinations never receive a request');
        assert.deepEqual(await readdir(directory), []);
    } finally {
        setRequestFn(original);
        key.fill(0);
        await rm(directory, {recursive: true, force: true});
    }
});
