#!/bin/sh
set -eu
cd /tmp
tar -xJf /inputs/dav1d-1.5.4.tar.xz
tar -xzf /inputs/libavif-1.4.2.tar.gz
tar -xzf /inputs/lcms2-2.19.tar.gz
cmake -S Little-CMS-lcms2.19 -B lcms-build -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DLCMS2_BUILD_SHARED=OFF -DLCMS2_BUILD_STATIC=ON \
    -DLCMS2_BUILD_TOOLS=OFF -DLCMS2_BUILD_TESTS=OFF \
    -DLCMS2_WITH_FASTFLOAT=OFF -DLCMS2_WITH_THREADED_PLUGIN=OFF
cmake --build lcms-build -j4
meson setup dav1d-build dav1d-1.5.4 --prefix=/avif-deps --libdir=lib \
    --buildtype=release --default-library=static --wrap-mode=nodownload \
    -Denable_tools=false -Denable_tests=false
ninja -C dav1d-build -j4
ninja -C dav1d-build install
export PKG_CONFIG_PATH=/avif-deps/lib/pkgconfig
cmake -S libavif-1.4.2 -B avif-build -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/avif-deps \
    -DBUILD_SHARED_LIBS=OFF -DAVIF_CODEC_DAV1D=SYSTEM -DAVIF_CODEC_AOM=OFF \
    -DAVIF_CODEC_LIBGAV1=OFF -DAVIF_CODEC_RAV1E=OFF -DAVIF_CODEC_SVT=OFF \
    -DAVIF_LIBYUV=OFF -DAVIF_LIBSHARPYUV=OFF \
    -DAVIF_BUILD_APPS=OFF -DAVIF_BUILD_TESTS=OFF -DFETCHCONTENT_FULLY_DISCONNECTED=ON
cmake --build avif-build -j4
mkdir -p /avif/bin /avif/share/libavif /avif/share/dav1d /avif/share/lcms2
cc -O2 -Wall -Wextra -Werror -I/tmp/libavif-1.4.2/include -I/tmp/Little-CMS-lcms2.19/include \
    /inputs/avif-first-frame.c /tmp/avif-build/libavif.a /avif-deps/lib/libdav1d.a \
    /tmp/lcms-build/liblcms2.a -lm -lpthread -ldl -o /avif/bin/avif-first-frame
cp libavif-1.4.2/LICENSE /avif/share/libavif/
cp dav1d-1.5.4/COPYING /avif/share/dav1d/
cp /inputs/AVIF-PINS.json avif-build/CMakeCache.txt /avif/share/libavif/
cp /inputs/DAV1D-PINS.json dav1d-build/meson-info/intro-buildoptions.json /avif/share/dav1d/
cp Little-CMS-lcms2.19/LICENSE /inputs/LCMS-PINS.json lcms-build/CMakeCache.txt /avif/share/lcms2/
