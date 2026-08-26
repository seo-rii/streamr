import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { EntryTransformSpec, FinalTransformSpec } from "../schemas";
import type { ByteStream } from "../streams/byte-stream";
import { appendBytes, decodeAffix, prependBytes } from "./affix";
import { decompressStream } from "./decompress";
import { gzipStream } from "./gzip";
import { limitBytes } from "./limit";
import { multipartFormData, validateMultipartOptions } from "./multipart-form";
import { normalizeNewlines } from "./newline";
import { replaceLiteral, validateReplace } from "./replace";
import { sliceBytes } from "./slice";
import type { EntryTransformOptions } from "./types";

export function validateEntryTransforms(
  transforms: readonly EntryTransformSpec[],
  options: EntryTransformOptions = {},
): void {
  validateCount(transforms);
  let binaryOutput = false;
  transforms.forEach((transform, index) => {
    switch (transform.type) {
      case "decompress":
        binaryOutput = false;
        break;
      case "newline":
      case "replace":
        if (binaryOutput) invalid("A text transform cannot follow a binary envelope transform.");
        if (transform.type === "replace") {
          validateReplace(transform.search, transform.replacement);
        }
        break;
      case "prepend":
      case "append":
        decodeAffix(transform);
        break;
      case "slice":
        if (!Number.isSafeInteger(transform.start) || transform.start < 0) {
          invalid("Slice start must be a non-negative safe integer.");
        }
        if (
          transform.length !== undefined &&
          (!Number.isSafeInteger(transform.length) || transform.length < 0)
        ) {
          invalid("Slice length must be a non-negative safe integer.");
        }
        break;
      case "limit":
        validateLimit(transform.maxBytes);
        break;
      case "gzip":
        binaryOutput = true;
        break;
      case "multipart-form-data":
        if (options.allowMultipartFormData === false) {
          invalid("Multipart form data is only valid for a target upload.");
        }
        if (index !== transforms.length - 1) {
          invalid("Multipart form data must be the final entry transform.");
        }
        validateMultipartOptions(transform);
        binaryOutput = true;
        break;
      default:
        invalid("The entry transform type is unsupported.");
    }
  });
}

export function validateFinalTransforms(transforms: readonly FinalTransformSpec[]): void {
  validateCount(transforms);
  for (const transform of transforms) {
    if (transform.type === "limit") validateLimit(transform.maxBytes);
    else if (transform.type !== "gzip") invalid("The final transform type is unsupported.");
  }
}

export async function applyEntryTransforms(
  input: ByteStream,
  transforms: readonly EntryTransformSpec[],
  options: EntryTransformOptions = {},
): Promise<ByteStream> {
  validateEntryTransforms(transforms, options);
  let output = input;
  for (const transform of transforms) {
    switch (transform.type) {
      case "decompress":
        output = await decompressStream(output, transform.format);
        break;
      case "newline":
        output = normalizeNewlines(output, transform);
        break;
      case "replace":
        output = replaceLiteral(output, transform.search, transform.replacement);
        break;
      case "prepend":
        output = prependBytes(output, decodeAffix(transform));
        break;
      case "append":
        output = appendBytes(output, decodeAffix(transform));
        break;
      case "slice":
        output = sliceBytes(output, transform.start, transform.length);
        break;
      case "limit":
        output = limitBytes(output, transform.maxBytes);
        break;
      case "gzip":
        output = gzipStream(output);
        break;
      case "multipart-form-data":
        output = multipartFormData(output, transform);
        break;
    }
  }
  return output;
}

export async function applyFinalTransforms(
  input: ByteStream,
  transforms: readonly FinalTransformSpec[],
): Promise<ByteStream> {
  validateFinalTransforms(transforms);
  let output = input;
  for (const transform of transforms) {
    output =
      transform.type === "limit"
        ? limitBytes(output, transform.maxBytes)
        : gzipStream(output);
  }
  return output;
}

function validateCount(transforms: readonly unknown[]): void {
  if (transforms.length > LIMITS.transforms) {
    invalid(`At most ${LIMITS.transforms} transforms are allowed.`);
  }
}

function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMITS.requestOutputBytes) {
    invalid("The output limit is invalid.");
  }
}

function invalid(message: string): never {
  throw new GatewayError("INVALID_TRANSFORM", message, { stage: "transform-validate" });
}
