/* First AVIF frame to RGBA PAM. Invoke under media-limits; no plaintext files.
 * Usage: avif-first-frame MAX_PREFIX_BYTES MAX_PIXELS INPUT_BYTES
 * ICC-to-sRGB is supported; CICP/HDR parity and production admission remain pending.
 */
#include <avif/avif.h>
#include <lcms2.h>
#include <math.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void fail(void) {
    fputs("AVIF first-frame decoding failed\n", stderr);
    exit(1);
}
static uint64_t number(const char *s, uint64_t min, uint64_t max) {
    if (!s || !*s) fail();
    for (const char *p = s; *p; p++) if (*p < '0' || *p > '9') fail();
    errno = 0;
    char *end;
    unsigned long long n = strtoull(s, &end, 10);
    if (errno || *end || n < min || n > max) fail();
    return n;
}
typedef struct {
    uint8_t *bytes;
    size_t length, capacity, maximum;
} Prefix;

static avifResult read_prefix(avifIO *io, uint32_t flags, uint64_t offset,
                              size_t size, avifROData *out) {
    Prefix *p = io->data;
    if (flags || offset > io->sizeHint) return AVIF_RESULT_IO_ERROR;
    if (size > io->sizeHint - offset) size = (size_t)(io->sizeHint - offset);
    if (!size) {
        out->data = NULL;
        out->size = 0;
        return AVIF_RESULT_OK;
    }
    if (offset > p->maximum || size > p->maximum - offset) return AVIF_RESULT_IO_ERROR;
    const size_t end = (size_t)offset + size;
    if (end > p->capacity) {
        size_t capacity = p->capacity ? p->capacity : 4096;
        while (capacity < end) capacity *= 2;
        if (capacity > p->maximum) capacity = p->maximum;
        uint8_t *next = realloc(p->bytes, capacity);
        if (!next) return AVIF_RESULT_OUT_OF_MEMORY;
        p->bytes = next;
        p->capacity = capacity;
    }
    if (end > p->length) {
        const size_t needed = end - p->length;
        if (fread(p->bytes + p->length, 1, needed, stdin) != needed) return AVIF_RESULT_IO_ERROR;
        p->length = end;
    }
    out->data = p->bytes + offset;
    out->size = size;
    return AVIF_RESULT_OK;
}

/* Return NULL only for the implicit sRGB case. ICC takes precedence over CICP. */
static cmsHPROFILE input_color_profile(const avifImage *source) {
    if (source->icc.size) {
        if (source->icc.size > 4 * 1024 * 1024) fail();
        cmsHPROFILE profile = cmsOpenProfileFromMem(source->icc.data, (cmsUInt32Number)source->icc.size);
        if (!profile || cmsGetColorSpace(profile) != cmsSigRgbData) fail();
        return profile;
    }
    const avifColorPrimaries primaries = source->colorPrimaries == AVIF_COLOR_PRIMARIES_UNSPECIFIED
        ? AVIF_COLOR_PRIMARIES_BT709 : source->colorPrimaries;
    /* Pinned Electron treats BT.709 transfer as sRGB in the executed AVIF fixture. */
    const avifTransferCharacteristics transfer = (source->transferCharacteristics == AVIF_TRANSFER_CHARACTERISTICS_UNSPECIFIED ||
        source->transferCharacteristics == AVIF_TRANSFER_CHARACTERISTICS_BT709)
        ? AVIF_TRANSFER_CHARACTERISTICS_SRGB : source->transferCharacteristics;
    if (primaries == AVIF_COLOR_PRIMARIES_BT709 && transfer == AVIF_TRANSFER_CHARACTERISTICS_SRGB) return NULL;
    switch (primaries) {
        case AVIF_COLOR_PRIMARIES_BT709: case AVIF_COLOR_PRIMARIES_BT470M:
        case AVIF_COLOR_PRIMARIES_BT470BG: case AVIF_COLOR_PRIMARIES_BT601:
        case AVIF_COLOR_PRIMARIES_SMPTE240: case AVIF_COLOR_PRIMARIES_GENERIC_FILM:
        case AVIF_COLOR_PRIMARIES_BT2020: case AVIF_COLOR_PRIMARIES_SMPTE431:
        case AVIF_COLOR_PRIMARIES_SMPTE432: case AVIF_COLOR_PRIMARIES_EBU3213: break;
        default: fail();
    }
    cmsToneCurve *curve = NULL;
    float gamma;
    if (transfer == AVIF_TRANSFER_CHARACTERISTICS_SRGB) {
        const double parameters[5] = {2.4, 1.0 / 1.055, 0.055 / 1.055, 1.0 / 12.92, 0.04045};
        curve = cmsBuildParametricToneCurve(NULL, 4, parameters);
    } else if (transfer == AVIF_TRANSFER_CHARACTERISTICS_BT709 ||
               transfer == AVIF_TRANSFER_CHARACTERISTICS_BT601 ||
               transfer == AVIF_TRANSFER_CHARACTERISTICS_BT2020_10BIT ||
               transfer == AVIF_TRANSFER_CHARACTERISTICS_BT2020_12BIT) {
        /* Same inverse curve and precise breakpoint as pinned libavif src/colr.c. */
        const double parameters[5] = {1.0 / 0.45, 1.0 / 1.09929682680944,
            0.09929682680944 / 1.09929682680944, 1.0 / 4.5, 4.5 * 0.018053968510807};
        curve = cmsBuildParametricToneCurve(NULL, 4, parameters);
    } else if (transfer == AVIF_TRANSFER_CHARACTERISTICS_SMPTE240) {
        const double parameters[5] = {1.0 / 0.45, 1.0 / 1.111572195921731,
            0.111572195921731 / 1.111572195921731, 1.0 / 4.0, 4.0 * 0.022821585529445};
        curve = cmsBuildParametricToneCurve(NULL, 4, parameters);
    } else if (avifTransferCharacteristicsGetGamma(transfer, &gamma) == AVIF_RESULT_OK) {
        curve = cmsBuildGamma(NULL, gamma);
    } else {
        /* Other SDR curves and HDR tone mapping require renderer parity work. */
        fail();
    }
    if (!curve) fail();
    float values[8];
    avifColorPrimariesGetValues(primaries, values);
    const cmsCIExyY white = {values[6], values[7], 1};
    const cmsCIExyYTRIPLE colors = {{values[0], values[1], 1},
        {values[2], values[3], 1}, {values[4], values[5], 1}};
    cmsToneCurve *curves[3] = {curve, curve, curve};
    cmsHPROFILE profile = cmsCreateRGBProfile(&white, &colors, curves);
    cmsFreeToneCurve(curve);
    if (!profile) fail();
    return profile;
}

/* SDR canvas tone mapping follows pinned Chromium cc/paint/tone_map_util.cc.
 * Work in linear Rec.2020; HLG OOTF and Reinhard gain depend on the whole pixel.
 */
static void tone_map_hdr(avifRGBImage *rgb, const avifImage *source) {
    avifImage linear_source = *source;
    linear_source.transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_LINEAR;
    avifImage linear_2020 = linear_source;
    linear_2020.colorPrimaries = AVIF_COLOR_PRIMARIES_BT2020;
    cmsHPROFILE source_profile = input_color_profile(&linear_source);
    cmsHPROFILE working_profile = input_color_profile(&linear_2020);
    cmsHPROFILE destination = cmsCreate_sRGBProfile();
    if (!source_profile || !working_profile || !destination) fail();
    const cmsUInt32Number flags = cmsFLAGS_COPY_ALPHA | cmsFLAGS_NOOPTIMIZE;
    cmsHTRANSFORM to_working = cmsCreateTransform(source_profile, TYPE_RGBA_FLT,
        working_profile, TYPE_RGBA_FLT, INTENT_RELATIVE_COLORIMETRIC, flags);
    cmsHTRANSFORM to_output = cmsCreateTransform(working_profile, TYPE_RGBA_FLT,
        destination, TYPE_RGBA_8, INTENT_RELATIVE_COLORIMETRIC, flags);
    if (!to_working || !to_output) fail();
    float *row = malloc((size_t)rgb->width * 4 * sizeof(float));
    if (!row) fail();
    const int pq = source->transferCharacteristics == AVIF_TRANSFER_CHARACTERISTICS_PQ;
    const double white = 203.0;
    /* The executed Desktop createImageBitmap/canvas path drops CLLI metadata.
     * Its default 1000-nit content maximum also applies to the 4000-nit fixture. */
    const double content_max = 1000.0 / white;
    for (uint32_t y = 0; y < rgb->height; y++) {
        uint8_t *scanline = rgb->pixels + (size_t)y * rgb->rowBytes;
        for (uint32_t x = 0; x < rgb->width; x++) {
            for (unsigned c = 0; c < 3; c++) {
                const double encoded = scanline[(size_t)x * 4 + c] / 255.0;
                double linear;
                if (pq) {
                    const double power = pow(encoded, 1.0 / 78.84375);
                    linear = pow(fmax(power - 0.8359375, 0.0) /
                        (18.8515625 - 18.6875 * power), 1.0 / 0.1593017578125);
                } else {
                    linear = encoded <= 0.5 ? encoded * encoded / 3.0 :
                        (exp((encoded - 0.55991073) / 0.17883277) + 0.28466892) / 12.0;
                }
                row[(size_t)x * 4 + c] = (float)linear;
            }
            row[(size_t)x * 4 + 3] = scanline[(size_t)x * 4 + 3] / 255.0f;
        }
        cmsDoTransform(to_working, row, row, rgb->width);
        for (uint32_t x = 0; x < rgb->width; x++) {
            float *pixel = row + (size_t)x * 4;
            double scale = pq ? 10000.0 / white : 1000.0 / white;
            if (!pq) {
                const double luminance = 0.2627 * pixel[0] + 0.6780 * pixel[1] + 0.0593 * pixel[2];
                scale *= pow(fmax(luminance, 0.0), 0.2);
            }
            const double maximum = fmax(fmax(pixel[0], pixel[1]), pixel[2]) * scale;
            if (maximum > 0 && content_max > 1)
                scale *= (1.0 + maximum / (content_max * content_max)) / (1.0 + maximum);
            for (unsigned c = 0; c < 3; c++) {
                pixel[c] = (float)(pixel[c] * scale);
                if (!isfinite(pixel[c])) fail();
            }
        }
        cmsDoTransform(to_output, row, scanline, rgb->width);
        /* Canvas clears fully transparent pixels; hidden HDR values must not survive. */
        for (uint32_t x = 0; x < rgb->width; x++) {
            uint8_t *pixel = scanline + (size_t)x * 4;
            if (!pixel[3]) memset(pixel, 0, 4);
        }
    }
    free(row);
    cmsDeleteTransform(to_working);
    cmsDeleteTransform(to_output);
    cmsCloseProfile(source_profile);
    cmsCloseProfile(working_profile);
    cmsCloseProfile(destination);
}

int main(int argc, char **argv) {
    if (argc != 4) fail();
    Prefix prefix = {0};
    prefix.maximum = (size_t)number(argv[1], 32, 32 * 1024 * 1024);
    const uint32_t max_pixels = (uint32_t)number(argv[2], 1, 100000000);
    avifIO io = {0};
    io.read = read_prefix;
    io.sizeHint = number(argv[3], 1, 1024ULL * 1024 * 1024);
    io.data = &prefix;
    avifDecoder *decoder = avifDecoderCreate();
    if (!decoder) fail();
    decoder->maxThreads = 1;
    decoder->imageSizeLimit = max_pixels;
    decoder->imageDimensionLimit = 8192;
    decoder->ignoreExif = AVIF_TRUE;
    decoder->ignoreXMP = AVIF_TRUE;
    avifDecoderSetIO(decoder, &io);
    if (avifDecoderParse(decoder) != AVIF_RESULT_OK ||
        avifDecoderNextImage(decoder) != AVIF_RESULT_OK) fail();
    const avifImage *source = decoder->image;
    const unsigned angle = (source->transformFlags & AVIF_TRANSFORM_IROT) ? source->irot.angle : 0;
    const int mirror = (source->transformFlags & AVIF_TRANSFORM_IMIR) ? source->imir.axis : -1;
    if (angle > 3 || mirror > 1) fail();
    avifImage *view = avifImageCreateEmpty();
    if (!view) fail();
    avifCropRect crop = {0, 0, source->width, source->height};
    /* Pinned Electron 40.10.0 createImageBitmap ignores clean-aperture cropping.
     * Preserve the full decoded canvas before irot/imir, matching Desktop output.
     * See the executable renderer probe and docs/AVIF-PARITY.md.
     */
    if (avifImageSetViewRect(view, source, &crop) != AVIF_RESULT_OK) fail();
    avifRGBImage rgb;
    avifRGBImageSetDefaults(&rgb, view);
    rgb.depth = 8;
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.alphaPremultiplied = AVIF_FALSE;
    if (avifRGBImageAllocatePixels(&rgb) != AVIF_RESULT_OK ||
        avifImageYUVToRGB(view, &rgb) != AVIF_RESULT_OK) fail();
    const int hdr = !source->icc.size &&
        (source->transferCharacteristics == AVIF_TRANSFER_CHARACTERISTICS_PQ ||
         source->transferCharacteristics == AVIF_TRANSFER_CHARACTERISTICS_HLG);
    if (hdr) tone_map_hdr(&rgb, source);
    cmsHPROFILE input_profile = hdr ? NULL : input_color_profile(source);
    if (input_profile) {
        cmsHPROFILE output_profile = cmsCreate_sRGBProfile();
        if (!output_profile) fail();
        cmsHTRANSFORM transform = cmsCreateTransform(input_profile, TYPE_RGBA_8,
            output_profile, TYPE_RGBA_8, INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_COPY_ALPHA | cmsFLAGS_NOOPTIMIZE);
        if (!transform) fail();
        for (uint32_t y = 0; y < rgb.height; y++) {
            uint8_t *scanline = rgb.pixels + (size_t)y * rgb.rowBytes;
            cmsDoTransform(transform, scanline, scanline, rgb.width);
        }
        cmsDeleteTransform(transform);
        cmsCloseProfile(output_profile);
        cmsCloseProfile(input_profile);
    }
    const uint32_t width = (angle & 1) ? rgb.height : rgb.width;
    const uint32_t height = (angle & 1) ? rgb.width : rgb.height;
    uint8_t *row = malloc((size_t)width * 4);
    if (!row) fail();
    if (printf("P7\nWIDTH %u\nHEIGHT %u\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n", width, height) < 0) fail();
    for (uint32_t y = 0; y < height; y++) {
        for (uint32_t x = 0; x < width; x++) {
            const uint32_t dx = mirror == 1 ? width - 1 - x : x;
            const uint32_t dy = mirror == 0 ? height - 1 - y : y;
            uint32_t sx, sy;
            switch (angle) {
                case 0: sx = dx; sy = dy; break;
                case 1: sx = rgb.width - 1 - dy; sy = dx; break;
                case 2: sx = rgb.width - 1 - dx; sy = rgb.height - 1 - dy; break;
                default: sx = dy; sy = rgb.height - 1 - dx; break;
            }
            memcpy(row + (size_t)x * 4, rgb.pixels + (size_t)sy * rgb.rowBytes + (size_t)sx * 4, 4);
        }
        if (fwrite(row, 4, width, stdout) != width) fail();
    }
    if (fflush(stdout)) fail();
    free(row);
    avifRGBImageFreePixels(&rgb);
    avifImageDestroy(view);
    avifDecoderDestroy(decoder);
    free(prefix.bytes);
    return 0;
}
