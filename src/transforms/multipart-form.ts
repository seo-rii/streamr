import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";
import { derivedByteStream, inputChunks } from "./stream";
import { assertUnicodeScalar } from "./utf8";

export interface MultipartFormOptions {
  fieldName: string;
  filename: string;
  contentType: string;
  fields: Record<string, string>;
}

export function multipartFormData(
  input: ByteStream,
  options: MultipartFormOptions,
): ByteStream {
  validateMultipartOptions(options);
  const boundary = `sgw_form_${crypto.randomUUID().replaceAll("-", "")}`;
  return derivedByteStream(input, encodeMultipart(input, boundary, options), {
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
}

export function validateMultipartOptions(options: MultipartFormOptions): void {
  validateParameter(options.fieldName, "fieldName");
  validateParameter(options.filename, "filename");
  if (/[\r\n\0]/.test(options.contentType)) invalid("contentType");
  assertUnicodeScalar(options.contentType, "contentType");
  for (const [name, value] of Object.entries(options.fields)) {
    validateParameter(name, "fields");
    assertUnicodeScalar(value, "fields");
  }
}

async function* encodeMultipart(
  input: ByteStream,
  boundary: string,
  options: MultipartFormOptions,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const [name, value] of Object.entries(options.fields)) {
    yield encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(name)}"\r\n\r\n`,
    );
    if (value.length > 0) yield encoder.encode(value);
    yield encoder.encode("\r\n");
  }

  yield encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeQuoted(options.fieldName)}"; ` +
      `filename="${asciiFilename(options.filename)}"; ` +
      `filename*=UTF-8''${encodeRfc5987(options.filename)}\r\n` +
      `Content-Type: ${options.contentType}\r\n\r\n`,
  );
  yield* inputChunks(input);
  yield encoder.encode(`\r\n--${boundary}--\r\n`);
}

function validateParameter(value: string, field: string): void {
  if (/[\r\n\0]/.test(value)) invalid(field);
  assertUnicodeScalar(value, field);
}

function invalid(field: string): never {
  throw new GatewayError("INVALID_TRANSFORM", "The multipart form transform is invalid.", {
    stage: "transform-validate",
    details: { field },
  });
}

function escapeQuoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function asciiFilename(value: string): string {
  return escapeQuoted(value.replace(/[^\x20-\x7e]/g, "_"));
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
