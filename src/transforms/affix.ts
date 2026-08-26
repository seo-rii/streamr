import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";
import { derivedByteStream, inputChunks, preservedMetadata } from "./stream";
import { assertUnicodeScalar } from "./utf8";

export interface EncodedData {
  encoding: "utf8" | "base64";
  data: string;
}

export function decodeAffix(spec: EncodedData): Uint8Array {
  let decoded: Uint8Array;
  if (spec.encoding === "utf8") {
    assertUnicodeScalar(spec.data, "data");
    const storage = new Uint8Array(LIMITS.affixBytes + 1);
    const result = new TextEncoder().encodeInto(spec.data, storage);
    if (result.read !== spec.data.length || result.written > LIMITS.affixBytes) tooLarge();
    decoded = storage.slice(0, result.written);
  } else {
    const compact = spec.data.replace(/[\t\n\f\r ]/g, "");
    if (
      compact.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
    ) {
      throw new GatewayError("INVALID_TRANSFORM", "The affix contains invalid base64 data.", {
        stage: "transform-validate",
      });
    }
    const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
    if ((compact.length / 4) * 3 - padding > LIMITS.affixBytes) tooLarge();
    try {
      const binary = atob(compact);
      decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch (error) {
      throw new GatewayError("INVALID_TRANSFORM", "The affix contains invalid base64 data.", {
        stage: "transform-validate",
        cause: error,
      });
    }
  }

  if (decoded.byteLength > LIMITS.affixBytes) {
    tooLarge();
  }
  return decoded;
}

function tooLarge(): never {
  throw new GatewayError("INVALID_TRANSFORM", "The decoded affix is too large.", {
    stage: "transform-validate",
    details: { maxBytes: LIMITS.affixBytes },
  });
}

export function prependBytes(input: ByteStream, value: Uint8Array): ByteStream {
  return derivedByteStream(
    input,
    prepend(input, value),
    preservedMetadata(input, undefined),
  );
}

export function appendBytes(input: ByteStream, value: Uint8Array): ByteStream {
  return derivedByteStream(input, append(input, value), preservedMetadata(input, undefined));
}

async function* prepend(input: ByteStream, value: Uint8Array): AsyncGenerator<Uint8Array> {
  if (value.byteLength > 0) yield value;
  yield* inputChunks(input);
}

async function* append(input: ByteStream, value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield* inputChunks(input);
  if (value.byteLength > 0) yield value;
}
