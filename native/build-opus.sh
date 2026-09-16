#!/bin/sh
set -eu
cd /tmp
tar -xzf /inputs/opus-1.6.1.tar.gz
cd opus-1.6.1
./configure --prefix=/opus --disable-shared --enable-static --disable-doc --disable-extra-programs
make -j4
make install
mkdir -p /codec/share/opus
cp COPYING AUTHORS /codec/share/opus/
cp /inputs/OPUS-PINS.json config.log /codec/share/opus/
