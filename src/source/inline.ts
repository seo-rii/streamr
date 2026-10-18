import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { InlineSourceSpec } from "../schemas";
import type { ByteStream } from "../streams/byte-stream";

/** Validate all inline bytes before an external target can receive any data. */
export function createInlineByteStream(
  content: InlineSourceSpec,
  signal?: AbortSignal,
): ByteStream & { knownLength: number; contentType: string } {
  if (signal?.aborted) {
    throw new GatewayError("PIPELINE_ABORTED", "The inline source was aborted.", {
      stage: "source-read",
      cause: signal.reason,
    });
  }
  for (const field of ["contentType", "filename"] as const) {
    if (content[field] !== undefined && /[\r\n]/.test(content[field])) {
      throw new GatewayError("INVALID_REQUEST", "The inline content metadata is invalid.", {
        stage: "source-validate",
        details: { field: `source.${field}` },
      });
    }
  }
  if (content.contentType !== undefined) {
    try {
      new Headers({ "Content-Type": content.contentType });
    } catch (cause) {
      throw new GatewayError("INVALID_REQUEST", "The inline content type is invalid.", {
        stage: "source-validate",
        cause,
        details: { field: "source.contentType" },
      });
    }
  }

  let decoded: Uint8Array;
  if (content.encoding === "utf8") {
    let length = 0;
    for (let index = 0; index < content.data.length; index += 1) {
      const unit = content.data.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = content.data.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) invalidUnicode();
        index += 1;
        length += 4;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        invalidUnicode();
      } else {
        length += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
      }
      if (length > LIMITS.inlineSourceBytes) tooLarge();
    }
    decoded = new TextEncoder().encode(content.data);
  } else {
    const compact = content.data.replace(/[\t\n\f\r ]/g, "");
    // A character-class repetition avoids recursive groups for multi-MiB data.
    if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
      invalidBase64();
    }
    const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
    if ((compact.length / 4) * 3 - padding > LIMITS.inlineSourceBytes) tooLarge();
    try {
      const binary = atob(compact);
      decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch (error) {
      invalidBase64(error);
    }
  }

  const knownLength = decoded.byteLength;
  let bytes: Uint8Array | undefined = decoded;
  let offset = 0;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    finished = true;
    bytes = undefined;
    signal?.removeEventListener("abort", onParentAbort);
  };
  const abort = (reason?: unknown) => {
    if (finished) return;
    finish();
    controller.error(
      reason ??
        new GatewayError("PIPELINE_ABORTED", "The inline source was aborted.", {
          stage: "source-read",
        }),
    );
  };
  const onParentAbort = () =>
    abort(new GatewayError("PIPELINE_ABORTED", "The inline source was aborted.", {
      stage: "source-read",
      cause: signal?.reason,
    }));
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      pull(value) {
        if (bytes === undefined || offset === knownLength) {
          finish();
          value.close();
          return;
        }
        const end = Math.min(offset + 64 * 1024, knownLength);
        value.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark: 0 },
  );
  signal?.addEventListener("abort", onParentAbort, { once: true });

  return {
    stream,
    knownLength,
    contentType:
      content.contentType ??
      (content.encoding === "utf8" ? "text/plain; charset=utf-8" : "application/octet-stream"),
    ...(content.filename === undefined ? {} : { filename: content.filename }),
    abort,
  };
}

function invalidUnicode(): never {
  throw new GatewayError("INVALID_REQUEST", "The inline text contains an unpaired surrogate.", {
    stage: "source-validate",
    details: { field: "source.data" },
  });
}

function invalidBase64(cause?: unknown): never {
  throw new GatewayError("INVALID_REQUEST", "The inline content contains invalid base64 data.", {
    stage: "source-validate",
    cause,
    details: { field: "source.data" },
  });
}

function tooLarge(): never {
  throw new GatewayError("INVALID_REQUEST", "The decoded inline content is too large.", {
    stage: "source-validate",
    status: 413,
    details: { maxBytes: LIMITS.inlineSourceBytes },
  });
}
