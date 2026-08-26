import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";

export function decompressGzip(input: ByteStream): ByteStream {
  let stream: ReadableStream<Uint8Array>;
  try {
    const decoder = new DecompressionStream("gzip") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >;
    stream = input.stream.pipeThrough(decoder);
  } catch (error) {
    input.abort(error);
    throw new GatewayError("UNSUPPORTED_COMPRESSION", "GZIP decompression is unavailable.", {
      stage: "decompress",
      cause: error,
      details: { format: "gzip" },
    });
  }

  return {
    stream,
    abort(reason?: unknown) {
      input.abort(reason);
    },
  };
}
