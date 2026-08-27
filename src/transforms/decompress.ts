import { GatewayError } from "../errors";
import { LIMITS } from "../constants";
import { decompressBzip2 } from "../archive/bzip2";
import { decompressXz } from "../archive/xz";
import { decompressZstd } from "../archive/zstd";
import type { EntryTransformSpec } from "../schemas";
import type { ByteStream } from "../streams/byte-stream";
import { peekByteStream } from "../streams/peek";
import { contentTypeForPath } from "../util/mime";
import {
  derivedByteStream,
  inputChunks,
  pipeNativeTransform,
  type NativeTransformCompletion,
} from "./stream";

type DecompressFormat = Extract<EntryTransformSpec, { type: "decompress" }>["format"];

function decompressedMetadata(source: ByteStream): {
  filename?: string;
  contentType: string;
} {
  const filename = source.filename?.replace(/\.(?:gz|gzip|bz2|xz|zst|zstd)$/i, "");
  return {
    ...(filename === undefined || filename.length === 0 ? {} : { filename }),
    contentType:
      filename === undefined || filename.length === 0
        ? "application/octet-stream"
        : contentTypeForPath(filename),
  };
}

export async function decompressStream(
  input: ByteStream,
  requestedFormat: DecompressFormat,
): Promise<ByteStream> {
  let source = input;
  let format = requestedFormat;
  if (format === "auto") {
    const peeked = await peekByteStream(input, 6);
    source = peeked.byteStream;
    format = detectCompression(peeked.prefix);
    if (format === "auto") {
      await source.stream.cancel("compression format not detected").catch(() => undefined);
      throw new GatewayError(
        "UNSUPPORTED_FORMAT",
        "The compression format could not be detected.",
        { stage: "transform-decompress" },
      );
    }
  }

  if (format !== "gzip") {
    const decompressed =
      format === "bzip2"
        ? decompressBzip2(source, { maxOutputBytes: LIMITS.entryOutputBytes })
        : format === "xz"
          ? decompressXz(source, LIMITS.entryOutputBytes)
          : decompressZstd(source, { maxOutputBytes: LIMITS.entryOutputBytes });
    return {
      ...decompressed,
      ...decompressedMetadata(source),
    };
  }

  let decompressed: ReadableStream<Uint8Array>;
  let completion: Promise<NativeTransformCompletion>;
  try {
    const decompressor = new DecompressionStream("gzip");
    ({ stream: decompressed, completion } = pipeNativeTransform(source.stream, decompressor));
  } catch (error) {
    source.abort(error);
    throw new GatewayError("UNSUPPORTED_COMPRESSION", "Gzip decompression is unavailable.", {
      stage: "transform-decompress",
      cause: error,
    });
  }

  const decompressedInput: ByteStream = {
    stream: decompressed,
    abort(reason) {
      source.abort(reason);
    },
  };
  const metadata = decompressedMetadata(source);
  return derivedByteStream(source, readDecompressed(decompressedInput, completion), metadata);
}

function detectCompression(prefix: Uint8Array): DecompressFormat {
  if (prefix[0] === 0x1f && prefix[1] === 0x8b) return "gzip";
  if (prefix[0] === 0x42 && prefix[1] === 0x5a && prefix[2] === 0x68) return "bzip2";
  if (
    prefix[0] === 0xfd &&
    prefix[1] === 0x37 &&
    prefix[2] === 0x7a &&
    prefix[3] === 0x58 &&
    prefix[4] === 0x5a &&
    prefix[5] === 0x00
  ) {
    return "xz";
  }
  if (prefix[0] === 0x28 && prefix[1] === 0xb5 && prefix[2] === 0x2f && prefix[3] === 0xfd) {
    return "zstd";
  }
  return "auto";
}

async function* readDecompressed(
  input: ByteStream,
  completion: Promise<NativeTransformCompletion>,
): AsyncGenerator<Uint8Array> {
  try {
    yield* inputChunks(input);
    const result = await completion;
    if (!result.ok) throw result.error;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("CORRUPT_ARCHIVE", "The gzip stream is corrupt.", {
      stage: "transform-decompress",
      cause: error,
    });
  }
}
