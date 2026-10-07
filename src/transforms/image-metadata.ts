import { GatewayError } from "../errors";

export const IMAGE_LIMITS = {
  inputBytes: 4 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
  maxDimension: 4096,
  maxPixels: 1_000_000,
} as const;

export interface ImageMetadata {
  format: "jpeg" | "png" | "webp";
  /** Encoded dimensions, before applying the optional Exif orientation. */
  width: number;
  height: number;
  orientation?: number;
}

function invalid(message: string): never {
  throw new GatewayError("IMAGE_INVALID", message, { stage: "image-inspect" });
}

function unsupported(message: string): never {
  throw new GatewayError("IMAGE_FORMAT_UNSUPPORTED", message, { stage: "image-inspect" });
}

function checkDimensions(width: number, height: number): void {
  if (width < 1 || height < 1) invalid("Image dimensions must be positive.");
  if (
    width > IMAGE_LIMITS.maxDimension ||
    height > IMAGE_LIMITS.maxDimension ||
    width * height > IMAGE_LIMITS.maxPixels
  ) {
    throw new GatewayError("IMAGE_LIMIT_EXCEEDED", "Image dimensions exceed the image limits.", {
      stage: "image-inspect",
      details: {
        width,
        height,
        maxDimension: IMAGE_LIMITS.maxDimension,
        maxPixels: IMAGE_LIMITS.maxPixels,
      },
    });
  }
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

/** Read only IFD0 orientation: do not follow thumbnails, GPS or arbitrary IFD pointers. */
function exifOrientation(data: Uint8Array): number | undefined {
  const tiff = ascii(data, 0, 6) === "Exif\0\0" ? data.subarray(6) : data;
  if (tiff.byteLength < 8) invalid("The Exif TIFF header is truncated.");
  const order = ascii(tiff, 0, 2);
  if (order !== "II" && order !== "MM") invalid("The Exif byte order is invalid.");
  const littleEndian = order === "II";
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, littleEndian) !== 42) invalid("The Exif TIFF header is invalid.");
  const directory = view.getUint32(4, littleEndian);
  if (directory < 8 || directory + 2 > tiff.byteLength) {
    invalid("The Exif orientation directory is outside its metadata block.");
  }
  const entries = view.getUint16(directory, littleEndian);
  if (directory + 2 + entries * 12 + 4 > tiff.byteLength) {
    invalid("The Exif orientation directory is truncated.");
  }
  let orientation: number | undefined;
  for (let index = 0; index < entries; index += 1) {
    const offset = directory + 2 + index * 12;
    if (view.getUint16(offset, littleEndian) !== 0x0112) continue;
    if (
      orientation !== undefined ||
      view.getUint16(offset + 2, littleEndian) !== 3 ||
      view.getUint32(offset + 4, littleEndian) !== 1
    ) {
      invalid("The Exif orientation must be a single, unambiguous SHORT value.");
    }
    orientation = view.getUint16(offset + 8, littleEndian);
    if (orientation < 1 || orientation > 8) invalid("The Exif orientation is invalid.");
  }
  return orientation;
}

function inspectJpeg(data: Uint8Array): ImageMetadata {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 2;
  let frame: { width: number; height: number } | undefined;
  let scanned = false;
  let entropy = false;
  let sawExif = false;
  let orientation: number | undefined;

  // Inspect every marker, not just the first SOF. A second frame, DNL or a frame
  // hidden after a progressive scan must not change dimensions behind the guard.
  while (offset < data.byteLength) {
    if (entropy) {
      while (offset < data.byteLength && data[offset] !== 0xff) offset += 1;
    }
    if (data[offset] !== 0xff) invalid("The JPEG marker stream is malformed.");
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;
    if (marker === undefined) invalid("The JPEG marker stream is truncated.");
    if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    entropy = false;

    if (marker === 0xd9) {
      if (frame === undefined || !scanned || offset !== data.byteLength) {
        invalid("The JPEG is missing image data or has data after its final marker.");
      }
      return { format: "jpeg", ...frame, ...(orientation === undefined ? {} : { orientation }) };
    }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      invalid("The JPEG contains an unexpected standalone marker.");
    }
    if (marker === 0x01) continue;
    if (offset + 2 > data.byteLength) invalid("The JPEG segment length is truncated.");
    const length = view.getUint16(offset);
    const end = offset + length;
    if (length < 2 || end > data.byteLength) invalid("The JPEG segment is truncated.");
    const payload = offset + 2;

    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (frame !== undefined) invalid("Multiple JPEG frame headers are not allowed.");
      if (marker !== 0xc0 && marker !== 0xc2) {
        unsupported("Only baseline and progressive Huffman JPEG images are supported.");
      }
      if (length < 11) invalid("The JPEG frame header is truncated.");
      if (data[payload] !== 8) unsupported("Only 8-bit JPEG samples are supported.");
      const components = data[payload + 5] ?? 0;
      if (![1, 3, 4].includes(components)) unsupported("The JPEG component layout is unsupported.");
      if (length !== 8 + 3 * components) invalid("The JPEG frame component table is malformed.");
      const height = view.getUint16(payload + 1);
      const width = view.getUint16(payload + 3);
      checkDimensions(width, height);
      const identifiers = new Set<number>();
      for (let index = 0; index < components; index += 1) {
        const position = payload + 6 + index * 3;
        const identifier = data[position] ?? 0;
        const factors = data[position + 1] ?? 0;
        if (identifiers.has(identifier) || (factors >> 4) < 1 || (factors >> 4) > 4 ||
          (factors & 15) < 1 || (factors & 15) > 4) {
          invalid("The JPEG component sampling factors are malformed.");
        }
        identifiers.add(identifier);
      }
      frame = { width, height };
    } else if (marker === 0xdc || marker === 0xde || marker === 0xdf || marker === 0xcc || marker === 0xc8) {
      unsupported("Dynamic dimensions, hierarchical and arithmetic JPEG images are unsupported.");
    } else if (marker === 0xe1 && ascii(data, payload, 6) === "Exif\0\0") {
      if (sawExif) invalid("Multiple JPEG Exif blocks are not allowed.");
      sawExif = true;
      orientation = exifOrientation(data.subarray(payload, end));
    } else if (marker === 0xda) {
      if (frame === undefined || length < 6) invalid("The JPEG scan has no valid frame header.");
      const components = data[payload] ?? 0;
      if (components < 1 || components > 4 || length !== 6 + 2 * components) {
        invalid("The JPEG scan component table is malformed.");
      }
      scanned = true;
      entropy = true;
    }
    offset = end;
  }
  invalid("The JPEG final marker is missing.");
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function pngCrc(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = (CRC_TABLE[(value ^ byte) & 255] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function inspectPng(data: Uint8Array): ImageMetadata {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => data[index] === value)) invalid("The PNG signature is invalid.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  let dimensions: { width: number; height: number } | undefined;
  let colorType = -1;
  let sawPalette = false;
  let sawData = false;
  let endedData = false;
  let dataBytes = 0;
  let sawExif = false;
  let orientation: number | undefined;

  while (offset < data.byteLength) {
    if (offset + 12 > data.byteLength) invalid("The PNG chunk header is truncated.");
    const length = view.getUint32(offset);
    const type = ascii(data, offset + 4, 4);
    const payload = offset + 8;
    const end = payload + length;
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || end + 4 > data.byteLength) {
      invalid("The PNG chunk is malformed or truncated.");
    }
    if (pngCrc(data.subarray(offset + 4, end)) !== view.getUint32(end)) {
      invalid("The PNG chunk checksum is invalid.");
    }
    if (dimensions === undefined && type !== "IHDR") invalid("The PNG must begin with IHDR.");
    if (type !== "IDAT" && sawData) endedData = true;

    if (type === "IHDR") {
      if (dimensions !== undefined || length !== 13) invalid("The PNG IHDR chunk is malformed or duplicated.");
      const width = view.getUint32(payload);
      const height = view.getUint32(payload + 4);
      checkDimensions(width, height);
      const bitDepth = data[payload + 8] ?? 0;
      colorType = data[payload + 9] ?? -1;
      const depths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
      };
      if (!depths[colorType]?.includes(bitDepth) || data[payload + 10] !== 0 ||
        data[payload + 11] !== 0 || (data[payload + 12] ?? 2) > 1) {
        invalid("The PNG image header uses an invalid encoding.");
      }
      dimensions = { width, height };
    } else if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      unsupported("Animated PNG images are unsupported.");
    } else if (type === "iCCP" || type === "zTXt") {
      // Metadata can inflate independently of pixel count. Do not expose the
      // decoder to an unbounded ancillary decompression allocation.
      unsupported("Compressed PNG metadata is unsupported by the bounded image profile.");
    } else if (type === "iTXt") {
      const keywordEnd = data.indexOf(0, payload);
      if (keywordEnd < payload + 1 || keywordEnd + 2 >= end || keywordEnd - payload > 79) {
        invalid("The PNG international text chunk is malformed.");
      }
      const compressed = data[keywordEnd + 1];
      if (compressed === 1) unsupported("Compressed PNG metadata is unsupported by the bounded image profile.");
      if (compressed !== 0 || data[keywordEnd + 2] !== 0) invalid("The PNG text compression flag is invalid.");
    } else if (type === "PLTE") {
      if (sawPalette || sawData || length < 3 || length > 768 || length % 3 !== 0) {
        invalid("The PNG palette chunk is malformed or misplaced.");
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (endedData || (colorType === 3 && !sawPalette)) invalid("The PNG image data chunks are out of order.");
      sawData = true;
      dataBytes += length;
    } else if (type === "eXIf") {
      if (sawExif) invalid("Multiple PNG Exif blocks are not allowed.");
      sawExif = true;
      orientation = exifOrientation(data.subarray(payload, end));
    } else if (type === "IEND") {
      if (dimensions === undefined || !sawData || dataBytes === 0 || length !== 0 || end + 4 !== data.byteLength) {
        invalid("The PNG final chunk is malformed or image data is missing.");
      }
      return { format: "png", ...dimensions, ...(orientation === undefined ? {} : { orientation }) };
    } else if (((data[offset + 4] ?? 0) & 32) === 0) {
      unsupported("The PNG contains an unsupported critical chunk.");
    }
    offset = end + 4;
  }
  invalid("The PNG final chunk is missing.");
}

function little24(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16);
}

function inspectWebp(data: Uint8Array): ImageMetadata {
  if (data.byteLength < 12) invalid("The WebP RIFF header is truncated.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(4, true) + 8 !== data.byteLength) invalid("The WebP RIFF length is invalid.");
  let offset = 12;
  let canvas: { width: number; height: number } | undefined;
  let frame: { width: number; height: number } | undefined;
  let sawAlpha = false;
  let sawExif = false;
  let orientation: number | undefined;

  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) invalid("The WebP chunk header is truncated.");
    const type = ascii(data, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    const end = payload + length;
    const paddedEnd = end + (length & 1);
    if (paddedEnd > data.byteLength || ((length & 1) !== 0 && data[end] !== 0)) {
      invalid("The WebP chunk is truncated or has invalid padding.");
    }

    if (type === "VP8X") {
      if (offset !== 12 || canvas !== undefined || length !== 10) invalid("The WebP VP8X header is malformed.");
      const flags = data[payload] ?? 0;
      if ((flags & 2) !== 0) unsupported("Animated WebP images are unsupported.");
      if ((flags & 0xc1) !== 0 || little24(data, payload + 1) !== 0) {
        invalid("The WebP VP8X header has reserved bits set.");
      }
      canvas = { width: little24(data, payload + 4) + 1, height: little24(data, payload + 7) + 1 };
      checkDimensions(canvas.width, canvas.height);
    } else if (type === "ANIM" || type === "ANMF") {
      unsupported("Animated WebP images are unsupported.");
    } else if (type === "VP8 " || type === "VP8L") {
      if (frame !== undefined) invalid("Multiple WebP image bitstreams are not allowed.");
      if (canvas === undefined && offset !== 12) invalid("An extended WebP image must begin with VP8X.");
      if (type === "VP8 ") {
        if (length < 10 || ((data[payload] ?? 1) & 1) !== 0 || ascii(data, payload + 3, 3) !== "\u009d\u0001*") {
          invalid("The WebP VP8 key frame header is malformed.");
        }
        frame = { width: view.getUint16(payload + 6, true) & 0x3fff, height: view.getUint16(payload + 8, true) & 0x3fff };
      } else {
        if (length < 5 || data[payload] !== 0x2f) invalid("The WebP lossless header is malformed.");
        const bits = view.getUint32(payload + 1, true);
        if ((bits >>> 29) !== 0) unsupported("The WebP lossless bitstream version is unsupported.");
        if (sawAlpha) invalid("A WebP lossless image cannot have a separate alpha chunk.");
        frame = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      checkDimensions(frame.width, frame.height);
      if (canvas !== undefined && (canvas.width !== frame.width || canvas.height !== frame.height)) {
        invalid("The WebP canvas dimensions disagree with the encoded image dimensions.");
      }
    } else if (type === "ALPH") {
      if (canvas === undefined || sawAlpha || frame !== undefined || length < 1) {
        invalid("The WebP alpha chunk is malformed or misplaced.");
      }
      sawAlpha = true;
    } else if (type === "EXIF") {
      if (canvas === undefined || sawExif) invalid("The WebP Exif chunk is malformed or duplicated.");
      sawExif = true;
      orientation = exifOrientation(data.subarray(payload, end));
    }
    offset = paddedEnd;
  }
  if (frame === undefined) invalid("The WebP image bitstream is missing.");
  return { format: "webp", ...frame, ...(orientation === undefined ? {} : { orientation }) };
}

/**
 * Guard dimensions and container layout before any expensive pixel allocation.
 * This deliberately does not claim to validate entropy-coded image data: the
 * codec must still reject bad pixels and its decoded dimensions must be checked.
 */
export function inspectImage(data: Uint8Array): ImageMetadata {
  if (data.byteLength > IMAGE_LIMITS.inputBytes) {
    throw new GatewayError("IMAGE_LIMIT_EXCEEDED", "The encoded image exceeds the input byte limit.", {
      stage: "image-inspect", details: { maxBytes: IMAGE_LIMITS.inputBytes },
    });
  }
  if (data[0] === 0xff && data[1] === 0xd8) return inspectJpeg(data);
  if (ascii(data, 0, 4) === "\u0089PNG") return inspectPng(data);
  if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") return inspectWebp(data);
  unsupported("Only static PNG, JPEG and WebP images are supported.");
}
