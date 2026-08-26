import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";
import { derivedByteStream, inputChunks, preservedMetadata } from "./stream";
import { assertUnicodeScalar, assertUtf8ContentType, decodeUtf8 } from "./utf8";

export function replaceLiteral(
  input: ByteStream,
  search: string,
  replacement: string,
): ByteStream {
  validateReplace(search, replacement);
  assertUtf8ContentType(input.contentType);
  return derivedByteStream(
    input,
    replace(input, search, replacement),
    preservedMetadata(input, undefined),
  );
}

export function validateReplace(search: string, replacement: string): void {
  if (search.length === 0) {
    throw new GatewayError("INVALID_TRANSFORM", "Replace search must not be empty.", {
      stage: "transform-validate",
    });
  }
  assertUnicodeScalar(search, "search");
  assertUnicodeScalar(replacement, "replacement");
  if (new TextEncoder().encode(search).byteLength > LIMITS.replaceSearchBytes) {
    throw new GatewayError("INVALID_TRANSFORM", "Replace search is too large.", {
      stage: "transform-validate",
      details: { maxBytes: LIMITS.replaceSearchBytes },
    });
  }
}

async function* replace(
  input: ByteStream,
  search: string,
  replacement: string,
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const replacementBytes = encoder.encode(replacement);
  let carry = "";

  function* process(text: string, final: boolean): Generator<Uint8Array> {
    const combined = carry + text;
    let cursor = 0;
    for (;;) {
      const match = combined.indexOf(search, cursor);
      if (match < 0) break;
      const literal = combined.slice(cursor, match);
      if (literal.length > 0) yield encoder.encode(literal);
      if (replacementBytes.byteLength > 0) yield replacementBytes.slice();
      cursor = match + search.length;
    }

    const remainder = combined.slice(cursor);
    if (final) {
      carry = "";
      if (remainder.length > 0) yield encoder.encode(remainder);
      return;
    }

    const retainedLength = Math.min(Math.max(search.length - 1, 0), remainder.length);
    let split = remainder.length - retainedLength;
    const before = remainder.charCodeAt(split - 1);
    const after = remainder.charCodeAt(split);
    if (
      split > 0 &&
      split < remainder.length &&
      before >= 0xd800 &&
      before <= 0xdbff &&
      after >= 0xdc00 &&
      after <= 0xdfff
    ) {
      split -= 1;
    }
    const emitted = remainder.slice(0, split);
    carry = remainder.slice(split);
    if (emitted.length > 0) yield encoder.encode(emitted);
  }

  for await (const chunk of inputChunks(input)) {
    yield* process(decodeUtf8(decoder, chunk, true), false);
  }
  yield* process(decodeUtf8(decoder), true);
}
