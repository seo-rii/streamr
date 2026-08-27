import type { ByteStream } from "../streams/byte-stream";

export type RequestResult = "ok" | "partial" | "error" | "aborted";
const RESULT_PRIORITY: Record<RequestResult, number> = {
  ok: 0,
  partial: 1,
  aborted: 2,
  error: 3,
};

export interface RequestMetrics {
  [key: string]: unknown;
  operation: string;
  sourceScheme?: string;
  sourceHost?: string;
  sourcePath?: string;
  archiveFormat?: string;
  routesRequested?: number;
  routesCompleted?: number;
  routesFailed?: number;
  routesMissing?: number;
  entriesScanned?: number;
  sourceGets?: number;
  bytesRead?: number;
  bytesWritten?: number;
  errorCode?: string;
}

export interface RequestLogContext {
  readonly requestId: string;
  setOperation(operation: string): void;
  setSource(url: string): void;
  observeSource(source: {
    finalUrl: string;
    stats: { sourceGets: number; bytesRead: number };
  }): void;
  patch(values: Partial<RequestMetrics>): void;
  addBytesWritten(bytes: number): void;
  markResult(result: RequestResult, error?: unknown): void;
  finish(): void;
}

export function requestId(): string {
  return `req_${crypto.randomUUID()}`;
}

export function safeUrlParts(value: string): {
  scheme: string;
  hostname: string;
  pathname: string;
} | undefined {
  try {
    const url = new URL(value);
    return {
      scheme: url.protocol.replace(/:$/, ""),
      hostname: url.hostname,
      pathname: url.pathname,
    };
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function createRequestLogContext(initialOperation: string): RequestLogContext {
  const startedAt = performance.now();
  const metrics: RequestMetrics = { operation: initialOperation };
  let sourceStats: { sourceGets: number; bytesRead: number } | undefined;
  let result: RequestResult | undefined;
  let finished = false;

  return {
    requestId: requestId(),
    setOperation(operation) {
      metrics.operation = operation;
    },
    setSource(value) {
      const source = safeUrlParts(value);
      if (source === undefined) return;
      metrics.sourceScheme = source.scheme;
      metrics.sourceHost = source.hostname;
      metrics.sourcePath = source.pathname;
    },
    observeSource(source) {
      this.setSource(source.finalUrl);
      sourceStats = source.stats;
    },
    patch(values) {
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined) metrics[key] = value;
      }
    },
    addBytesWritten(bytes) {
      metrics.bytesWritten = (metrics.bytesWritten ?? 0) + bytes;
    },
    markResult(nextResult, error) {
      if (result === undefined || RESULT_PRIORITY[nextResult] > RESULT_PRIORITY[result]) {
        result = nextResult;
      }
      const code = errorCode(error);
      if (code !== undefined) metrics.errorCode = code;
    },
    finish() {
      if (finished) return;
      finished = true;
      if (sourceStats !== undefined) {
        metrics.sourceGets = sourceStats.sourceGets;
        metrics.bytesRead = sourceStats.bytesRead;
      }
      const serialized = JSON.stringify({
        requestId: this.requestId,
        ...metrics,
        durationMs: Math.round(performance.now() - startedAt),
        result: result ?? "ok",
      });
      if (result === "error") console.error(serialized);
      else console.log(serialized);
    },
  };
}

/** Observe the bytes that actually reach an HTTP response consumer. */
export function observeByteStream(
  input: ByteStream,
  log: RequestLogContext,
  countBytes = true,
): ByteStream {
  const reader = input.stream.getReader();
  let settled = false;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  const settle = (result: RequestResult, error?: unknown) => {
    if (settled) return;
    settled = true;
    release();
    log.markResult(result, error);
    log.finish();
  };

  return {
    ...input,
    stream: new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              settle("ok");
              controller.close();
              return;
            }
            if (countBytes) log.addBytesWritten(result.value.byteLength);
            controller.enqueue(result.value);
          } catch (error) {
            input.abort(error);
            settle("error", error);
            controller.error(error);
          }
        },
        async cancel(reason) {
          input.abort(reason);
          try {
            await reader.cancel(reason);
          } finally {
            settle("aborted", reason);
          }
        },
      },
      { highWaterMark: 0 },
    ),
    abort(reason?: unknown) {
      input.abort(reason);
    },
  };
}

/** Observe completion of a bounded control-plane response such as JSON or MCP. */
export function observeResponseCompletion(
  response: Response,
  log: RequestLogContext,
): Response {
  if (response.body === null) {
    log.markResult("ok");
    log.finish();
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  const body = response.body;
  const contentType = headers.get("Content-Type");
  const observed = observeByteStream(
    {
      stream: body,
      ...(contentType === null ? {} : { contentType }),
      abort: (reason?: unknown) => {
        void body.cancel(reason).catch(() => undefined);
      },
    },
    log,
    false,
  );
  return new Response(observed.stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
