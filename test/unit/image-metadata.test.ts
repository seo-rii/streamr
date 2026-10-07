import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS, inspectImage } from "../../src/transforms/image-metadata";

const encoder = new TextEncoder();
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function pngChunk(type: string, body: Uint8Array = new Uint8Array()): Uint8Array {
  const chunk = new Uint8Array(body.byteLength + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.byteLength);
  chunk.set(encoder.encode(type), 4);
  chunk.set(body, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
  }
  view.setUint32(chunk.byteLength - 4, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

function ihdr(width = 3, height = 2): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  return pngChunk("IHDR", header);
}

const IDAT = pngChunk("IDAT", new Uint8Array([0]));
const IEND = pngChunk("IEND");

function png(...metadata: Uint8Array[]): Uint8Array {
  return concat(PNG_SIGNATURE, ihdr(), ...metadata, IDAT, IEND);
}

function segment(marker: number, body: Uint8Array): Uint8Array {
  const result = new Uint8Array(body.byteLength + 4);
  result.set([0xff, marker]);
  new DataView(result.buffer).setUint16(2, body.byteLength + 2);
  result.set(body, 4);
  return result;
}

function sof(width = 3, height = 2, marker = 0xc0): Uint8Array {
  const header = new Uint8Array([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  const view = new DataView(header.buffer);
  view.setUint16(1, height);
  view.setUint16(3, width);
  return segment(marker, header);
}

const SOI = new Uint8Array([0xff, 0xd8]);
const EOI = new Uint8Array([0xff, 0xd9]);
const SOS = segment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0]));
const ENTROPY = new Uint8Array([0x11, 0xff, 0x00, 0x01, 0xff, 0xd0, 0x22]);

function jpeg(...metadata: Uint8Array[]): Uint8Array {
  return concat(SOI, ...metadata, sof(), SOS, ENTROPY, EOI);
}

function exif(orientation: number, littleEndian = true): Uint8Array {
  const tiff = new Uint8Array(26);
  tiff.set(encoder.encode(littleEndian ? "II" : "MM"));
  const view = new DataView(tiff.buffer);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, 8, littleEndian);
  view.setUint16(8, 1, littleEndian);
  view.setUint16(10, 0x0112, littleEndian);
  view.setUint16(12, 3, littleEndian);
  view.setUint32(14, 1, littleEndian);
  view.setUint16(18, orientation, littleEndian);
  return tiff;
}

function webpChunk(type: string, body: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(8 + body.byteLength + (body.byteLength & 1));
  chunk.set(encoder.encode(type));
  new DataView(chunk.buffer).setUint32(4, body.byteLength, true);
  chunk.set(body, 8);
  return chunk;
}

function vp8(width = 3, height = 2): Uint8Array {
  const header = new Uint8Array([0x10, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0]);
  const view = new DataView(header.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return webpChunk("VP8 ", header);
}

function vp8l(width = 3, height = 2, version = 0): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = 0x2f;
  new DataView(header.buffer).setUint32(1, (width - 1) | ((height - 1) << 14) | (version << 29), true);
  return webpChunk("VP8L", header);
}

function vp8x(width = 3, height = 2, flags = 0): Uint8Array {
  const header = new Uint8Array(10);
  header[0] = flags;
  for (let byte = 0; byte < 3; byte += 1) {
    header[4 + byte] = ((width - 1) >>> (8 * byte)) & 255;
    header[7 + byte] = ((height - 1) >>> (8 * byte)) & 255;
  }
  return webpChunk("VP8X", header);
}

function webp(...chunks: Uint8Array[]): Uint8Array {
  const result = concat(encoder.encode("RIFF\0\0\0\0WEBP"), ...chunks);
  new DataView(result.buffer).setUint32(4, result.byteLength - 8, true);
  return result;
}

function expectCode(bytes: Uint8Array, code: string): void {
  expect(() => inspectImage(bytes)).toThrowError(expect.objectContaining({ code, stage: "image-inspect" }));
}

// These fixtures model container headers, not valid compressed pixel data.
// The transform integration tests exercise actual codecs separately.
describe("bounded image metadata inspection", () => {
  it("reads PNG, baseline/progressive JPEG and lossy/lossless WebP encoded dimensions", () => {
    expect(inspectImage(png())).toEqual({ format: "png", width: 3, height: 2 });
    expect(inspectImage(jpeg())).toEqual({ format: "jpeg", width: 3, height: 2 });
    expect(inspectImage(concat(SOI, sof(3, 2, 0xc2), SOS, ENTROPY, SOS, ENTROPY, EOI)))
      .toEqual({ format: "jpeg", width: 3, height: 2 });
    expect(inspectImage(webp(vp8()))).toEqual({ format: "webp", width: 3, height: 2 });
    expect(inspectImage(webp(vp8l()))).toEqual({ format: "webp", width: 3, height: 2 });
    expect(inspectImage(webp(vp8x(), vp8()))).toEqual({ format: "webp", width: 3, height: 2 });
  });

  it("respects Uint8Array offsets instead of reading from the backing buffer start", () => {
    const image = png();
    const padded = concat(new Uint8Array(17), image, new Uint8Array(9));
    expect(inspectImage(padded.subarray(17, 17 + image.byteLength))).toEqual({ format: "png", width: 3, height: 2 });
  });

  it("rejects unsupported and empty inputs without trusting an extension or MIME type", () => {
    for (const value of ["", "GIF89a", "<svg></svg>", "\0\0\0\x18ftypavif", "not an image"]) {
      expectCode(encoder.encode(value), "IMAGE_FORMAT_UNSUPPORTED");
    }
  });

  it("caps input bytes, individual dimensions and total pixels before pixel decoding", () => {
    expectCode(new Uint8Array(IMAGE_LIMITS.inputBytes + 1), "IMAGE_LIMIT_EXCEEDED");
    expectCode(concat(PNG_SIGNATURE, ihdr(4097, 1), IDAT, IEND), "IMAGE_LIMIT_EXCEEDED");
    expectCode(concat(PNG_SIGNATURE, ihdr(1001, 1000), IDAT, IEND), "IMAGE_LIMIT_EXCEEDED");
    expectCode(concat(SOI, sof(1, 4097), SOS, ENTROPY, EOI), "IMAGE_LIMIT_EXCEEDED");
    expectCode(webp(vp8l(1001, 1000)), "IMAGE_LIMIT_EXCEEDED");
    expectCode(webp(vp8x(1001, 1000), vp8()), "IMAGE_LIMIT_EXCEEDED");
    expect(inspectImage(concat(PNG_SIGNATURE, ihdr(1000, 1000), IDAT, IEND)).width).toBe(1000);
    expectCode(concat(PNG_SIGNATURE, ihdr(0, 2), IDAT, IEND), "IMAGE_INVALID");
  });
});

describe("PNG image metadata guard", () => {
  it("checks chunk CRCs, including IHDR, and requires a complete single container", () => {
    const wrongCrc = png();
    wrongCrc[16] = 1;
    expectCode(wrongCrc, "IMAGE_INVALID");
    expectCode(png().subarray(0, -1), "IMAGE_INVALID");
    expectCode(concat(png(), new Uint8Array([0])), "IMAGE_INVALID");
    expectCode(concat(PNG_SIGNATURE, ihdr(), ihdr(4, 2), IDAT, IEND), "IMAGE_INVALID");
    expectCode(concat(PNG_SIGNATURE, IDAT, ihdr(), IEND), "IMAGE_INVALID");
    expectCode(concat(PNG_SIGNATURE, ihdr(), IEND), "IMAGE_INVALID");
    expectCode(concat(PNG_SIGNATURE, ihdr(), IDAT), "IMAGE_INVALID");
    const badLength = png();
    new DataView(badLength.buffer).setUint32(8, 0xffffffff);
    expectCode(badLength, "IMAGE_INVALID");
  });

  it("requires consecutive IDAT chunks and rejects unknown critical chunks", () => {
    expect(inspectImage(concat(PNG_SIGNATURE, ihdr(), IDAT, IDAT, IEND)).format).toBe("png");
    expectCode(concat(PNG_SIGNATURE, ihdr(), IDAT, pngChunk("tEXt", encoder.encode("k\0v")), IDAT, IEND), "IMAGE_INVALID");
    expectCode(png(pngChunk("ABCD")), "IMAGE_FORMAT_UNSUPPORTED");
  });

  it("rejects every APNG control/data chunk, even when a static first image is present", () => {
    for (const type of ["acTL", "fcTL", "fdAT"]) {
      expectCode(png(pngChunk(type, new Uint8Array(8))), "IMAGE_FORMAT_UNSUPPORTED");
      expectCode(concat(PNG_SIGNATURE, ihdr(), IDAT, pngChunk(type), IEND), "IMAGE_FORMAT_UNSUPPORTED");
    }
  });

  it("rejects compressed metadata bombs while allowing ordinary uncompressed metadata", () => {
    expectCode(png(pngChunk("iCCP", encoder.encode("p\0\0compressed"))), "IMAGE_FORMAT_UNSUPPORTED");
    expectCode(png(pngChunk("zTXt", encoder.encode("k\0\0compressed"))), "IMAGE_FORMAT_UNSUPPORTED");
    expectCode(png(pngChunk("iTXt", new Uint8Array([107, 0, 1, 0, 0, 0, 120]))), "IMAGE_FORMAT_UNSUPPORTED");
    expect(inspectImage(png(
      pngChunk("gAMA", new Uint8Array([0, 0, 177, 143])),
      pngChunk("tEXt", encoder.encode("k\0v")),
      pngChunk("iTXt", new Uint8Array([107, 0, 0, 0, 0, 0, 120])),
    )).format).toBe("png");
  });
});

describe("JPEG image metadata guard", () => {
  it("rejects duplicate frame headers, including a frame hidden after scan data", () => {
    expectCode(concat(SOI, sof(), sof(4096, 4096), SOS, ENTROPY, EOI), "IMAGE_INVALID");
    expectCode(concat(SOI, sof(), SOS, ENTROPY, sof(4096, 4096), SOS, ENTROPY, EOI), "IMAGE_INVALID");
  });

  it("rejects unsupported frame encodings and dynamic dimension markers", () => {
    expectCode(concat(SOI, sof(3, 2, 0xc3), SOS, ENTROPY, EOI), "IMAGE_FORMAT_UNSUPPORTED");
    expectCode(concat(SOI, sof(), SOS, ENTROPY, segment(0xdc, new Uint8Array([0, 2])), EOI), "IMAGE_FORMAT_UNSUPPORTED");
    const twelveBit = sof();
    twelveBit[4] = 12;
    expectCode(concat(SOI, twelveBit, SOS, ENTROPY, EOI), "IMAGE_FORMAT_UNSUPPORTED");
  });

  it("requires a frame, scan and final marker with in-bounds marker segments", () => {
    expectCode(concat(SOI, EOI), "IMAGE_INVALID");
    expectCode(concat(SOI, sof(), EOI), "IMAGE_INVALID");
    expectCode(jpeg().subarray(0, -2), "IMAGE_INVALID");
    expectCode(concat(jpeg(), new Uint8Array([0])), "IMAGE_INVALID");
    expectCode(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff]), "IMAGE_INVALID");
    expectCode(new Uint8Array([0xff, 0xd8, 0xff]), "IMAGE_INVALID");
  });
});

describe("WebP image metadata guard", () => {
  it("checks canvas dimensions against both actual lossy and lossless image headers", () => {
    expectCode(webp(vp8x(3, 2), vp8(4, 2)), "IMAGE_INVALID");
    expectCode(webp(vp8x(3, 2), vp8l(4, 2)), "IMAGE_INVALID");
    expectCode(webp(vp8x(3, 2), vp8l(4096, 4096)), "IMAGE_LIMIT_EXCEEDED");
    expectCode(webp(vp8(), vp8()), "IMAGE_INVALID");
    expectCode(webp(vp8x(), vp8x(), vp8()), "IMAGE_INVALID");
  });

  it("rejects animation flags and animation chunks regardless of flags", () => {
    expectCode(webp(vp8x(3, 2, 2), vp8()), "IMAGE_FORMAT_UNSUPPORTED");
    expectCode(webp(vp8x(), webpChunk("ANIM", new Uint8Array(6)), vp8()), "IMAGE_FORMAT_UNSUPPORTED");
    expectCode(webp(vp8x(), vp8(), webpChunk("ANMF", new Uint8Array(16))), "IMAGE_FORMAT_UNSUPPORTED");
  });

  it("checks RIFF size, chunk padding, version, alpha placement and missing bitstreams", () => {
    expectCode(webp(vp8x()), "IMAGE_INVALID");
    expectCode(webp(vp8l()).subarray(0, -1), "IMAGE_INVALID");
    expectCode(concat(webp(vp8()), new Uint8Array([0])), "IMAGE_INVALID");
    const badPadding = vp8l();
    badPadding[badPadding.byteLength - 1] = 1;
    expectCode(webp(badPadding), "IMAGE_INVALID");
    expectCode(webp(vp8l(3, 2, 1)), "IMAGE_FORMAT_UNSUPPORTED");
    expectCode(webp(vp8x(), webpChunk("ALPH", new Uint8Array([0])), vp8l()), "IMAGE_INVALID");
    expectCode(webp(vp8x(), vp8(), webpChunk("ALPH", new Uint8Array([0]))), "IMAGE_INVALID");
  });
});

describe("Exif orientation inspection", () => {
  it.each([true, false])("reads all eight orientations in JPEG/PNG/WebP (little endian: %s)", (littleEndian) => {
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      const metadata = exif(orientation, littleEndian);
      expect(inspectImage(jpeg(segment(0xe1, concat(encoder.encode("Exif\0\0"), metadata)))).orientation).toBe(orientation);
      expect(inspectImage(png(pngChunk("eXIf", metadata))).orientation).toBe(orientation);
      expect(inspectImage(webp(vp8x(3, 2, 8), vp8(), webpChunk("EXIF", metadata))).orientation).toBe(orientation);
    }
  });

  it("does not take dimensions from Exif and rejects malformed or duplicate orientation data", () => {
    const noOrientation = exif(6);
    new DataView(noOrientation.buffer).setUint16(10, 0x0100, true);
    expect(inspectImage(png(pngChunk("eXIf", noOrientation)))).toEqual({ format: "png", width: 3, height: 2 });
    expectCode(png(pngChunk("eXIf", exif(9))), "IMAGE_INVALID");
    expectCode(png(pngChunk("eXIf", exif(0))), "IMAGE_INVALID");
    expectCode(png(pngChunk("eXIf", exif(6)), pngChunk("eXIf", exif(6))), "IMAGE_INVALID");
    const wrongOffset = exif(6);
    new DataView(wrongOffset.buffer).setUint32(4, 0xffffffff, true);
    expectCode(png(pngChunk("eXIf", wrongOffset)), "IMAGE_INVALID");
    expectCode(png(pngChunk("eXIf", exif(6).subarray(0, -1))), "IMAGE_INVALID");
    const wrongType = exif(6);
    new DataView(wrongType.buffer).setUint16(12, 4, true);
    expectCode(png(pngChunk("eXIf", wrongType)), "IMAGE_INVALID");
  });
});
