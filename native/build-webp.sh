#!/bin/sh
set -eu
cd /tmp
tar -xzf /inputs/libwebp-1.6.0.tar.gz
cd libwebp-1.6.0
./configure --disable-shared --enable-static --disable-threading --disable-libwebpmux \
    --disable-sdl --disable-png --disable-jpeg --disable-tiff --disable-gif
make -j4 -C sharpyuv
make -j4 -C src
mkdir -p /webp/bin /webp/share/webp
cc -O2 -Wall -Wextra -Werror -I src /inputs/webp-first-frame.c \
    src/demux/.libs/libwebpdemux.a src/.libs/libwebp.a -lm \
    -o /webp/bin/webp-first-frame
cp COPYING PATENTS AUTHORS /webp/share/webp/
cp /inputs/WEBP-PINS.json config.log /webp/share/webp/
