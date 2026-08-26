import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";
import { derivedByteStream, inputChunks, preservedMetadata } from "./stream";

export function limitBytes(input: ByteStream, maxBytes: number): ByteStream {
  if (input.knownLength !== undefined && input.knownLength > maxBytes) {
    input.abort("known output length exceeds the limit");
    throw exceeded(maxBytes, input.knownLength);
  }
  return derivedByteStream(
    input,
    limit(input, maxBytes),
    preservedMetadata(input, input.knownLength),
  );
}

async function* limit(input: ByteStream, maxBytes: number): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of inputChunks(input)) {
    total += chunk.byteLength;
    if (total > maxBytes) throw exceeded(maxBytes, total);
    yield chunk;
  }
}

function exceeded(maxBytes: number, observedBytes: number): GatewayError {
  return new GatewayError("OUTPUT_LIMIT_EXCEEDED", "The transformed output exceeded its limit.", {
    stage: "transform-limit",
    details: { maxBytes, observedBytes },
  });
}
