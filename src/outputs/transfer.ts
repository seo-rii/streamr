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

export type UploadCancellationMode =
  | { mode: "abort"; abort(reason?: unknown): void }
  | { mode: "drain" };

export interface UploadByteStreamOptions {
  /**
   * Archive distribution supplies an explicit policy so a rejected target can
   * either abort the enclosing archive first or drain exactly the active entry.
   * Direct transfers use the ByteStream's normal abort path.
   */
  cancellation?: UploadCancellationMode;
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
  options: UploadByteStreamOptions = {},
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
  const requestAbort = new AbortController();
  const responseAbort = new AbortController();
  let bytesWritten = 0;
  let sourceFailure: unknown;
  const sourceReader = byteStream.stream.getReader();
  let sourceReaderReleased = false;
  let requestBodyState:
    | "streaming"
    | "finishing"
    | "completed"
    | "failed"
    | "cancelling"
    | "cancelled" = "streaming";
  let requestBodySettled = false;
  let countedTerminated = false;
  let countedController: ReadableStreamDefaultController<Uint8Array> | undefined;
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
    if (requestBodySettled) return;
    requestBodySettled = true;
    requestBodyState = "finishing";
    releaseSourceReader();
    resolveUpload?.();
  };
  const failUpload = (reason: unknown) => {
    if (requestBodySettled) return;
    requestBodySettled = true;
    rejectUpload?.(reason);
  };
  // The promise is shared by every cancellation path. It is always awaited
  // before this operation returns, so neither a decoder drain nor a source
  // cancellation can outlive the target exchange.
  let cancelUploadPromise: Promise<void> | undefined;
  const cancelUpload = (reason: unknown): Promise<void> => {
    if (requestBodyState === "completed" || requestBodyState === "failed") {
      return cancelUploadPromise ?? Promise.resolve();
    }
    if (cancelUploadPromise !== undefined) return cancelUploadPromise;

    requestBodyState = "cancelling";
    failUpload(reason);
    requestAbort.abort(reason);
    if (!countedTerminated) {
      countedTerminated = true;
      try {
        countedController?.error(reason);
      } catch {
        // A simultaneous fetch-side cancellation may already own termination.
      }
    }

    cancelUploadPromise = (async () => {
      try {
        if (options.cancellation?.mode === "abort") {
          try {
            options.cancellation.abort(reason);
          } catch {
            // Continue with the ByteStream cancellation, which is authoritative.
          }
        }
        try {
          byteStream.abort(reason);
        } catch {
          // The reader cancellation below still releases the stream lock.
        }
        await sourceReader.cancel(reason).catch(() => undefined);
      } finally {
        requestBodyState = "cancelled";
        releaseSourceReader();
      }
    })();
    return cancelUploadPromise;
  };

  const counted = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        countedController = controller;
      },
      async pull(controller) {
        try {
          const result = await sourceReader.read();
          if (countedTerminated) return;
          if (result.done) {
            countedTerminated = true;
            finishUpload();
            controller.close();
            return;
          }
          bytesWritten += result.value.byteLength;
          controller.enqueue(result.value);
        } catch (error) {
          if (countedTerminated) return;
          countedTerminated = true;
          sourceFailure = error;
          requestBodyState = "failed";
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
      signal: requestAbort.signal,
    });
    body = fixed.readable;
  }
  const uploadPumpCompletion =
    fixedLengthPump === undefined
      ? sourceCompletion
      : Promise.all([sourceCompletion, fixedLengthPump]).then(() => undefined);
  const uploadCompletion = uploadPumpCompletion.then(
    () => {
      requestBodyState = "completed";
    },
    (error: unknown) => {
      if (requestBodyState !== "cancelling" && requestBodyState !== "cancelled") {
        requestBodyState = "failed";
      }
      throw error;
    },
  );
  // These handlers observe early rejections until the exchange state machine
  // reaches the corresponding awaited settlement below.
  void sourceCompletion.catch(() => undefined);
  void fixedLengthPump?.catch(() => undefined);
  void uploadCompletion.catch(() => undefined);
  let responseCaptureCompleted = false;
  let activeResponseCapture: Promise<TargetResponseCapture> | undefined;
  let timeoutStage: "target-upload" | "target-response" = "target-upload";
  const abortExchange = () => {
    const reason = timedAbort.controller.signal.reason;
    timeoutStage =
      requestBodyState === "completed" && !responseCaptureCompleted
        ? "target-response"
        : "target-upload";
    responseAbort.abort(reason);
    cancelUpload(reason);
  };
  if (timedAbort.controller.signal.aborted) abortExchange();
  else timedAbort.controller.signal.addEventListener("abort", abortExchange, { once: true });

  try {
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
      responseAbort.abort(error);
      const cancellation = cancelUpload(error);
      await Promise.allSettled([uploadCompletion, cancellation]);
      if (timedAbort.timedOut()) {
        throw new GatewayError("TARGET_TIMEOUT", "The target request timed out.", {
          stage: "target-fetch",
          retryable: true,
          cause: error,
          details: { bytesWritten, requestBodyState },
        });
      }
      if (sourceFailure instanceof GatewayError) throw sourceFailure;
      throw new GatewayError("TARGET_FETCH_FAILED", "The target request failed.", {
        stage: "target-fetch",
        retryable: true,
        cause: error,
        details: { bytesWritten, requestBodyState },
      });
    }

    if (response.status >= 300 && response.status <= 399) {
      const reason = new GatewayError("TARGET_REDIRECT", "Target redirects are not followed.", {
        stage: "target-response",
        details: { status: response.status },
      });
      responseAbort.abort(reason);
      const cancellation = cancelUpload(reason);
      const responseCancellation = response.body?.cancel(reason) ?? Promise.resolve();
      await Promise.allSettled([uploadCompletion, cancellation, responseCancellation]);
      throw new GatewayError("TARGET_REDIRECT", "Target redirects are not followed.", {
        stage: "target-response",
        details: { status: response.status, bytesWritten, requestBodyState },
      });
    }

    let responseCaptureFailed = false;
    let responseCaptureFailure: unknown;
    activeResponseCapture = captureResponse(
      response,
      target.responseBodyLimit,
      responseAbort.signal,
    ).then(
      (capture) => {
        responseCaptureCompleted = true;
        return capture;
      },
      (error: unknown) => {
        responseCaptureFailed = true;
        responseCaptureFailure = error;
        throw error;
      },
    );
    void activeResponseCapture.catch(() => undefined);

    const statusAccepted = target.successStatus.includes(response.status);
    if (!statusAccepted) {
      const cancellation = cancelUpload("target status rejected");
      const [captureOutcome] = await Promise.all([
        activeResponseCapture.then(
          (capture) => ({ ok: true as const, capture }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
        Promise.allSettled([uploadCompletion, cancellation]),
      ]);
      if (!captureOutcome.ok) {
        if (timedAbort.timedOut()) {
          throw new GatewayError("TARGET_TIMEOUT", "The target request timed out.", {
            stage: "target-response",
            retryable: true,
            cause: captureOutcome.error,
            details: { bytesWritten, requestBodyState },
          });
        }
        throw new GatewayError("TARGET_FETCH_FAILED", "The target response could not be read.", {
          stage: "target-response",
          retryable: true,
          cause: captureOutcome.error,
          details: { bytesWritten, requestBodyState },
        });
      }
      throw new GatewayError("TARGET_STATUS_REJECTED", "The target status was rejected.", {
        stage: "target-response",
        retryable: response.status >= 500,
        details: {
          status: response.status,
          targetResponse: captureOutcome.capture,
          bytesWritten,
          requestBodyState,
        },
      });
    }

    let uploadFailed = false;
    let uploadFailure: unknown;
    const monitoredUpload = uploadCompletion.then(
      () => undefined,
      (error: unknown) => {
        uploadFailed = true;
        uploadFailure = error;
        throw error;
      },
    );
    void monitoredUpload.catch(() => undefined);

    try {
      const [, targetResponse] = await Promise.all([monitoredUpload, activeResponseCapture]);
      return {
        targetStatus: response.status,
        bytesWritten,
        targetResponse,
      };
    } catch (error) {
      const uploadFailedBeforeCancellation = uploadFailed;
      const responseFailedBeforeCancellation = responseCaptureFailed;
      responseAbort.abort(error);
      const cancellation = cancelUpload(error);
      await Promise.allSettled([monitoredUpload, activeResponseCapture, cancellation]);

      if (timedAbort.timedOut()) {
        throw new GatewayError("TARGET_TIMEOUT", "The target request timed out.", {
          stage: timeoutStage,
          retryable: true,
          cause: error,
          details: { bytesWritten, requestBodyState },
        });
      }
      if (sourceFailure instanceof GatewayError) throw sourceFailure;
      if (uploadFailedBeforeCancellation && !responseFailedBeforeCancellation) {
        if (uploadFailure instanceof GatewayError) throw uploadFailure;
        throw new GatewayError("TARGET_BODY_REJECTED", "The target rejected the request body.", {
          stage: "target-upload",
          retryable: true,
          cause: uploadFailure,
          details: { bytesWritten, requestBodyState },
        });
      }
      throw new GatewayError("TARGET_FETCH_FAILED", "The target response could not be read.", {
        stage: "target-response",
        retryable: true,
        cause: responseCaptureFailure ?? error,
        details: { bytesWritten, requestBodyState },
      });
    }
  } catch (error) {
    responseAbort.abort(error);
    const cancellation = cancelUpload(error);
    await Promise.allSettled([
      uploadCompletion,
      cancellation,
      ...(activeResponseCapture === undefined ? [] : [activeResponseCapture]),
    ]);
    throw error;
  } finally {
    timedAbort.controller.signal.removeEventListener("abort", abortExchange);
    if (cancelUploadPromise !== undefined) await cancelUploadPromise.catch(() => undefined);
    await Promise.allSettled([uploadCompletion]);
    timedAbort.clear();
  }
}
