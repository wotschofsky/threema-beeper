# OpenH264 source build

The codec image now builds OpenH264 2.6.0 from a SHA-256-pinned upstream source archive,
then statically links it into FFmpeg 8.0.3 through `--enable-libopenh264`. Only the encoder
is enabled in FFmpeg; H.264 decoding continues to use FFmpeg's existing decoder. OpenH264's
static pkg-config metadata supplies its C++/pthread/math link dependencies. The build adds
g++ to the codec builder, while runtime images receive only the resulting FFmpeg tools and
OpenH264 LICENSE, CONTRIBUTORS, pin and static pkg-config metadata.

Sources: [upstream release](https://github.com/cisco/openh264/releases/tag/v2.6.0),
[upstream build rules](https://github.com/cisco/openh264/blob/v2.6.0/Makefile),
[FFmpeg codec integration](https://www.ffmpeg.org/ffmpeg-codecs.html#libopenh264).
The SHA-256 was calculated from the complete HTTPS source archive; this is not detached
signature verification. This builds source rather than redistributing Cisco's separately
licensed binary package. Release licensing/source-offer/SBOM work remains incomplete.

Context v37: `bd910bccc560b10076e3c75d0ad3b1f943799334d0de185fe09ed3188dc9ab8f`.
ARM64 service image: `sha256:5cb7f4b9d00c8ca405b04a582152d67f11c5f79c064beb0b6956c7910d41f8a7`
(tag `threema-beeper-service:openh264-arm64`). Build and ten embedded tests passed: video
encoder, video journal recovery, prepared-video parser, audio preparation and audio fallback.
A further six prepared-video controller and backend lifecycle tests passed.
The encoder test generates six RGB frames, encodes MP4/H.264, verifies codec and dimensions,
and decodes exactly six YUV420 frames. It runs under the native process limiter with 512 MiB
address space, offline/read-only/capability-dropped container, 768 MiB container memory and
64 MiB temporary filesystem. Tests use only embedded application code and synthetic media.
AMD64 service image `sha256:ab02d1fa41c8bbfedbb212aa5cc0933629223b8264d3a9720d6b3dadc3da056b`
(tag `threema-beeper-service:openh264-amd64`) also built successfully from v37 and passes the
same sixteen embedded tests. This is emulated AMD64 on the ARM64 host, using a 4 GiB child
address-space ceiling with the same 768 MiB container memory cap; native AMD64 under the
512 MiB address-space ceiling remains unverified. Logs are
`.local/linux-openh264-amd64-{build,test}.log`. These v37 images predate encrypted random
access reads and the video-source parser fixture added afterward.

The host Homebrew FFmpeg 9.0.1 does not include OpenH264, and the encoder test fails there;
it must run against the pinned Linux encoder. This foundation does not yet implement video
preparation policy, encrypted video staging or production video admission, and does not prove
Desktop byte parity, mobile playback or live delivery.
