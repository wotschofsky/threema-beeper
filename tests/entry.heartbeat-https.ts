import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {heartbeat} from '../src/operations/heartbeat.ts';

if (process.argv[2] === '--client') {
    let input = '';
    for await (const chunk of process.stdin) input += String(chunk);
    const {url, healthy} = JSON.parse(input);
    const result = await heartbeat(new URL(url), async () => ({healthy}));
    process.stdout.write(JSON.stringify({result}) + '\n');
} else {
    await test('real HTTPS heartbeat rejects redirects, untrusted TLS, server errors and stalled responses', {timeout: 30000}, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'threema-heartbeat-tls-'));
        const keyFile = join(directory, 'key.pem');
        const certFile = join(directory, 'cert.pem');
        const requests: {path: string; method: string | undefined; authorization: string | undefined; cookie: string | undefined; bytes: number}[] = [];
        let redirected = 0;
        const server = createServer();
        try {
            // Ephemeral synthetic certificate, trusted only by the test child process.
            await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost',
                '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], {timeout: 10000});
            server.setSecureContext({key: await readFile(keyFile), cert: await readFile(certFile)});
            server.on('request', (request, response) => {
                const row = {path: request.url!, method: request.method,
                    authorization: request.headers.authorization, cookie: request.headers.cookie, bytes: 0};
                requests.push(row);
                request.on('data', chunk => { row.bytes += chunk.length; });
                if (request.url === '/success-secret') response.writeHead(204).end();
                else if (request.url === '/redirect-secret') response.writeHead(302, {Location: '/unexpected'}).end();
                else if (request.url === '/unexpected') { redirected++; response.end(); }
                else if (request.url === '/error-secret') response.writeHead(503).end('sensitive provider diagnostic');
                // /stall-secret deliberately never sends response headers.
            });
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            const address = server.address();
            assert(address && typeof address !== 'string');
            const base = `https://127.0.0.1:${address.port}`;
            const run = async (path: string, healthy = true, trust = true) => {
                const env = {...process.env};
                delete env.NODE_TLS_REJECT_UNAUTHORIZED;
                delete env.NODE_EXTRA_CA_CERTS;
                if (trust) env.NODE_EXTRA_CA_CERTS = certFile;
                const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--client'], {
                    env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000,
                });
                let output = ''; let errors = '';
                child.stdout.on('data', chunk => { output += String(chunk); });
                child.stderr.on('data', chunk => { errors += String(chunk); });
                child.stdin.end(JSON.stringify({url: base + path, healthy}));
                const [code, signal] = await once(child, 'close');
                assert.equal(signal, null);
                assert.equal(code, 0, errors);
                assert.equal(errors, '');
                assert(!output.includes('secret') && !output.includes('sensitive'));
                return JSON.parse(output).result;
            };
            assert.equal(await run('/success-secret', false), 'unhealthy');
            assert.equal(requests.length, 0);
            assert.equal(await run('/success-secret', true, false), 'ping-failed');
            assert.equal(requests.length, 0);
            assert.equal(await run('/success-secret'), 'sent');
            assert.equal(await run('/redirect-secret'), 'ping-failed');
            assert.equal(redirected, 0);
            assert.equal(await run('/error-secret'), 'ping-failed');
            const started = Date.now();
            assert.equal(await run('/stall-secret'), 'ping-failed');
            assert(Date.now() - started >= 9000, 'Exercise the real request timeout');
            assert.equal(requests.length, 4, 'No automatic retries or redirect follow-up');
            for (const request of requests) {
                assert.equal(request.method, 'GET'); assert.equal(request.bytes, 0);
                assert.equal(request.authorization, undefined); assert.equal(request.cookie, undefined);
            }
        } finally {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            await rm(directory, {recursive: true, force: true});
        }
    });
}
