#!/bin/sh
set -eu
cd /tmp
tar -xzf /inputs/libjpeg-turbo-3.2.0.tar.gz
cmake -S libjpeg-turbo-3.2.0 -B jpeg-build -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=OFF -DENABLE_STATIC=ON \
    -DWITH_TURBOJPEG=OFF -DWITH_TOOLS=OFF -DWITH_TESTS=OFF \
    -DWITH_ARITH_ENC=OFF -DWITH_ARITH_DEC=OFF -DREQUIRE_SIMD=ON
cmake --build jpeg-build --target jpeg-static -j4
mkdir -p /jpeg/bin /jpeg/share/libjpeg-turbo
cc -O2 -Wall -Wextra -Werror -I jpeg-build -I libjpeg-turbo-3.2.0/src \
    /inputs/jpeg-encode.c jpeg-build/libjpeg.a -lm -o /jpeg/bin/jpeg-encode
cp libjpeg-turbo-3.2.0/LICENSE.md libjpeg-turbo-3.2.0/README.ijg \
    /inputs/JPEG-PINS.json jpeg-build/CMakeCache.txt /jpeg/share/libjpeg-turbo/
