import type { ByteStream } from "./byte-stream";

export interface PeekedByteStream {
  prefix: Uint8Array;
  byteStream: ByteStream;
}

export async function peekByteStream(
  input: ByteStream,
  maxBytes: number,
): Promise<PeekedByteStream> {
  const reader = input.stream.getReader();
  const prefixChunks: Uint8Array[] = [];
  let prefixLength = 0;
  let remainder: Uint8Array | undefined;

  try {
    while (prefixLength < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const needed = maxBytes - prefixLength;
      if (value.byteLength <= needed) {
        prefixChunks.push(value);
        prefixLength += value.byteLength;
      } else {
        prefixChunks.push(value.subarray(0, needed));
        prefixLength += needed;
        remainder = value.subarray(needed);
      }
    }
  } catch (error) {
    input.abort(error);
    reader.releaseLock();
    throw error;
  }

  const prefix = new Uint8Array(prefixLength);
  let offset = 0;
  for (const chunk of prefixChunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let replayed = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        if (prefix.byteLength > 0) controller.enqueue(prefix);
        return;
      }
      if (remainder !== undefined) {
        const chunk = remainder;
        remainder = undefined;
        controller.enqueue(chunk);
        return;
      }
      try {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      input.abort(reason);
      await reader.cancel(reason);
    },
  });

  return {
    prefix,
    byteStream: {
      ...input,
      stream,
    },
  };
}
