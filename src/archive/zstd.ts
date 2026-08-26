import { Decompress } from "fzstd";
import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";
import type { DecompressionOptions } from "./bzip2";

const ZSTD_INPUT_BATCH = 4 * 1024;
const ZSTD_CALLBACK_QUEUE_BYTES = 16 * 1024 * 1024;
const EMPTY = new Uint8Array();

function decompressionError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError(
    "CORRUPT_ARCHIVE",
    "The ZSTD stream is corrupt or truncated.",
    {
      stage: "decompress",
      cause: error,
      details: { format: "zstd" },
    },
  );
}

export function decompressZstd(
  input: ByteStream,
  options: DecompressionOptions = {},
): ByteStream {
  const maxOutputBytes = options.maxOutputBytes ?? LIMITS.requestOutputBytes;
  const reader = input.stream.getReader();
  const queue: Uint8Array[] = [];
  let queueBytes = 0;
  let outputBytes = 0;
  let current: Uint8Array | undefined;
  let offset = 0;
  let sourceFinished = false;
  let decoderFinished = false;
  let stopped = false;

  const decoder = new Decompress((chunk, final) => {
    if (chunk.byteLength > 0) {
      if (outputBytes > maxOutputBytes - chunk.byteLength) {
        throw new GatewayError(
          "OUTPUT_LIMIT_EXCEEDED",
          "The decompressed output exceeds the configured limit.",
          {
            stage: "decompress",
            details: { format: "zstd", maxBytes: maxOutputBytes },
          },
        );
      }
      if (queueBytes > ZSTD_CALLBACK_QUEUE_BYTES - chunk.byteLength) {
        throw new GatewayError(
          "OUTPUT_LIMIT_EXCEEDED",
          "A ZSTD decoder output burst exceeds the bounded queue.",
          {
            stage: "decompress",
            details: {
              format: "zstd",
              maxBytes: ZSTD_CALLBACK_QUEUE_BYTES,
              reason: "decoder-callback-queue",
            },
          },
        );
      }
      outputBytes += chunk.byteLength;
      queueBytes += chunk.byteLength;
      queue.push(chunk);
    }
    if (final === true) decoderFinished = true;
  });

  const cancelInput = async (reason?: unknown): Promise<void> => {
    if (stopped) return;
    stopped = true;
    input.abort(reason);
    try {
      await reader.cancel(reason);
    } catch {
      // The source abort signal is authoritative; cancellation is best effort.
    }
  };

  const pushNextBatch = async (): Promise<void> => {
    while (current === undefined || offset >= current.byteLength) {
      const result = await reader.read();
      if (result.done) {
        sourceFinished = true;
        decoder.push(EMPTY, true);
        return;
      }
      if (result.value.byteLength === 0) continue;
      current = result.value;
      offset = 0;
    }

    const end = Math.min(offset + ZSTD_INPUT_BATCH, current.byteLength);
    const batch = current.subarray(offset, end);
    offset = end;
    decoder.push(batch, false);
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (queue.length === 0 && !decoderFinished) {
            if (sourceFinished) {
              throw new GatewayError(
                "CORRUPT_ARCHIVE",
                "The ZSTD stream ended without a complete frame.",
                { stage: "decompress", details: { format: "zstd" } },
              );
            }
            await pushNextBatch();
          }

          const chunk = queue.shift();
          if (chunk !== undefined) {
            queueBytes -= chunk.byteLength;
            controller.enqueue(chunk);
            return;
          }
          stopped = true;
          controller.close();
        } catch (cause) {
          const error = decompressionError(cause);
          await cancelInput(error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        queue.length = 0;
        queueBytes = 0;
        await cancelInput(reason);
      },
    },
    { highWaterMark: 0 },
  );

  return {
    stream,
    abort(reason?: unknown) {
      void cancelInput(reason);
    },
  };
}
