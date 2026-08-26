import { LIMITS } from "../constants";
import { GatewayError, type GatewayErrorCode } from "../errors";
import type { ByteStream } from "../streams/byte-stream";
import { derivedByteStream, inputChunks, preservedMetadata } from "./stream";

export function limitBytes(input: ByteStream, maxBytes: number): ByteStream {
  return limitWithError(input, maxBytes, "OUTPUT_LIMIT_EXCEEDED");
}

export function limitEntryBytes(
  input: ByteStream,
  maxBytes: number = LIMITS.entryOutputBytes,
): ByteStream {
  return limitWithError(input, maxBytes, "ENTRY_OUTPUT_LIMIT");
}

function limitWithError(
  input: ByteStream,
  maxBytes: number,
  code: "OUTPUT_LIMIT_EXCEEDED" | "ENTRY_OUTPUT_LIMIT",
): ByteStream {
  if (input.knownLength !== undefined && input.knownLength > maxBytes) {
    input.abort("known output length exceeds the limit");
    throw exceeded(code, maxBytes, input.knownLength);
  }
  return derivedByteStream(
    input,
    limit(input, maxBytes, code),
    preservedMetadata(input, input.knownLength),
  );
}

async function* limit(
  input: ByteStream,
  maxBytes: number,
  code: "OUTPUT_LIMIT_EXCEEDED" | "ENTRY_OUTPUT_LIMIT",
): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of inputChunks(input)) {
    total += chunk.byteLength;
    if (total > maxBytes) throw exceeded(code, maxBytes, total);
    yield chunk;
  }
}

function exceeded(
  code: GatewayErrorCode,
  maxBytes: number,
  observedBytes: number,
): GatewayError {
  return new GatewayError(code, "The transformed output exceeded its limit.", {
    stage: code === "ENTRY_OUTPUT_LIMIT" ? "entry-limit" : "transform-limit",
    details: { maxBytes, observedBytes },
  });
}
