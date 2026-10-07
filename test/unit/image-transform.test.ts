import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { imageTransformSchema, type ImageTransformSpec } from "../../src/schemas";
import type { ByteStream } from "../../src/streams/byte-stream";
import { transformImage } from "../../src/transforms/image";
import { IMAGE_LIMITS } from "../../src/transforms/image-metadata";
import { imageDimensions, LOSSLESS_WEBP_PIXELS, makeLosslessWebp, makeNoisyPng, makePng, pngPixel, withExifOrientation, withPngDimensions } from "../fixtures/image-fixtures";

function input(chunks: Uint8Array[], knownLength?: number) {
  const abort = vi.fn();
  const cancel = vi.fn();
  const pull = vi.fn();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pull();
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel,
  }, { highWaterMark: 0 });
  return {
    stream,
    ...(knownLength === undefined ? {} : { knownLength }),
    contentType: "image/png",
    filename: "original.photo.png",
    abort,
    cancel,
    pull,
  };
}

async function readBytes(stream: ByteStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream.stream).arrayBuffer());
}

function spec(options: Omit<z.input<typeof imageTransformSchema>, "type">): ImageTransformSpec {
  return imageTransformSchema.parse({ type: "image", ...options });
}

describe("bounded Worker-local WASM image transform", () => {
  it.each(["png", "jpeg", "webp"] as const)("actually re-encodes %s and updates output metadata", async (format) => {
    const png = makePng();
    const transformed = await transformImage(input([png.subarray(0, 13), png.subarray(13)]), spec({ format }));
    const bytes = await readBytes(transformed);
    expect(imageDimensions(bytes)).toEqual({ format, width: 16, height: 8 });
    expect(transformed.contentType).toBe(`image/${format}`);
    expect(transformed.filename).toBe(`original.photo.${format === "jpeg" ? "jpg" : format}`);
    expect(transformed.knownLength).toBe(bytes.byteLength);
  });

  it.each(["jpeg", "webp"] as const)("also accepts %s input", async (format) => {
    const encoded = await readBytes(await transformImage(input([makePng()]), spec({ format })));
    const decoded = await readBytes(await transformImage(input([encoded]), spec({ format: "png" })));
    expect(imageDimensions(decoded)).toEqual({ format: "png", width: 16, height: 8 });
  });

  it("decodes real lossless VP8L WebP pixels including transparency", async () => {
    const fixture = makeLosslessWebp();
    expect(new TextDecoder().decode(fixture.subarray(12, 16))).toBe("VP8L");
    const decoded = await readBytes(await transformImage(input([fixture]), spec({ format: "png" })));
    expect(imageDimensions(decoded)).toEqual({ format: "png", width: 3, height: 2 });
    for (let index = 0; index < LOSSLESS_WEBP_PIXELS.length; index += 1) {
      expect(pngPixel(decoded, index % 3, Math.floor(index / 3))).toEqual(LOSSLESS_WEBP_PIXELS[index]);
    }
  });

  it("preserves the alpha channel across lossy WebP encoding and decoding", async () => {
    const png = makePng(8, 8, (x, y) => [x * 31, y * 31, 100, ((x + y) % 4) * 85]);
    const webp = await readBytes(await transformImage(input([png]), spec({ format: "webp", quality: 75 })));
    const decoded = await readBytes(await transformImage(input([webp]), spec({ format: "png" })));
    expect(imageDimensions(decoded)).toEqual({ format: "png", width: 8, height: 8 });
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) expect(pngPixel(decoded, x, y)[3]).toBe(((x + y) % 4) * 85);
    }
  });

  it.each(["jpeg", "webp"] as const)("honors lossy %s quality", async (format) => {
    const png = makePng(32, 32);
    const low = await readBytes(await transformImage(input([png]), spec({ format, quality: 15 })));
    const high = await readBytes(await transformImage(input([png]), spec({ format, quality: 95 })));
    expect(imageDimensions(low)).toEqual({ format, width: 32, height: 32 });
    expect(imageDimensions(high)).toEqual({ format, width: 32, height: 32 });
    expect(low).not.toEqual(high);
    expect(low.byteLength).toBeLessThan(high.byteLength);
  });

  it.each([
    { resize: { width: 4 }, width: 4, height: 2 },
    { resize: { height: 2 }, width: 4, height: 2 },
    { resize: { width: 4, height: 4 }, width: 4, height: 2 },
    { resize: { width: 32, height: 32 }, width: 16, height: 8 },
    { resize: { width: 32, height: 32, fit: "contain" as const }, width: 32, height: 16 },
    { resize: { width: 4, height: 4, fit: "cover" as const }, width: 4, height: 4 },
  ])("resizes proportionally or crops according to $resize", async ({ resize, width, height }) => {
    const transformed = await transformImage(input([makePng()]), spec({ format: "png", resize }));
    expect(imageDimensions(await readBytes(transformed))).toEqual({ format: "png", width, height });
  });

  it("preserves PNG alpha and flattens JPEG alpha onto the requested background", async () => {
    const transparent = makePng(8, 8, () => [255, 0, 0, 0]);
    const unchanged = await readBytes(await transformImage(input([transparent]), spec({ format: "png" })));
    expect(pngPixel(unchanged)[3]).toBe(0);
    for (const [background, expected] of [[undefined, 255], ["#000000", 0]] as const) {
      const jpeg = await readBytes(await transformImage(input([transparent]), spec({
        format: "jpeg",
        quality: 100,
        ...(background === undefined ? {} : { background }),
      })));
      const png = await readBytes(await transformImage(input([jpeg]), spec({ format: "png" })));
      const [red, green, blue, alpha] = pngPixel(png);
      for (const value of [red, green, blue]) expect(Math.abs(value - expected)).toBeLessThanOrEqual(2);
      expect(alpha).toBe(255);
    }
  });

  it.each([
    { orientation: 1, width: 3, height: 2, order: [1, 2, 3, 4, 5, 6] },
    { orientation: 2, width: 3, height: 2, order: [3, 2, 1, 6, 5, 4] },
    { orientation: 3, width: 3, height: 2, order: [6, 5, 4, 3, 2, 1] },
    { orientation: 4, width: 3, height: 2, order: [4, 5, 6, 1, 2, 3] },
    { orientation: 5, width: 2, height: 3, order: [1, 4, 2, 5, 3, 6] },
    { orientation: 6, width: 2, height: 3, order: [4, 1, 5, 2, 6, 3] },
    { orientation: 7, width: 2, height: 3, order: [6, 3, 5, 2, 4, 1] },
    { orientation: 8, width: 2, height: 3, order: [3, 6, 2, 5, 1, 4] },
  ])("normalizes Exif orientation $orientation before producing output", async ({ orientation, width, height, order }) => {
    const png = makePng(3, 2, (x, y) => [(y * 3 + x + 1) * 30, 0, 0, 255]);
    const encoded = await readBytes(await transformImage(input([withExifOrientation(png, orientation)]), spec({ format: "png" })));
    expect(imageDimensions(encoded)).toEqual({ format: "png", width, height });
    for (let index = 0; index < order.length; index += 1) {
      expect(pngPixel(encoded, index % width, Math.floor(index / width))).toEqual([order[index]! * 30, 0, 0, 255]);
    }
    // Reprocessing normalized output must not rotate it a second time.
    const again = await readBytes(await transformImage(input([encoded]), spec({ format: "png" })));
    expect(imageDimensions(again)).toEqual({ format: "png", width, height });
    expect(pngPixel(again)).toEqual(pngPixel(encoded));
  });

  it.each(["jpeg", "webp"] as const)("applies %s orientation exactly once and uses oriented resize bounds", async (format) => {
    const encoded = await readBytes(await transformImage(input([makePng(16, 8)]), spec({ format, quality: 100 })));
    const baseline = await readBytes(await transformImage(input([encoded]), spec({ format: "png" })));
    const oriented = await readBytes(await transformImage(input([withExifOrientation(encoded, 6)]), spec({ format: "png" })));
    expect(imageDimensions(oriented)).toEqual({ format: "png", width: 8, height: 16 });
    expect(pngPixel(oriented, 7, 0)).toEqual(pngPixel(baseline, 0, 0));
    expect(pngPixel(oriented, 0, 15)).toEqual(pngPixel(baseline, 15, 7));
    const resized = await readBytes(await transformImage(input([withExifOrientation(encoded, 6)]), spec({
      format: "png", resize: { width: 4 },
    })));
    expect(imageDimensions(resized)).toEqual({ format: "png", width: 4, height: 8 });
  });

  it("rejects a declared oversized input before reading or decoding it", async () => {
    const source = input([makePng()], IMAGE_LIMITS.inputBytes + 1);
    await expect(transformImage(source, spec({ format: "webp" }))).rejects.toMatchObject({
      code: "IMAGE_LIMIT_EXCEEDED",
    });
    expect(source.pull).not.toHaveBeenCalled();
    expect(source.abort).toHaveBeenCalled();
  });

  it("bounds unknown-length input, cancels it, and does not read subsequent chunks", async () => {
    const first = new Uint8Array(IMAGE_LIMITS.inputBytes);
    first.set(makePng());
    const source = input([first, new Uint8Array([1]), new Uint8Array([2])]);
    await expect(transformImage(source, spec({ format: "webp" }))).rejects.toMatchObject({
      code: "IMAGE_LIMIT_EXCEEDED",
    });
    expect(source.pull).toHaveBeenCalledTimes(2);
    expect(source.cancel).toHaveBeenCalled();
    expect(source.abort).toHaveBeenCalled();
  });

  it("rejects a pixel bomb before invoking the decoder", async () => {
    const png = withPngDimensions(makePng(1, 1), 1_001, 1_000);
    await expect(transformImage(input([png]), spec({ format: "jpeg" }))).rejects.toMatchObject({
      code: "IMAGE_LIMIT_EXCEEDED",
    });
  });

  it.each(["png", "jpeg", "webp"] as const)("supports a real image at the declared one-million-pixel bound for %s", async (format) => {
    // Random alpha exercises WebP's allocation-heavy alpha encoder as well as
    // its lossy color encoder; dimensions alone or opaque pixels miss this case.
    const png = format === "webp" ? makeNoisyPng(1_000, 1_000) : makePng(1_000, 1_000);
    expect(png.byteLength).toBeLessThanOrEqual(IMAGE_LIMITS.inputBytes);
    const transformed = await transformImage(input([png]), spec({ format }));
    const bytes = await readBytes(transformed);
    expect(imageDimensions(bytes)).toEqual({ format, width: 1_000, height: 1_000 });
    expect(bytes.byteLength).toBeLessThanOrEqual(IMAGE_LIMITS.outputBytes);
    expect(transformed.knownLength).toBe(bytes.byteLength);
  }, 60_000);

  it("bounds the requested output bitmap before allocating an enlarged result", async () => {
    await expect(transformImage(input([makePng()]), spec({
      format: "png",
      resize: { width: 4_096, fit: "contain" },
    }))).rejects.toMatchObject({ code: "IMAGE_LIMIT_EXCEEDED" });
  });

  it("returns structured errors for unsupported and corrupt image data", async () => {
    await expect(transformImage(input([new TextEncoder().encode("GIF89a")]), spec({ format: "png" })))
      .rejects.toMatchObject({ code: "IMAGE_FORMAT_UNSUPPORTED" });
    await expect(transformImage(input([makePng().subarray(0, 20)]), spec({ format: "png" })))
      .rejects.toMatchObject({ code: "IMAGE_INVALID" });
  });

  it("propagates downstream cancellation to the source", async () => {
    const source = input([makePng()]);
    const transformed = await transformImage(source, spec({ format: "webp" }));
    await transformed.stream.cancel("client disconnected");
    expect(source.abort).toHaveBeenCalledWith("client disconnected");
    await expect(readBytes(await transformImage(input([makePng()]), spec({ format: "png" }))))
      .resolves.toBeInstanceOf(Uint8Array);
  });

  it("cancels a pending source read when its request signal aborts and releases admission", async () => {
    const abort = vi.fn();
    const cancel = vi.fn();
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const transformation = transformImage({
      stream: new ReadableStream<Uint8Array>({ pull() { started?.(); }, cancel }, { highWaterMark: 0 }),
      abort,
    }, spec({ format: "png" }), controller.signal);
    await reading;
    const rejection = expect(transformation).rejects.toMatchObject({ code: "PIPELINE_ABORTED" });
    controller.abort("request disconnected");
    await rejection;
    expect(cancel).toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith("request disconnected");
    await readBytes(await transformImage(input([makePng()]), spec({ format: "png" })));
  });

  it("releases retained encoded output if the request signal aborts before consumption", async () => {
    const controller = new AbortController();
    const source = input([makePng()]);
    const transformed = await transformImage(source, spec({ format: "webp" }), controller.signal);
    controller.abort("client disconnected");
    await expect(readBytes(transformed)).rejects.toMatchObject({ code: "PIPELINE_ABORTED" });
    expect(source.abort).toHaveBeenCalledWith("client disconnected");
    await readBytes(await transformImage(input([makePng()]), spec({ format: "png" })));
  });

  it("keeps admission until encoded output is consumed and emits bounded, nonzero chunks", async () => {
    const noise = makeNoisyPng(256, 256);
    const transformed = await transformImage(input([noise]), spec({ format: "png" }));
    let bytes = 0;
    let chunks = 0;
    const reader = transformed.stream.getReader();
    try {
      await expect(transformImage(input([makePng()]), spec({ format: "png" })))
        .rejects.toMatchObject({ code: "IMAGE_BUSY" });
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        expect(value.byteLength).toBeGreaterThan(0);
        expect(value.byteLength).toBeLessThanOrEqual(64 * 1024);
        expect(value.some((byte) => byte !== 0)).toBe(true);
        bytes += value.byteLength;
        chunks += 1;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    expect(chunks).toBeGreaterThan(1);
    expect(bytes).toBe(transformed.knownLength);
    await readBytes(await transformImage(input([makePng()]), spec({ format: "png" })));
  });

  it("rejects overlapping image work and releases admission after completion", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = transformImage({
      stream: new ReadableStream<Uint8Array>({
        async pull(controller) {
          started?.();
          await blocked;
          controller.enqueue(makePng());
          controller.close();
        },
      }, { highWaterMark: 0 }),
      abort: vi.fn(),
    }, spec({ format: "png" }));
    await readStarted;
    try {
      await expect(transformImage(input([makePng()]), spec({ format: "png" })))
        .rejects.toMatchObject({ code: "IMAGE_BUSY" });
    } finally {
      release?.();
      await readBytes(await first);
    }
    await expect(readBytes(await transformImage(input([makePng()]), spec({ format: "png" }))))
      .resolves.toBeInstanceOf(Uint8Array);
  });
});
