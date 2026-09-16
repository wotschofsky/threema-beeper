import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

// This is an assertion about the shipped Linux codec, not the developer's FFmpeg.
await test('packaged FFmpeg excludes reviewed vulnerable optional components', () => {
    const config = readFileSync('/usr/share/ffmpeg/config.mak', 'utf8');
    for (const name of [
        'VOBSUB_DEMUXER', 'DVBSUB_PARSER', 'HQDN3D_FILTER', 'FLOODFILL_FILTER',
        'SWAPRECT_FILTER', 'SPDIF_MUXER', 'MAGICYUV_DECODER', 'CFHD_DECODER',
        'ADPCM_ADX_DECODER', 'MACE6_DECODER', 'TDSC_DECODER', 'SHORTEN_DECODER',
        'QUIRC_FILTER', 'VULKAN', 'NVDEC', 'RTPDEC',
    ]) {
        assert(config.split('\n').includes(`!CONFIG_${name}=yes`), `${name} must be disabled`);
        assert(!config.split('\n').includes(`CONFIG_${name}=yes`), `${name} unexpectedly enabled`);
    }
    const list = (option: string) => execFileSync('/usr/bin/ffmpeg', ['-hide_banner', option],
        {encoding: 'utf8', timeout: 10000});
    const demuxers = list('-demuxers');
    assert(!/^\s*D\s+vobsub\s/m.test(demuxers));
    const filters = list('-filters');
    assert(!/^\s*\S+\s+(hqdn3d|floodfill|swaprect|quirc)\s/m.test(filters));
    const decoders = list('-decoders');
    assert(!/^\s*\S+\s+(magicyuv|cfhd|adpcm_adx|mace6|tdsc|shorten)\s/m.test(decoders));
    assert(!/^\s*E\s+spdif\s/m.test(list('-muxers')));
});
