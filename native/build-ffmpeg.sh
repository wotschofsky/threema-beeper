#!/bin/sh
set -eu
cd /tmp
tar -xJf /inputs/ffmpeg-8.0.3.tar.xz
cd ffmpeg-8.0.3
PKG_CONFIG_PATH=/opus/lib/pkgconfig:/openh264/lib/pkgconfig ./configure --prefix=/usr --pkg-config-flags=--static --disable-doc --disable-debug --disable-ffplay \
    --disable-autodetect --disable-network --enable-zlib --enable-libopus --enable-libopenh264 \
    --disable-devices --enable-indev=lavfi \
    --disable-demuxer=vobsub --disable-parser=dvbsub \
    --disable-filter=hqdn3d,floodfill,swaprect --disable-muxer=spdif \
    --disable-encoders --enable-encoder=png,mjpeg,pam,gif,apng,rawvideo,aac,libopus,libopenh264,flac,pcm_s16le \
    --disable-decoders \
    --enable-decoder=png,mjpeg,gif,webp,apng,pam,rawvideo,wrapped_avframe,h264,hevc,vp8,vp9,aac,mp3,opus,vorbis,flac,pcm_s16le
make -j4 ffmpeg ffprobe
mkdir -p /codec/bin /codec/share/ffmpeg
install -m 755 ffmpeg ffprobe /codec/bin/
cp COPYING.LGPLv2.1 LICENSE.md /codec/share/ffmpeg/
cp /inputs/FFMPEG-PINS.json /codec/share/ffmpeg/
cp ffbuild/config.mak /codec/share/ffmpeg/config.mak
