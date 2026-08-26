import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";
import {
  derivedByteStream,
  inputChunks,
  pipeNativeTransform,
  type NativeTransformCompletion,
} from "./stream";

export function gzipStream(input: ByteStream): ByteStream {
  let compressed: ReadableStream<Uint8Array>;
  let completion: Promise<NativeTransformCompletion>;
  try {
    const compressor = new CompressionStream("gzip");
    ({ stream: compressed, completion } = pipeNativeTransform(input.stream, compressor));
  } catch (error) {
    input.abort(error);
    throw new GatewayError("UNSUPPORTED_COMPRESSION", "Gzip compression is unavailable.", {
      stage: "transform-gzip",
      cause: error,
    });
  }

  const compressedInput: ByteStream = {
    stream: compressed,
    abort(reason) {
      input.abort(reason);
    },
  };
  return derivedByteStream(input, readCompressed(compressedInput, completion), {
    contentType: "application/gzip",
    ...(input.filename === undefined ? {} : { filename: input.filename }),
  });
}

async function* readCompressed(
  input: ByteStream,
  completion: Promise<NativeTransformCompletion>,
): AsyncGenerator<Uint8Array> {
  try {
    yield* inputChunks(input);
    const result = await completion;
    if (!result.ok) throw result.error;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("PIPELINE_ABORTED", "Gzip compression failed.", {
      stage: "transform-gzip",
      cause: error,
    });
  }
}
