import unbzip2Stream from "@openpgp/unbzip2-stream";
import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";

const BZIP2_INPUT_BATCH = 4 * 1024;

export interface DecompressionOptions {
  maxOutputBytes?: number;
}

interface Bzip2InputBridge {
  stream: ReadableStream<Uint8Array>;
  cancel(reason?: unknown): Promise<void>;
}

function decompressionError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError(
    "CORRUPT_ARCHIVE",
    "The BZIP2 stream is corrupt or truncated.",
    {
      stage: "decompress",
      cause: error,
      details: { format: "bzip2" },
    },
  );
}

/**
 * The upstream decoder calls the non-standard `reader.abort()` from its
 * cancellation hook. This bridge deliberately supplies that alias while also
 * slicing every source chunk into bounded decoder input batches.
 */
function createInputBridge(input: ByteStream): Bzip2InputBridge {
  const reader = input.stream.getReader();
  let current: Uint8Array | undefined;
  let offset = 0;
  let cancelled = false;
  let readerTaken = false;

  const cancel = async (reason?: unknown): Promise<void> => {
    if (cancelled) return;
    cancelled = true;
    input.abort(reason);
    try {
      await reader.cancel(reason);
    } catch {
      // The source abort signal is authoritative; cancellation is best effort.
    }
  };

  const compatibleReader = {
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (cancelled) return { done: true, value: undefined };
      while (current === undefined || offset >= current.byteLength) {
        const result = await reader.read();
        if (result.done) return { done: true, value: undefined };
        if (result.value.byteLength === 0) continue;
        current = result.value;
        offset = 0;
      }

      const end = Math.min(offset + BZIP2_INPUT_BATCH, current.byteLength);
      const value = current.subarray(offset, end);
      offset = end;
      return { done: false, value };
    },
    abort: cancel,
  };

  // The decoder only calls getReader(), read(), and abort(). Keeping this as a
  // structural adapter avoids modifying the dependency while fixing its
  // cancellation bug for Workers.
  const stream = {
    getReader() {
      if (readerTaken) throw new TypeError("The BZIP2 input is already locked.");
      readerTaken = true;
      return compatibleReader;
    },
  } as unknown as ReadableStream<Uint8Array>;

  return { stream, cancel };
}

export function decompressBzip2(
  input: ByteStream,
  options: DecompressionOptions = {},
): ByteStream {
  const maxOutputBytes = options.maxOutputBytes ?? LIMITS.requestOutputBytes;
  const bridge = createInputBridge(input);
  let decoded: ReadableStream<Uint8Array>;
  try {
    decoded = unbzip2Stream(bridge.stream);
  } catch (error) {
    void bridge.cancel(error);
    throw decompressionError(error);
  }

  const reader = decoded.getReader();
  let outputBytes = 0;
  let finished = false;

  // The dependency emits at most one format-level BZIP2 block (900 KiB) from
  // each pull. Combined with its bounded compressed look-ahead, this keeps the
  // synchronous decoder burst bounded while downstream demand is paused.

  const stop = async (reason?: unknown): Promise<void> => {
    if (finished) return;
    finished = true;
    try {
      await reader.cancel(reason);
    } catch {
      await bridge.cancel(reason);
    }
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            finished = true;
            controller.close();
            return;
          }
          if (outputBytes > maxOutputBytes - result.value.byteLength) {
            const error = new GatewayError(
              "OUTPUT_LIMIT_EXCEEDED",
              "The decompressed output exceeds the configured limit.",
              {
                stage: "decompress",
                details: { format: "bzip2", maxBytes: maxOutputBytes },
              },
            );
            await stop(error);
            controller.error(error);
            return;
          }
          outputBytes += result.value.byteLength;
          if (result.value.byteLength > 0) controller.enqueue(result.value);
        } catch (cause) {
          const error = decompressionError(cause);
          await stop(error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        await stop(reason);
      },
    },
    { highWaterMark: 0 },
  );

  return {
    stream,
    abort(reason?: unknown) {
      void stop(reason);
    },
  };
}
