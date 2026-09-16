/* Encode one bounded RGB/RGBA PAM frame. Run under media-limits in service use. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <jpeglib.h>
#include "jpeg-srgb-profile.h"

static _Noreturn void fail(void) {
    fputs("JPEG encoding failed\n", stderr);
    exit(1);
}

static void jpeg_failure(j_common_ptr codec) { (void)codec; fail(); }
static void jpeg_message(j_common_ptr codec) { (void)codec; }

static unsigned number(const char *text, unsigned maximum) {
    if (!*text) fail();
    unsigned value = 0;
    for (; *text; text++) {
        if (*text < '0' || *text > '9') fail();
        unsigned digit = (unsigned)(*text - '0');
        if (value > maximum / 10 ||
            (value == maximum / 10 && digit > maximum % 10)) fail();
        value = value * 10 + digit;
    }
    return value;
}

static void line(char *buffer, size_t capacity) {
    if (!fgets(buffer, (int)capacity, stdin)) fail();
    size_t length = strlen(buffer);
    if (!length || buffer[length - 1] != '\n') fail();
    buffer[length - 1] = 0;
}

int main(int argc, char **argv) {
    if (argc != 3) fail();
    unsigned quality = number(argv[1], 100);
    unsigned pixels = number(argv[2], 100000000);
    if (!pixels) fail();
    char header[128];
    line(header, sizeof(header));
    if (strcmp(header, "P7")) fail();
    unsigned width = 0, height = 0, depth = 0, seen = 0;
    char tuple[16] = {0};
    /* Exactly the five PAM fields: bounded header, no duplicate or unknown keys. */
    for (unsigned field = 0; field < 5; field++) {
        line(header, sizeof(header));
        char *value = strchr(header, ' ');
        if (!value) fail();
        *value++ = 0;
        unsigned bit;
        if (!strcmp(header, "WIDTH")) {
            bit = 1; width = number(value, 8192);
        } else if (!strcmp(header, "HEIGHT")) {
            bit = 2; height = number(value, 8192);
        } else if (!strcmp(header, "DEPTH")) {
            bit = 4; depth = number(value, 4);
        } else if (!strcmp(header, "MAXVAL")) {
            bit = 8; if (strcmp(value, "255")) fail();
        } else if (!strcmp(header, "TUPLTYPE")) {
            bit = 16;
            if (strlen(value) >= sizeof(tuple)) fail();
            strcpy(tuple, value);
        } else fail();
        if (seen & bit) fail();
        seen |= bit;
    }
    line(header, sizeof(header));
    if (strcmp(header, "ENDHDR") || seen != 31 || !width || !height ||
        (uint64_t)width * height > pixels ||
        !((depth == 3 && !strcmp(tuple, "RGB")) ||
          (depth == 4 && !strcmp(tuple, "RGB_ALPHA")))) fail();

    unsigned char *row = malloc((size_t)width * depth);
    if (!row) fail();
    struct jpeg_compress_struct codec;
    struct jpeg_error_mgr errors;
    codec.err = jpeg_std_error(&errors);
    errors.error_exit = jpeg_failure;
    errors.output_message = jpeg_message;
    jpeg_create_compress(&codec);
    jpeg_stdio_dest(&codec, stdout);
    codec.image_width = width;
    codec.image_height = height;
    codec.input_components = 3;
    codec.in_color_space = JCS_RGB;
    jpeg_set_defaults(&codec);
    jpeg_set_quality(&codec, (int)quality, TRUE);
    /* Match canvas's full-quality 4:4:4 exception; otherwise use 4:2:0. */
    codec.comp_info[0].h_samp_factor = quality == 100 ? 1 : 2;
    codec.comp_info[0].v_samp_factor = quality == 100 ? 1 : 2;
    codec.optimize_coding = TRUE;
    jpeg_start_compress(&codec, TRUE);
    jpeg_write_icc_profile(&codec, jpeg_srgb_profile, sizeof(jpeg_srgb_profile));
    for (unsigned y = 0; y < height; y++) {
        if (fread(row, 1, (size_t)width * depth, stdin) != (size_t)width * depth) fail();
        if (depth == 4) {
            for (unsigned x = 0; x < width; x++) {
                unsigned alpha = row[4 * x + 3];
                for (unsigned channel = 0; channel < 3; channel++)
                    row[3 * x + channel] = (unsigned char)
                        (((unsigned)row[4 * x + channel] * alpha + 127) / 255);
            }
        }
        JSAMPROW scanline = row;
        if (jpeg_write_scanlines(&codec, &scanline, 1) != 1) fail();
    }
    /* Reject trailing frames/data; callers must discard provisional output on failure. */
    if (fgetc(stdin) != EOF || ferror(stdin)) fail();
    jpeg_finish_compress(&codec);
    jpeg_destroy_compress(&codec);
    free(row);
    if (fflush(stdout) || ferror(stdout)) fail();
    return 0;
}
