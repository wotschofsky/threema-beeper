#!/bin/sh
set -eu
cd /tmp
tar -xzf /inputs/openh264-2.6.0.tar.gz
cd openh264-2.6.0
make -j4 PREFIX=/openh264 BUILDTYPE=Release install-static
mkdir -p /codec/share/openh264
cp LICENSE CONTRIBUTORS /codec/share/openh264/
cp /inputs/OPENH264-PINS.json /codec/share/openh264/
cp openh264-static.pc /codec/share/openh264/
