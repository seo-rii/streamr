import type { ByteStream } from "../streams/byte-stream";
import { derivedByteStream, inputChunks, preservedMetadata } from "./stream";

export function sliceBytes(input: ByteStream, start: number, length?: number): ByteStream {
  const knownLength =
    input.knownLength === undefined
      ? undefined
      : Math.min(Math.max(input.knownLength - start, 0), length ?? Number.POSITIVE_INFINITY);
  return derivedByteStream(
    input,
    slice(input, start, length),
    preservedMetadata(input, knownLength),
  );
}

async function* slice(
  input: ByteStream,
  start: number,
  length?: number,
): AsyncGenerator<Uint8Array> {
  let skip = start;
  let remaining = length;
  if (remaining === 0) {
    input.abort("slice completed without reading the source");
    return;
  }

  for await (const chunk of inputChunks(input)) {
    if (skip >= chunk.byteLength) {
      skip -= chunk.byteLength;
      continue;
    }

    const available = chunk.subarray(skip);
    skip = 0;
    if (remaining === undefined) {
      yield available;
      continue;
    }

    const emitted = available.subarray(0, Math.min(available.byteLength, remaining));
    if (emitted.byteLength > 0) yield emitted;
    remaining -= emitted.byteLength;
    if (remaining === 0) {
      input.abort("slice length reached");
      return;
    }
  }
}
