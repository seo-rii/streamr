/* Streamr's bounded libwebp bridge. Project code: MIT; libwebp: BSD-3-Clause.
 * The decoder and encoder are built as separate, fresh-per-operation modules.
 * Each successful call returns four little-endian uint32 words:
 * [data pointer, byte length, width, height]. The caller owns the returned data
 * and must free it, then clear the instance's entire memory before disposal.
 */
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "webp/decode.h"
#include "webp/encode.h"

#define STREAMR_INPUT_BYTES (4u * 1024u * 1024u)
#define STREAMR_OUTPUT_BYTES (8u * 1024u * 1024u)
#define STREAMR_MAX_DIMENSION 4096u
#define STREAMR_MAX_PIXELS 1000000u

#if defined(STREAMR_WEBP_DECODER) && defined(STREAMR_WEBP_ENCODER)
#error The decoder and encoder must be built as separate modules.
#endif

typedef struct {
  uint32_t pointer;
  uint32_t length;
  uint32_t width;
  uint32_t height;
} StreamrResult;

static StreamrResult result;

static int valid_dimensions(int width, int height) {
  return width > 0 && height > 0 &&
         (uint32_t)width <= STREAMR_MAX_DIMENSION &&
         (uint32_t)height <= STREAMR_MAX_DIMENSION &&
         (uint32_t)width <= STREAMR_MAX_PIXELS / (uint32_t)height;
}

void* streamr_alloc(uint32_t size) {
  if (size == 0 || size > STREAMR_INPUT_BYTES) return NULL;
  return malloc(size);
}

void streamr_free(void* pointer) {
  free(pointer);
}

#if defined(STREAMR_WEBP_DECODER)

uint32_t streamr_webp_version(void) {
  return (uint32_t)WebPGetDecoderVersion();
}

const StreamrResult* streamr_webp_decode(const uint8_t* data, uint32_t length) {
  WebPBitstreamFeatures features;
  uint8_t* pixels;
  uint32_t output_length;
  memset(&result, 0, sizeof(result));
  if (data == NULL || length == 0 || length > STREAMR_INPUT_BYTES ||
      WebPGetFeatures(data, length, &features) != VP8_STATUS_OK ||
      features.has_animation ||
      !valid_dimensions(features.width, features.height)) {
    return NULL;
  }
  output_length = (uint32_t)features.width * (uint32_t)features.height * 4u;
  pixels = (uint8_t*)malloc(output_length);
  if (pixels == NULL) return NULL;
  if (WebPDecodeRGBAInto(data, length, pixels, output_length,
                       features.width * 4) == NULL) {
    memset(pixels, 0, output_length);
    free(pixels);
    return NULL;
  }
  result.pointer = (uint32_t)(uintptr_t)pixels;
  result.length = output_length;
  result.width = (uint32_t)features.width;
  result.height = (uint32_t)features.height;
  return &result;
}

#elif defined(STREAMR_WEBP_ENCODER)

typedef struct {
  uint8_t* data;
  size_t length;
  size_t capacity;
} StreamrWriter;

/* The encoder may call the writer repeatedly. Bound its encoded output before
 * reallocating, rather than accumulating an unlimited WebPMemoryWriter buffer.
 */
static int write_output(const uint8_t* data, size_t size,
                        const WebPPicture* picture) {
  StreamrWriter* writer = (StreamrWriter*)picture->custom_ptr;
  size_t required;
  size_t capacity;
  uint8_t* grown;
  if (size > STREAMR_OUTPUT_BYTES - writer->length) return 0;
  required = writer->length + size;
  if (required > writer->capacity) {
    capacity = writer->capacity == 0 ? 4096u : writer->capacity;
    while (capacity < required) capacity *= 2u;
    if (capacity > STREAMR_OUTPUT_BYTES) capacity = STREAMR_OUTPUT_BYTES;
    grown = (uint8_t*)realloc(writer->data, capacity);
    if (grown == NULL) return 0;
    writer->data = grown;
    writer->capacity = capacity;
  }
  if (size != 0) memcpy(writer->data + writer->length, data, size);
  writer->length = required;
  return 1;
}

uint32_t streamr_webp_version(void) {
  return (uint32_t)WebPGetEncoderVersion();
}

const StreamrResult* streamr_webp_encode(const uint8_t* rgba, int width,
                                        int height, int quality) {
  WebPConfig config;
  WebPPicture picture;
  StreamrWriter writer = {NULL, 0, 0};
  int encoded;
  memset(&result, 0, sizeof(result));
  if (rgba == NULL || !valid_dimensions(width, height) ||
      quality < 1 || quality > 100 ||
      !WebPConfigInit(&config) || !WebPPictureInit(&picture)) {
    return NULL;
  }
  config.lossless = 0;
  config.quality = (float)quality;
  config.method = 4;
  config.low_memory = 1;
  config.thread_level = 0;
  config.exact = 1;
  /* Lossless alpha compression can allocate much more than the RGBA plane.
   * Preserve alpha exactly as an uncompressed ALPH chunk, keeping the same
   * 32 MiB instance cap even for a full-size image with noisy transparency.
   */
  config.alpha_compression = 0;
  config.alpha_filtering = 0;
  config.alpha_quality = 100;
  if (!WebPValidateConfig(&config)) return NULL;
  picture.use_argb = 0;
  picture.width = width;
  picture.height = height;
  picture.writer = write_output;
  picture.custom_ptr = &writer;
  if (!WebPPictureImportRGBA(&picture, rgba, width * 4)) {
    WebPPictureFree(&picture);
    return NULL;
  }
  encoded = WebPEncode(&config, &picture);
  WebPPictureFree(&picture);
  if (!encoded || writer.length == 0) {
    if (writer.data != NULL) memset(writer.data, 0, writer.length);
    free(writer.data);
    return NULL;
  }
  result.pointer = (uint32_t)(uintptr_t)writer.data;
  result.length = (uint32_t)writer.length;
  result.width = (uint32_t)width;
  result.height = (uint32_t)height;
  return &result;
}

#else
#error Define exactly one of STREAMR_WEBP_DECODER or STREAMR_WEBP_ENCODER.
#endif
