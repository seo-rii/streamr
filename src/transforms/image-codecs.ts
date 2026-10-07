import createJpegDecoder from "@jsquash/jpeg/codec/dec/mozjpeg_dec.js";
import createJpegEncoder from "@jsquash/jpeg/codec/enc/mozjpeg_enc.js";
import { defaultOptions as jpegOptions } from "@jsquash/jpeg/meta.js";
import jpegDecoderModule from "../vendor/image/jpeg-dec.wasm";
import jpegEncoderModule from "../vendor/image/jpeg-enc.wasm";
import pngModule from "../vendor/image/png.wasm";
import webpDecoderModule from "../vendor/image/webp-dec.wasm";
import webpEncoderModule from "../vendor/image/webp-enc.wasm";
import { IMAGE_LIMITS } from "./image-metadata";

export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImagePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface Decoder {
  decode(data: Uint8Array, preserveOrientation?: boolean): ImagePixels | null;
}

interface Encoder {
  encode(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    options: Record<string, number | boolean>,
  ): Uint8Array | null;
}

type CodecFactory<T> = (options: {
  noInitialRun: boolean;
  locateFile(path: string): string;
  print(): void;
  printErr(): void;
  instantiateWasm(
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ): WebAssembly.Exports;
}) => Promise<T>;

// The Emscripten codecs construct ImageData, which Workers does not provide.
// This constructor is the only global codec state; it never retains pixels.
function ensureImageData(): void {
  if (typeof globalThis.ImageData !== "undefined") return;
  globalThis.ImageData = class {
    readonly colorSpace = "srgb";
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  } as unknown as typeof ImageData;
}

async function useCodec<T, R>(
  factory: CodecFactory<T>,
  module: WebAssembly.Module,
  operation: (codec: T) => R,
): Promise<R> {
  ensureImageData();
  let memory: WebAssembly.Memory | undefined;
  try {
    const codec = await factory({
      noInitialRun: true,
      locateFile: (path) => path,
      // Do not expose decoder diagnostics containing untrusted image metadata.
      print() {},
      printErr() {},
      instantiateWasm(imports, receive) {
        const instance = new WebAssembly.Instance(module, imports);
        memory = Object.values(instance.exports).find(
          (value): value is WebAssembly.Memory => value instanceof WebAssembly.Memory,
        );
        if (memory === undefined) throw new Error("Image codec memory is unavailable.");
        receive(instance, module);
        return instance.exports;
      },
    });
    return operation(codec);
  } finally {
    // No cached factory promises or Wasm instances: every image starts clean.
    // Clear both allocated and freed codec buffers before allowing collection.
    if (memory !== undefined) new Uint8Array(memory.buffer).fill(0);
  }
}

interface PngExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __wbindgen_malloc(length: number, alignment: number): number;
  __wbindgen_free(pointer: number, length: number, alignment: number): void;
  __wbindgen_add_to_stack_pointer(delta: number): number;
  decode(pointer: number, length: number): number;
  encode(
    output: number,
    pointer: number,
    length: number,
    width: number,
    height: number,
    bitDepth: number,
  ): void;
}

// Adapter for the wasm-bindgen ABI in @jsquash/png 3.1.1. Its generated glue
// retains a process-wide Wasm instance; this adapter instead owns one instance
// and its object table per operation. ABI names are pinned by the binary hashes
// in prepare-image-wasm.mjs. Adapted from jSquash/Squoosh's Apache-2.0 bindings;
// Copyright 2020 Google Inc. See THIRD_PARTY_NOTICES.md and LICENSES/.
class PngCodec {
  private readonly wasm: PngExports;
  private readonly objects: unknown[] = [undefined, null, true, false];

  constructor() {
    const addObject = (object: unknown): number => this.objects.push(object) + 127;
    const getObject = (index: number): unknown => this.objects[index - 128];
    const instance = new WebAssembly.Instance(pngModule, {
      wbg: {
        __wbindgen_memory: () => addObject(this.wasm.memory),
        __wbg_buffer_a448f833075b71ba: (index: number) =>
          addObject((getObject(index) as WebAssembly.Memory).buffer),
        __wbg_newwithbyteoffsetandlength_099217381c451830: (
          index: number,
          offset: number,
          length: number,
        ) => addObject(new Uint16Array(getObject(index) as ArrayBuffer, offset >>> 0, length >>> 0)),
        __wbindgen_object_drop_ref: (index: number) => {
          if (index >= 132) this.objects[index - 128] = undefined;
        },
        __wbg_newwithownedu8clampedarrayandsh_91db5987993a08fb: (
          pointer: number,
          length: number,
          width: number,
          height: number,
        ) => {
          const data = new Uint8ClampedArray(
            this.wasm.memory.buffer,
            pointer >>> 0,
            length >>> 0,
          ).slice();
          this.wasm.__wbindgen_free(pointer, length, 1);
          return addObject({ data, width: width >>> 0, height: height >>> 0 });
        },
        // Only a static message escapes the decoder; do not decode/log arbitrary
        // pointers into the input or sensitive codec memory on malformed data.
        __wbindgen_throw: () => {
          throw new Error("PNG codec rejected the image.");
        },
      },
    });
    this.wasm = instance.exports as PngExports;
  }

  decode(input: Uint8Array): ImagePixels {
    const pointer = this.copyInput(input);
    const index = this.wasm.decode(pointer, input.byteLength);
    const pixels = this.objects[index - 128] as ImagePixels | undefined;
    if (pixels === undefined) throw new Error("PNG decoding failed.");
    this.objects[index - 128] = undefined;
    return pixels;
  }

  encode(pixels: ImagePixels): Uint8Array {
    const output = this.wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const bytes = new Uint8Array(
        pixels.data.buffer,
        pixels.data.byteOffset,
        pixels.data.byteLength,
      );
      const input = this.copyInput(bytes);
      this.wasm.encode(output, input, bytes.byteLength, pixels.width, pixels.height, 8);
      const words = new Uint32Array(this.wasm.memory.buffer);
      const pointer = words[output / 4];
      const length = words[output / 4 + 1];
      if (pointer === undefined || length === undefined || length === 0) {
        throw new Error("PNG encoding failed.");
      }
      const encoded = new Uint8Array(this.wasm.memory.buffer, pointer, length).slice();
      this.wasm.__wbindgen_free(pointer, length, 1);
      return encoded;
    } finally {
      this.wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  dispose(): void {
    new Uint8Array(this.wasm.memory.buffer).fill(0);
    this.objects.length = 0;
  }

  private copyInput(bytes: Uint8Array): number {
    const pointer = this.wasm.__wbindgen_malloc(bytes.byteLength, 1) >>> 0;
    new Uint8Array(this.wasm.memory.buffer).set(bytes, pointer);
    return pointer;
  }
}

interface WebpExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  streamr_alloc(length: number): number;
  streamr_free(pointer: number): void;
  streamr_webp_version(): number;
  streamr_webp_decode(pointer: number, length: number): number;
  streamr_webp_encode(pointer: number, width: number, height: number, quality: number): number;
}

/** A fresh, bounded libwebp reactor; native source and build provenance are vendored. */
class WebpCodec {
  private readonly wasm: WebpExports;

  constructor(module: WebAssembly.Module) {
    const instance = new WebAssembly.Instance(module, {
      env: { emscripten_notify_memory_growth() {} },
      wasi_snapshot_preview1: {
        proc_exit() { throw new Error("WebP codec stopped."); },
        // Never forward native diagnostics containing image data or metadata.
        fd_write() { return 52; },
        fd_close() { return 52; },
        fd_seek() { return 52; },
      },
    });
    this.wasm = instance.exports as WebpExports;
    const initialize = instance.exports._initialize;
    if (typeof initialize === "function") initialize();
    if (this.wasm.streamr_webp_version() < 0x010302) {
      throw new Error("The WebP codec predates the required decoder fixes.");
    }
  }

  decode(input: Uint8Array): ImagePixels {
    const pointer = this.copyInput(input);
    try {
      const result = this.wasm.streamr_webp_decode(pointer, input.byteLength);
      const [data, length, width, height] = this.readResult(result);
      if (width < 1 || height < 1 || width > IMAGE_LIMITS.maxDimension ||
        height > IMAGE_LIMITS.maxDimension || width * height > IMAGE_LIMITS.maxPixels ||
        width * height * 4 !== length) throw new Error("Invalid WebP pixel buffer.");
      const pixels = {
        data: new Uint8ClampedArray(this.wasm.memory.buffer, data, length).slice(), width, height,
      };
      this.wasm.streamr_free(data);
      return pixels;
    } finally {
      this.wasm.streamr_free(pointer);
    }
  }

  encode(pixels: ImagePixels, quality: number): Uint8Array {
    const pointer = this.copyInput(new Uint8Array(
      pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength,
    ));
    try {
      const result = this.wasm.streamr_webp_encode(pointer, pixels.width, pixels.height, quality);
      const [data, length] = this.readResult(result);
      if (length > IMAGE_LIMITS.outputBytes) throw new Error("WebP output exceeds its byte limit.");
      const encoded = new Uint8Array(this.wasm.memory.buffer, data, length).slice();
      this.wasm.streamr_free(data);
      return encoded;
    } finally {
      this.wasm.streamr_free(pointer);
    }
  }

  dispose(): void {
    new Uint8Array(this.wasm.memory.buffer).fill(0);
  }

  private copyInput(bytes: Uint8Array): number {
    const pointer = this.wasm.streamr_alloc(bytes.byteLength) >>> 0;
    if (pointer === 0) throw new Error("WebP input allocation failed.");
    new Uint8Array(this.wasm.memory.buffer).set(bytes, pointer);
    return pointer;
  }

  private readResult(pointer: number): [number, number, number, number] {
    if (pointer === 0) throw new Error("WebP codec rejected the image.");
    const words = new Uint32Array(this.wasm.memory.buffer, pointer >>> 0, 4);
    const data = words[0]!, length = words[1]!, width = words[2]!, height = words[3]!;
    if (data === 0 || length === 0) throw new Error("WebP codec returned an empty result.");
    return [data, length, width, height];
  }
}

function useWebpCodec<R>(module: WebAssembly.Module, operation: (codec: WebpCodec) => R): R {
  const codec = new WebpCodec(module);
  try {
    return operation(codec);
  } finally {
    codec.dispose();
  }
}

/** Inputs have already passed the entry's byte, dimension and pixel limits. */
export async function decodeImage(input: Uint8Array, format: ImageFormat): Promise<ImagePixels> {
  if (format === "png") {
    const codec = new PngCodec();
    try {
      return codec.decode(input);
    } finally {
      codec.dispose();
    }
  }
  if (format === "webp") return useWebpCodec(webpDecoderModule, (codec) => codec.decode(input));
  return useCodec(createJpegDecoder as CodecFactory<Decoder>, jpegDecoderModule, (codec) => {
    // The oddly named preserveOrientation=true option applies an EXIF rotation.
    // The image transform handles orientation consistently across all formats.
    const pixels = codec.decode(input, false);
    if (pixels === null) throw new Error("Image decoding failed.");
    const result = { data: pixels.data.slice(), width: pixels.width, height: pixels.height };
    pixels.data.fill(0);
    return result;
  });
}

/** PNG remains lossless. JPEG and WebP quality is the validated 1–100 value. */
export async function encodeImage(
  pixels: ImagePixels,
  format: ImageFormat,
  quality = 80,
): Promise<Uint8Array> {
  if (format === "png") {
    const codec = new PngCodec();
    try {
      return codec.encode(pixels);
    } finally {
      codec.dispose();
    }
  }
  if (format === "webp") return useWebpCodec(webpEncoderModule, (codec) => codec.encode(pixels, quality));
  const options = { ...jpegOptions, quality, baseline: true, progressive: false };
  return useCodec(createJpegEncoder as CodecFactory<Encoder>, jpegEncoderModule, (codec) => {
    const result = codec.encode(pixels.data, pixels.width, pixels.height, options);
    if (result === null || result.byteLength === 0) throw new Error("Image encoding failed.");
    const encoded = result.slice();
    result.fill(0);
    return encoded;
  });
}
