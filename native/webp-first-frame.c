/* Decode one composited WebP frame to streamed RGBA PAM. Run under media-limits.
 * Input buffering stops at the first complete frame, not at the end of the animation.
 * Usage: webp-first-frame MAX_PREFIX_BYTES MAX_PIXELS
 */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <webp/demux.h>

static void fail(void) {
    fputs("WebP first-frame decoding failed\n", stderr);
    exit(1);
}
static uint64_t number(const char *text, uint64_t min, uint64_t max) {
    if (!text || !*text) fail();
    for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') fail();
    errno = 0;
    char *end;
    unsigned long long value = strtoull(text, &end, 10);
    if (errno || *end || value < min || value > max) fail();
    return value;
}
static uint32_t le32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
static void read_exact(uint8_t *buffer, size_t bytes) {
    if (fread(buffer, 1, bytes, stdin) != bytes) fail();
}
int main(int argc, char **argv) {
    if (argc != 3) fail();
    const size_t maximum = (size_t)number(argv[1], 32, 32 * 1024 * 1024);
    const uint64_t max_pixels = number(argv[2], 1, 100000000);
    size_t length = 12;
    uint8_t *prefix = malloc(length);
    if (!prefix) fail();
    read_exact(prefix, length);
    if (memcmp(prefix, "RIFF", 4) || memcmp(prefix + 8, "WEBP", 4)) fail();
    const uint64_t total = (uint64_t)le32(prefix + 4) + 8;
    if (total < 20 || total > 1024ULL * 1024 * 1024) fail();
    for (;;) {
        uint8_t header[8];
        if (length + 8 > total || length + 8 > maximum) fail();
        read_exact(header, 8);
        const uint32_t size = le32(header + 4);
        const uint64_t end = (uint64_t)length + 8 + size + (size & 1);
        if (end > total || end > maximum) fail();
        uint8_t *next = realloc(prefix, (size_t)end);
        if (!next) fail();
        prefix = next;
        memcpy(prefix + length, header, 8);
        read_exact(prefix + length + 8, size + (size & 1));
        length = (size_t)end;
        if (!memcmp(header, "ANMF", 4) || !memcmp(header, "VP8 ", 4) || !memcmp(header, "VP8L", 4)) break;
    }
    /* Supply a complete single-frame container to the library's animation compositor. */
    const uint32_t riff_size = (uint32_t)(length - 8);
    for (unsigned i = 0; i < 4; i++) prefix[4 + i] = (uint8_t)(riff_size >> (i * 8));
    const WebPData data = {prefix, length};
    WebPDemuxer *demux = WebPDemux(&data);
    if (!demux) fail();
    const uint32_t width = WebPDemuxGetI(demux, WEBP_FF_CANVAS_WIDTH);
    const uint32_t height = WebPDemuxGetI(demux, WEBP_FF_CANVAS_HEIGHT);
    WebPDemuxDelete(demux);
    if (!width || !height || width > 8192 || height > 8192 || (uint64_t)width * height > max_pixels) fail();
    WebPAnimDecoderOptions options;
    if (!WebPAnimDecoderOptionsInit(&options)) fail();
    options.color_mode = MODE_RGBA;
    options.use_threads = 0;
    WebPAnimDecoder *decoder = WebPAnimDecoderNew(&data, &options);
    if (!decoder) fail();
    uint8_t *pixels;
    int timestamp;
    if (!WebPAnimDecoderGetNext(decoder, &pixels, &timestamp)) fail();
    if (printf("P7\nWIDTH %u\nHEIGHT %u\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n", width, height) < 0) fail();
    const size_t bytes = (size_t)width * height * 4;
    if (fwrite(pixels, 1, bytes, stdout) != bytes || fflush(stdout)) fail();
    WebPAnimDecoderDelete(decoder);
    free(prefix);
    return 0;
}
