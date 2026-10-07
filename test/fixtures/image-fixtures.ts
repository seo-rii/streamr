import { unzlibSync, zlibSync } from "fflate";

type Pixel = readonly [number, number, number, number];

export const LOSSLESS_WEBP_PIXELS: readonly Pixel[] = [
  [255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 255, 0],
  [255, 255, 255, 255], [10, 20, 30, 64], [100, 110, 120, 192],
];

/**
 * A 3×2 VP8L fixture generated once from the six synthetic RGBA pixels above,
 * using @jsquash/webp 1.5.0's encoder with lossless=1, exact=1, quality=100.
 * The test does not load that encoder or fetch any image at runtime.
 */
export function makeLosslessWebp(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(
    "UklGRkoAAABXRUJQVlA4TD4AAAAvAkAAEC9AkG1Ticnd3+MaZNI27VuJ8+9jAhIiRwzz/weCbJuhb2Y3e2CcnyGV2xIK2UaAQ/cCncJF9D+GFw==",
  ), (character) => character.charCodeAt(0));
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(data.byteLength + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.byteLength);
  result.set(new TextEncoder().encode(type), 4);
  result.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  view.setUint32(result.byteLength - 4, (crc ^ 0xffffffff) >>> 0);
  return result;
}

/** Small, deterministic, generated fixtures: no image binaries or external fetches. */
export function makePng(
  width = 16,
  height = 8,
  pixel: (x: number, y: number) => Pixel = (x, y) => [
    (x * 37 + y * 19) % 256,
    (x * 11 + y * 53) % 256,
    (x * 73 + y * 7) % 256,
    255,
  ],
): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const scanlines = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      scanlines.set(pixel(x, y), y * (1 + width * 4) + 1 + x * 4);
    }
  }
  return concatenate([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlibSync(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

/** Repeatable high-entropy RGBA, including alpha, to exercise codec memory bounds. */
export function makeNoisyPng(width: number, height: number): Uint8Array<ArrayBuffer> {
  let state = 0x12345678;
  return makePng(width, height, () => {
    const pixel: [number, number, number, number] = [0, 0, 0, 0];
    for (let channel = 0; channel < 4; channel += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixel[channel] = state & 255;
    }
    return pixel;
  });
}

/** Set declared dimensions without allocating a large bitmap, keeping the CRC valid. */
export function withPngDimensions(
  png: Uint8Array,
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const header = png.slice(16, 29);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint32(0, width);
  view.setUint32(4, height);
  return concatenate([png.subarray(0, 8), pngChunk("IHDR", header), png.subarray(33)]);
}

/** Add a valid, minimal TIFF orientation block without changing encoded pixels. */
export function withExifOrientation(image: Uint8Array, orientation: number): Uint8Array<ArrayBuffer> {
  const dimensions = imageDimensions(image);
  const tiff = new Uint8Array(26);
  tiff.set([0x49, 0x49]);
  const metadata = new DataView(tiff.buffer);
  metadata.setUint16(2, 42, true);
  metadata.setUint32(4, 8, true);
  metadata.setUint16(8, 1, true);
  metadata.setUint16(10, 0x0112, true);
  metadata.setUint16(12, 3, true);
  metadata.setUint32(14, 1, true);
  metadata.setUint16(18, orientation, true);
  if (dimensions.format === "png") {
    return concatenate([image.subarray(0, 33), pngChunk("eXIf", tiff), image.subarray(33)]);
  }
  if (dimensions.format === "jpeg") {
    const segment = new Uint8Array(10 + tiff.length);
    segment.set([0xff, 0xe1]);
    new DataView(segment.buffer).setUint16(2, segment.length - 2);
    segment.set(new TextEncoder().encode("Exif\0\0"), 4);
    segment.set(tiff, 10);
    return concatenate([image.subarray(0, 2), segment, image.subarray(2)]);
  }
  const header = image.slice(0, 12);
  const firstType = new TextDecoder().decode(image.subarray(12, 16));
  let chunks: Uint8Array;
  if (firstType === "VP8X") {
    chunks = image.slice(12);
    chunks[8] = (chunks[8] ?? 0) | 8;
  } else {
    const extended = new Uint8Array(18);
    extended.set(new TextEncoder().encode("VP8X"));
    new DataView(extended.buffer).setUint32(4, 10, true);
    extended[8] = 8;
    for (let byte = 0; byte < 3; byte += 1) {
      extended[12 + byte] = ((dimensions.width - 1) >>> (8 * byte)) & 255;
      extended[15 + byte] = ((dimensions.height - 1) >>> (8 * byte)) & 255;
    }
    chunks = concatenate([extended, image.subarray(12)]);
  }
  const exif = new Uint8Array(8 + tiff.byteLength);
  exif.set(new TextEncoder().encode("EXIF"));
  new DataView(exif.buffer).setUint32(4, tiff.byteLength, true);
  exif.set(tiff, 8);
  const result = concatenate([header, chunks, exif]);
  new DataView(result.buffer).setUint32(4, result.byteLength - 8, true);
  return result;
}

/** Read dimensions from encoded output, independently of the production WASM codecs. */
export function imageDimensions(bytes: Uint8Array): {
  format: "png" | "jpeg" | "webp";
  width: number;
  height: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(start, start + length));
  if (ascii(1, 3) === "PNG") {
    return { format: "png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.byteLength) {
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++] ?? 0;
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          format: "jpeg",
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3),
        };
      }
      offset += length;
    }
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const uint24 = (offset: number) =>
      view.getUint8(offset) + view.getUint8(offset + 1) * 256 + view.getUint8(offset + 2) * 65_536;
    for (let offset = 12; offset + 8 < bytes.byteLength;) {
      const type = ascii(offset, 4);
      const size = view.getUint32(offset + 4, true);
      const data = offset + 8;
      if (type === "VP8X") {
        return { format: "webp", width: uint24(data + 4) + 1, height: uint24(data + 7) + 1 };
      }
      if (type === "VP8 ") {
        return {
          format: "webp",
          width: view.getUint16(data + 6, true) & 0x3fff,
          height: view.getUint16(data + 8, true) & 0x3fff,
        };
      }
      if (type === "VP8L") {
        const bits = view.getUint32(data + 1, true);
        return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      offset += 8 + size + (size & 1);
    }
  }
  throw new Error("The encoded fixture has no supported image header.");
}

/** Decode one RGBA/RGB PNG pixel to check lossy JPEG alpha flattening after a round trip. */
export function pngPixel(bytes: Uint8Array, x = 0, y = 0): Pixel {
  const { width, height } = imageDimensions(bytes);
  if (bytes[24] !== 8 || ![2, 6].includes(bytes[25] ?? 0) || x >= width || y >= height) {
    throw new Error("Expected a non-interlaced 8-bit RGB or RGBA PNG fixture.");
  }
  const channels = bytes[25] === 6 ? 4 : 3;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  for (let offset = 8; offset + 12 <= bytes.byteLength;) {
    const size = view.getUint32(offset);
    if (new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8)) === "IDAT") {
      chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
    }
    offset += size + 12;
  }
  const scanlines = unzlibSync(concatenate(chunks));
  const stride = width * channels;
  let previous = new Uint8Array(stride);
  for (let row = 0; row <= y; row += 1) {
    const offset = row * (stride + 1);
    const filter = scanlines[offset];
    const current = new Uint8Array(stride);
    for (let column = 0; column < stride; column += 1) {
      const left = current[column - channels] ?? 0;
      const up = previous[column] ?? 0;
      const upperLeft = previous[column - channels] ?? 0;
      const prediction = left + up - upperLeft;
      const distances = [
        Math.abs(prediction - left),
        Math.abs(prediction - up),
        Math.abs(prediction - upperLeft),
      ];
      const paeth = distances[0]! <= distances[1]! && distances[0]! <= distances[2]!
        ? left
        : distances[1]! <= distances[2]! ? up : upperLeft;
      const correction = [0, left, up, Math.floor((left + up) / 2), paeth][filter ?? 0];
      if (correction === undefined) throw new Error("Unsupported PNG filter.");
      current[column] = (scanlines[offset + 1 + column] ?? 0) + correction;
    }
    previous = current;
  }
  const offset = x * channels;
  return [previous[offset]!, previous[offset + 1]!, previous[offset + 2]!, channels === 4 ? previous[offset + 3]! : 255];
}
