import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeMutationContent} from '../src/outbox/mutation-content.ts';
await test('audio file fallback permits only caption changes with explicit projection evidence', () => {
    const original = {
        msgtype: 'm.audio',
        body: 'voice.flac',
        filename: 'voice.flac',
        file: {url: 'mxc://invalid/original'},
        info: {duration: 1000},
    };
    const replacement = {...original, body: 'caption'};
    assert.throws(() => normalizeMutationContent(original, replacement));
    assert.equal(
        normalizeMutationContent(original, replacement, {audioFileFallback: true}),
        'caption',
    );
    assert.equal(normalizeMutationContent(original, original, {audioFileFallback: true}), '');
    for (const change of [
        {file: {url: 'mxc://invalid/other'}},
        {info: {duration: 2000}},
        {filename: 'renamed'},
        {msgtype: 'm.file'},
    ])
        assert.throws(() =>
            normalizeMutationContent(
                original,
                {...replacement, ...change},
                {audioFileFallback: true},
            ),
        );
});
await test('text edits preserve plaintext and reply targets within the native byte limit', () => {
    const original = {msgtype: 'm.text', body: 'old'};
    assert.equal(
        normalizeMutationContent(original, {
            ...original,
            body: ' first\n🙂 ',
            format: 'org.matrix.custom.html',
            formatted_body: '<b>different</b>',
        }),
        ' first\n🙂 ',
    );
    assert.equal(
        normalizeMutationContent(original, {...original, body: '🙂'.repeat(1500)}).length,
        3000,
    );
    assert.throws(() => normalizeMutationContent(original, {...original, body: '🙂'.repeat(1501)}));
    assert.throws(() => normalizeMutationContent(original, {...original, body: ''}));
    for (const body of [' \n\t', '\u00a0\u2003\ufeff'])
        assert.throws(() => normalizeMutationContent(original, {...original, body}));
    const reply = {...original, 'm.relates_to': {'m.in_reply_to': {event_id: '$target'}}};
    assert.throws(() =>
        normalizeMutationContent(reply, {...reply, body: '> Person: quote\n\n \t'}),
    );
    assert.equal(
        normalizeMutationContent(reply, {...reply, body: '> Person: quote\n\nnew reply\n'}),
        'new reply\n',
    );
    assert.throws(() =>
        normalizeMutationContent(reply, {
            ...reply,
            'm.relates_to': {'m.in_reply_to': {event_id: '$other'}},
        }),
    );
    assert.throws(() => normalizeMutationContent(reply, original));
    assert.throws(() => normalizeMutationContent(original, {...original, msgtype: 'm.image'}));
});
await test('attachment edits preserve file identity and permit caption addition/removal only', () => {
    for (const msgtype of ['m.file', 'm.image', 'm.video']) {
        const original = {
            msgtype,
            body: 'name.bin',
            file: {url: 'mxc://invalid/file', hashes: {sha256: 'synthetic'}},
            info: {mimetype: 'application/octet-stream', size: 3},
        };
        assert.equal(
            normalizeMutationContent(original, {
                ...original,
                filename: 'name.bin',
                body: 'new caption',
            }),
            'new caption',
        );
        const captioned = {...original, filename: 'name.bin', body: 'old caption'};
        assert.equal(normalizeMutationContent(captioned, {...original}), '');
        for (const changed of [
            {...captioned, filename: 'new.bin'},
            {...captioned, file: {...original.file, url: 'mxc://invalid/other'}},
            {...captioned, info: {...original.info, size: 4}},
            {...captioned, 'm.new_content': {}},
        ])
            assert.throws(() => normalizeMutationContent(captioned, changed));
        assert.deepEqual(original.file, {url: 'mxc://invalid/file', hashes: {sha256: 'synthetic'}});
    }
    for (const msgtype of ['m.audio', 'm.poll'])
        assert.throws(() =>
            normalizeMutationContent({msgtype, body: 'old'}, {msgtype, body: 'new'}),
        );
});
