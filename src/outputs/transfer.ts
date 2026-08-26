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

interface PreparedHttpTarget {
  url: URL;
  headers: Headers;
}

function prepareHttpTarget(target: HttpTargetSpec): PreparedHttpTarget {
  const url = parseHttpUrl(target.url, "target-validate");
  const headers = validatedHeaders(target.headers, {
    forbidden: FORBIDDEN_TARGET_HEADERS,
    stage: "target-validate",
  });
  if (target.contentType !== undefined && /[\r\n]/.test(target.contentType)) {
    throw new GatewayError("INVALID_CONTENT_TYPE", "The target content type is invalid.", {
      stage: "target-validate",
    });
  }
  return { url, headers };
}

/** Validate every target field that does not depend on the eventual body. */
export function validateHttpTarget(target: HttpTargetSpec): void {
  void prepareHttpTarget(target);
}

async function captureResponse(
  response: Response,
  limit: number,
  signal: AbortSignal,
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
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort?.(
      signal.reason ?? new DOMException("The target request was aborted.", "AbortError"),
    );
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
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
        const next = await Promise.race([reader.read(), aborted]);
        if (!next.done) {
          truncated = true;
          await reader.cancel("target response capture limit reached");
        }
        break;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
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
  const { url, headers } = prepareHttpTarget(target);
  if (target.contentType !== undefined) {
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
  const sourceReader = byteStream.stream.getReader();
  let sourceReaderReleased = false;
  let uploadSettled = false;
  let resolveUpload: (() => void) | undefined;
  let rejectUpload: ((reason: unknown) => void) | undefined;
  const sourceCompletion = new Promise<void>((resolve, reject) => {
    resolveUpload = resolve;
    rejectUpload = reject;
  });
  const releaseSourceReader = () => {
    if (sourceReaderReleased) return;
    sourceReaderReleased = true;
    sourceReader.releaseLock();
  };
  const finishUpload = () => {
    if (uploadSettled) return;
    uploadSettled = true;
    releaseSourceReader();
    resolveUpload?.();
  };
  const failUpload = (reason: unknown) => {
    if (uploadSettled) return;
    uploadSettled = true;
    rejectUpload?.(reason);
  };
  const cancelUpload = async (reason: unknown): Promise<void> => {
    failUpload(reason);
    byteStream.abort(reason);
    try {
      await sourceReader.cancel(reason);
    } catch {
      // The source abort path is authoritative; cancellation is best effort.
    } finally {
      releaseSourceReader();
    }
  };

  const counted = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await sourceReader.read();
          if (result.done) {
            finishUpload();
            controller.close();
            return;
          }
          bytesWritten += result.value.byteLength;
          controller.enqueue(result.value);
        } catch (error) {
          failUpload(error);
          releaseSourceReader();
          controller.error(error);
        }
      },
      async cancel(reason) {
        await cancelUpload(reason);
      },
    },
    { highWaterMark: 0 },
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
  const uploadCompletion =
    fixedLengthPump === undefined
      ? sourceCompletion
      : Promise.all([sourceCompletion, fixedLengthPump]).then(() => undefined);
  void uploadCompletion.catch(() => undefined);
  const abortUpload = () => {
    void cancelUpload(timedAbort.controller.signal.reason).catch(() => undefined);
  };
  timedAbort.controller.signal.addEventListener("abort", abortUpload, { once: true });

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
    void cancelUpload(error).catch(() => undefined);
    timedAbort.controller.signal.removeEventListener("abort", abortUpload);
    timedAbort.clear();
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

  if (response.status >= 300 && response.status <= 399) {
    void cancelUpload("target redirect rejected").catch(() => undefined);
    await response.body?.cancel("target redirect rejected");
    timedAbort.controller.signal.removeEventListener("abort", abortUpload);
    timedAbort.clear();
    throw new GatewayError("TARGET_REDIRECT", "Target redirects are not followed.", {
      stage: "target-response",
      details: { status: response.status },
    });
  }

  const statusAccepted = target.successStatus.includes(response.status);
  if (!statusAccepted) {
    void cancelUpload("target status rejected").catch(() => undefined);
  } else {
    try {
      await uploadCompletion;
    } catch (error) {
      timedAbort.controller.signal.removeEventListener("abort", abortUpload);
      timedAbort.clear();
      await response.body?.cancel("target body upload failed");
      if (timedAbort.timedOut()) {
        throw new GatewayError("TARGET_TIMEOUT", "The target request timed out.", {
          stage: "target-upload",
          retryable: true,
          cause: error,
        });
      }
      throw new GatewayError("TARGET_BODY_REJECTED", "The target rejected the request body.", {
        stage: "target-upload",
        retryable: true,
        cause: error,
      });
    }
  }

  let targetResponse: TargetResponseCapture;
  try {
    targetResponse = await captureResponse(
      response,
      target.responseBodyLimit,
      timedAbort.controller.signal,
    );
  } catch (error) {
    timedAbort.controller.signal.removeEventListener("abort", abortUpload);
    timedAbort.clear();
    if (timedAbort.timedOut()) {
      throw new GatewayError("TARGET_TIMEOUT", "The target request timed out.", {
        stage: "target-response",
        retryable: true,
        cause: error,
      });
    }
    throw new GatewayError("TARGET_FETCH_FAILED", "The target response could not be read.", {
      stage: "target-response",
      retryable: true,
      cause: error,
    });
  }
  timedAbort.controller.signal.removeEventListener("abort", abortUpload);
  timedAbort.clear();

  if (!statusAccepted) {
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
