import { GatewayError } from "../errors";
import { imageTransformSchema, type ImageTransformSpec } from "../schemas";
import type { ByteStream } from "../streams/byte-stream";
import { decodeImage, encodeImage, type ImagePixels } from "./image-codecs";
import { IMAGE_LIMITS, inspectImage } from "./image-metadata";

// Admission only: no payload, job, credentials, or session survives a request.
// Do not queue image requests while another image's bounded output is retained.
let imageActive = false;

export function validateImageTransform(spec: ImageTransformSpec): void {
  const parsed = imageTransformSchema.safeParse(spec);
  if (!parsed.success) {
    throw new GatewayError("INVALID_TRANSFORM", parsed.error.issues[0]?.message ?? "Invalid image transform.", {
      stage: "transform-validate",
    });
  }
}

/** The explicit bounded-image exception to the chunkwise transform contract. */
export async function transformImage(
  input: ByteStream,
  spec: ImageTransformSpec,
  signal?: AbortSignal,
): Promise<ByteStream> {
  validateImageTransform(spec);
  if (imageActive) {
    const error = new GatewayError("IMAGE_BUSY", "Another image is active in this Worker isolate; retry later.", {
      stage: "image-admission", retryable: true,
    });
    input.abort(error);
    await input.stream.cancel(error).catch(() => undefined);
    throw error;
  }
  imageActive = true;
  let released = false;
  let cancelled: unknown;
  let wasCancelled = false;
  let inputBytes: Uint8Array | undefined;
  let pixels: ImagePixels | undefined;
  let encoded: Uint8Array | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const release = () => {
    if (released) return;
    released = true;
    imageActive = false;
    signal?.removeEventListener("abort", onAbort);
  };
  const abort = (reason?: unknown) => {
    if (released) return;
    wasCancelled = true;
    cancelled = reason;
    input.abort(reason);
    void reader?.cancel(reason).catch(() => undefined);
    encoded?.fill(0);
    encoded = undefined;
    outputController?.error(aborted(reason));
    // During input/codec work the catch/finally path owns release and buffers.
    if (outputController !== undefined) release();
  };
  const onAbort = () => abort(signal?.reason);
  const checkAbort = () => {
    if (wasCancelled || signal?.aborted) throw aborted(cancelled ?? signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    checkAbort();
    if (input.knownLength !== undefined && input.knownLength > IMAGE_LIMITS.inputBytes) {
      throw imageLimit("The image input exceeds 4 MiB.");
    }
    // Fixed allocation also bounds metadata for sources that deliver tiny chunks.
    inputBytes = new Uint8Array(IMAGE_LIMITS.inputBytes);
    reader = input.stream.getReader();
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      checkAbort();
      if (chunk.done) break;
      if (chunk.value.byteLength > IMAGE_LIMITS.inputBytes - length) {
        throw imageLimit("The image input exceeds 4 MiB.");
      }
      inputBytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    reader.releaseLock();
    reader = undefined;
    const data = inputBytes.subarray(0, length);
    const metadata = inspectImage(data);
    pixels = await decodeImage(data, metadata.format);
    checkAbort();
    if (pixels.width !== metadata.width || pixels.height !== metadata.height ||
      pixels.data.byteLength !== metadata.width * metadata.height * 4) {
      throw new GatewayError("IMAGE_INVALID", "Decoded image dimensions do not match the inspected header.", { stage: "image-decode" });
    }
    inputBytes.fill(0);
    inputBytes = undefined;
    if ((metadata.orientation ?? 1) !== 1) {
      const oriented = orient(pixels, metadata.orientation!);
      pixels.data.fill(0);
      pixels = oriented;
    }
    if (spec.resize !== undefined) {
      const resized = resize(pixels, spec.resize);
      if (resized !== pixels) pixels.data.fill(0);
      pixels = resized;
    }
    if (spec.format === "jpeg") flattenAlpha(pixels.data, spec.background ?? "#ffffff");
    encoded = await encodeImage(pixels, spec.format, spec.quality ?? 80);
    checkAbort();
    if (encoded.byteLength === 0 || encoded.byteLength > IMAGE_LIMITS.outputBytes) {
      throw imageLimit("The encoded image exceeds the 8 MiB output limit.");
    }
    const knownLength = encoded.byteLength;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { outputController = controller; },
      pull(controller) {
        if (encoded === undefined) return;
        const end = Math.min(offset + 64 * 1024, encoded.byteLength);
        // A downstream chunk must not retain or expose the entire output buffer.
        controller.enqueue(encoded.slice(offset, end));
        offset = end;
        if (offset === encoded.byteLength) {
          encoded.fill(0);
          encoded = undefined;
          controller.close();
          release();
        }
      },
      cancel(reason) { abort(reason); },
    }, { highWaterMark: 0 });
    const extension = spec.format === "jpeg" ? "jpg" : spec.format;
    const filename = input.filename?.replace(/\.[^./\\]*$/, "") ?? "image";
    return {
      stream,
      knownLength,
      contentType: `image/${spec.format}`,
      filename: `${filename}.${extension}`,
      abort,
    };
  } catch (error) {
    const failure = error instanceof GatewayError ? error : new GatewayError(
      "IMAGE_INVALID", "The image could not be decoded or encoded within the codec limits.",
      { stage: "image-transform", cause: error },
    );
    input.abort(failure);
    if (reader !== undefined) {
      await reader.cancel(failure).catch(() => undefined);
      reader.releaseLock();
      reader = undefined;
    } else if (!input.stream.locked) {
      await input.stream.cancel(failure).catch(() => undefined);
    }
    encoded?.fill(0);
    encoded = undefined;
    release();
    throw failure;
  } finally {
    inputBytes?.fill(0);
    pixels?.data.fill(0);
  }
}

function aborted(reason: unknown): GatewayError {
  return new GatewayError("PIPELINE_ABORTED", "The image operation was aborted.", {
    stage: "image-transform", cause: reason,
  });
}

function imageLimit(message: string): GatewayError {
  return new GatewayError("IMAGE_LIMIT_EXCEEDED", message, { stage: "image-transform" });
}

function orient(input: ImagePixels, orientation: number): ImagePixels {
  const swapped = orientation >= 5;
  const width = swapped ? input.height : input.width;
  const height = swapped ? input.width : input.height;
  const data = new Uint8ClampedArray(input.data.length);
  for (let y = 0; y < input.height; y += 1) {
    for (let x = 0; x < input.width; x += 1) {
      const dx = orientation === 2 || orientation === 3 ? input.width - 1 - x
        : orientation === 5 || orientation === 8 ? y
        : orientation === 6 || orientation === 7 ? input.height - 1 - y : x;
      const dy = orientation === 3 || orientation === 4 ? input.height - 1 - y
        : orientation === 5 || orientation === 6 ? x
        : orientation === 7 || orientation === 8 ? input.width - 1 - x : y;
      const source = (y * input.width + x) * 4;
      data.set(input.data.subarray(source, source + 4), (dy * width + dx) * 4);
    }
  }
  return { data, width, height };
}

/** Bilinear premultiplied-alpha sampling; cover samples a crop without a huge intermediate. */
function resize(input: ImagePixels, options: NonNullable<ImageTransformSpec["resize"]>): ImagePixels {
  const fit = options.fit ?? "scale-down";
  const xScale = options.width === undefined ? Infinity : options.width / input.width;
  const yScale = options.height === undefined ? Infinity : options.height / input.height;
  const scale = fit === "cover" ? Math.max(xScale, yScale)
    : Math.min(xScale, yScale, fit === "scale-down" ? 1 : Infinity);
  const width = fit === "cover" ? options.width! : Math.max(1, Math.round(input.width * scale));
  const height = fit === "cover" ? options.height! : Math.max(1, Math.round(input.height * scale));
  if (width > IMAGE_LIMITS.maxDimension || height > IMAGE_LIMITS.maxDimension ||
    width * height > IMAGE_LIMITS.maxPixels) throw imageLimit("The resized image exceeds the pixel or dimension limit.");
  if (width === input.width && height === input.height) return input;
  const cropWidth = fit === "cover" ? width / scale : input.width;
  const cropHeight = fit === "cover" ? height / scale : input.height;
  const left = (input.width - cropWidth) / 2;
  const top = (input.height - cropHeight) / 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.max(0, Math.min(input.height - 1, top + (y + 0.5) * cropHeight / height - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(input.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x += 1) {
      const sx = Math.max(0, Math.min(input.width - 1, left + (x + 0.5) * cropWidth / width - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(input.width - 1, x0 + 1);
      const fx = sx - x0;
      let alpha = 0, red = 0, green = 0, blue = 0;
      for (let sample = 0; sample < 4; sample += 1) {
        const right = sample % 2 === 1;
        const bottom = sample >= 2;
        const weight = (right ? fx : 1 - fx) * (bottom ? fy : 1 - fy);
        const index = ((bottom ? y1 : y0) * input.width + (right ? x1 : x0)) * 4;
        const a = input.data[index + 3]! * weight;
        alpha += a;
        red += input.data[index]! * a;
        green += input.data[index + 1]! * a;
        blue += input.data[index + 2]! * a;
      }
      const index = (y * width + x) * 4;
      data[index] = alpha > 0 ? red / alpha : 0;
      data[index + 1] = alpha > 0 ? green / alpha : 0;
      data[index + 2] = alpha > 0 ? blue / alpha : 0;
      data[index + 3] = alpha;
    }
  }
  return { data, width, height };
}

function flattenAlpha(data: Uint8ClampedArray, color: string): void {
  const background = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3]! / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      data[index + channel] = data[index + channel]! * alpha + background[channel]! * (1 - alpha);
    }
    data[index + 3] = 255;
  }
}
