import { GatewayError } from "../errors";
import type { HttpTargetSpec } from "../schemas";
import { createTimedAbort } from "../streams/abort";
import type { ByteStream } from "../streams/byte-stream";
import { isTextualContentType, validatedHeaders } from "../util/headers";
import { parseHttpUrl } from "../source/fetch";

const FORBIDDEN_TARGET_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

export interface TargetResponseCapture {
  contentType: string | null;
  body: string | null;
  truncated: boolean;
}

export interface UploadResult {
  targetStatus: number;
  bytesWritten: number;
  targetResponse: TargetResponseCapture;
}

async function captureResponse(
  response: Response,
  limit: number,
): Promise<TargetResponseCapture> {
  const contentType = response.headers.get("Content-Type");
  if (response.body === null) {
    return { contentType, body: null, truncated: false };
  }
  if (!isTextualContentType(contentType)) {
    await response.body.cancel("binary target response is not captured");
    return { contentType, body: null, truncated: true };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limit - total;
    if (value.byteLength > remaining) {
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      total += Math.max(remaining, 0);
      truncated = true;
      await reader.cancel("target response capture limit reached");
      break;
    }
    chunks.push(value);
    total += value.byteLength;
    if (total === limit) {
      const next = await reader.read();
      if (!next.done) {
        truncated = true;
        await reader.cancel("target response capture limit reached");
      }
      break;
    }
  }

  const captured = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    captured.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    contentType,
    body: new TextDecoder().decode(captured),
    truncated,
  };
}

export async function uploadByteStream(
  byteStream: ByteStream,
  target: HttpTargetSpec,
  parentSignal?: AbortSignal,
): Promise<UploadResult> {
  const url = parseHttpUrl(target.url, "target-validate");
  const headers = validatedHeaders(target.headers, {
    forbidden: FORBIDDEN_TARGET_HEADERS,
    stage: "target-validate",
  });
  if (target.contentType !== undefined) {
    if (/[\r\n]/.test(target.contentType)) {
      byteStream.abort("invalid target content type");
      throw new GatewayError("INVALID_CONTENT_TYPE", "The target content type is invalid.", {
        stage: "target-validate",
      });
    }
    headers.set("Content-Type", target.contentType);
  } else if (byteStream.contentType !== undefined) {
    headers.set("Content-Type", byteStream.contentType);
  }

  if (target.requireContentLength && byteStream.knownLength === undefined) {
    byteStream.abort("content length required but unknown");
    throw new GatewayError("CONTENT_LENGTH_UNKNOWN", "The target requires a known content length.", {
      stage: "target-validate",
    });
  }

  const timedAbort = createTimedAbort(target.timeoutMs, parentSignal);
  let bytesWritten = 0;
  const counted = byteStream.stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesWritten += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );

  let body: ReadableStream<Uint8Array> = counted;
  let fixedLengthPump: Promise<void> | undefined;
  if (byteStream.knownLength !== undefined) {
    const fixed = new FixedLengthStream(byteStream.knownLength);
    fixedLengthPump = counted.pipeTo(fixed.writable, {
      signal: timedAbort.controller.signal,
    });
    body = fixed.readable;
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: target.method,
      headers,
      body,
      redirect: "manual",
      signal: timedAbort.controller.signal,
    });
  } catch (error) {
    byteStream.abort(error);
    timedAbort.clear();
    await fixedLengthPump?.catch(() => undefined);
    if (timedAbort.timedOut()) {
      throw new GatewayError("TARGET_TIMEOUT", "The target request timed out.", {
        stage: "target-fetch",
        retryable: true,
        cause: error,
      });
    }
    throw new GatewayError("TARGET_FETCH_FAILED", "The target request failed.", {
      stage: "target-fetch",
      retryable: true,
      cause: error,
    });
  }

  try {
    await fixedLengthPump;
  } catch (error) {
    timedAbort.clear();
    byteStream.abort(error);
    await response.body?.cancel("target body upload failed");
    throw new GatewayError("TARGET_BODY_REJECTED", "The target rejected the request body.", {
      stage: "target-upload",
      retryable: true,
      cause: error,
    });
  }
  timedAbort.clear();

  if (response.status >= 300 && response.status <= 399) {
    await response.body?.cancel("target redirect rejected");
    throw new GatewayError("TARGET_REDIRECT", "Target redirects are not followed.", {
      stage: "target-response",
      details: { status: response.status },
    });
  }

  const targetResponse = await captureResponse(response, target.responseBodyLimit);
  if (!target.successStatus.includes(response.status)) {
    throw new GatewayError("TARGET_STATUS_REJECTED", "The target status was rejected.", {
      stage: "target-response",
      retryable: response.status >= 500,
      details: {
        status: response.status,
        targetResponse,
        bytesWritten,
      },
    });
  }

  return {
    targetStatus: response.status,
    bytesWritten,
    targetResponse,
  };
}

