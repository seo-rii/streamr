import type { ByteStream } from "../streams/byte-stream";
import { derivedByteStream, inputChunks, preservedMetadata } from "./stream";
import { assertUtf8ContentType, decodeUtf8 } from "./utf8";

export interface NewlineOptions {
  mode: "lf" | "crlf";
  ensureFinalNewline: boolean;
}

export function normalizeNewlines(input: ByteStream, options: NewlineOptions): ByteStream {
  assertUtf8ContentType(input.contentType);
  const iterator = normalize(input, options);
  return derivedByteStream(input, iterator, preservedMetadata(input, undefined));
}

async function* normalize(
  input: ByteStream,
  options: NewlineOptions,
): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const newline = options.mode === "lf" ? "\n" : "\r\n";
  let pendingCarriageReturn = false;
  let emittedText = false;
  let endsWithNewline = false;

  function convert(text: string, final: boolean): string {
    let source = text;
    let output = "";
    if (pendingCarriageReturn) {
      if (source.length === 0 && !final) return output;
      if (source.startsWith("\n")) source = source.slice(1);
      output += newline;
      pendingCarriageReturn = false;
    }

    let literalStart = 0;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character !== "\r" && character !== "\n") continue;
      output += source.slice(literalStart, index);
      if (character === "\r") {
        if (index + 1 < source.length) {
          if (source[index + 1] === "\n") index += 1;
          output += newline;
        } else if (final) {
          output += newline;
        } else {
          pendingCarriageReturn = true;
        }
      } else {
        output += newline;
      }
      literalStart = index + 1;
    }
    output += source.slice(literalStart);
    return output;
  }

  function observe(text: string): void {
    if (text.length === 0) return;
    emittedText = true;
    endsWithNewline = text.endsWith("\n");
  }

  for await (const chunk of inputChunks(input)) {
    const converted = convert(decodeUtf8(decoder, chunk, true), false);
    observe(converted);
    if (converted.length > 0) yield encoder.encode(converted);
  }

  const finalText = convert(decodeUtf8(decoder), true);
  observe(finalText);
  if (finalText.length > 0) yield encoder.encode(finalText);
  if (options.ensureFinalNewline && emittedText && !endsWithNewline) {
    yield encoder.encode(newline);
  }
}
