import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";
import { derivedByteStream, inputChunks, preservedMetadata } from "./stream";
import { assertUnicodeScalar, assertUtf8ContentType, decodeUtf8 } from "./utf8";

const OUTPUT_CHUNK_BYTES = 64 * 1024;

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
  let carry = "";
  let output = new Uint8Array();
  let outputBytes = 0;

  function takeOutput(): Uint8Array {
    const chunk = outputBytes === output.byteLength ? output : output.slice(0, outputBytes);
    // Full buffers leave this generator; partial flushes copy only their used bytes.
    if (chunk === output) output = new Uint8Array(output.byteLength);
    outputBytes = 0;
    return chunk;
  }

  function* appendText(text: string): Generator<Uint8Array> {
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + output.byteLength - outputBytes);
      if (
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 &&
        text.charCodeAt(end) <= 0xdfff
      ) {
        end -= 1;
      }
      const result = encoder.encodeInto(text.slice(offset, end), output.subarray(outputBytes));
      offset += result.read;
      outputBytes += result.written;
      if (outputBytes === output.byteLength || result.read === 0) yield takeOutput();
    }
  }

  function* process(text: string, final: boolean): Generator<Uint8Array> {
    const combined = carry + text;
    // UTF-8 uses at most three bytes per UTF-16 unit. Small source chunks do
    // not need a full 64 KiB allocation, even when every character matches.
    const capacity = Math.min(
      OUTPUT_CHUNK_BYTES,
      Math.max(4, combined.length * Math.max(1, replacement.length) * 3),
    );
    if (output.byteLength < capacity) output = new Uint8Array(capacity);
    let cursor = 0;
    for (;;) {
      const match = combined.indexOf(search, cursor);
      if (match < 0) break;
      const literal = combined.slice(cursor, match);
      yield* appendText(literal);
      yield* appendText(replacement);
      cursor = match + search.length;
    }

    const remainder = combined.slice(cursor);
    if (final) {
      carry = "";
      yield* appendText(remainder);
      if (outputBytes > 0) yield takeOutput();
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
    yield* appendText(emitted);
    if (outputBytes > 0) yield takeOutput();
  }

  for await (const chunk of inputChunks(input)) {
    yield* process(decodeUtf8(decoder, chunk, true), false);
  }
  yield* process(decodeUtf8(decoder), true);
}
