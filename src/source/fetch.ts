import { SENSITIVE_REDIRECT_HEADERS } from "../constants";
import { GatewayError } from "../errors";
import type { SourceSpec } from "../schemas";
import { createTimedAbort } from "../streams/abort";
import type { ByteStream } from "../streams/byte-stream";
import { wrapCancellableStream } from "../streams/byte-stream";
import { parseContentLength, validatedHeaders } from "../util/headers";
import { contentTypeForPath } from "../util/mime";

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_SOURCE_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

export interface SourceStats {
  bytesRead: number;
  sourceGets: number;
}

export interface FetchedSource {
  status: number;
  finalUrl: string;
  contentType?: string;
  contentLength?: number;
  byteStream: ByteStream;
  stats: SourceStats;
}

export function parseHttpUrl(value: string, stage: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new GatewayError("INVALID_URL", "The URL is invalid.", {
      stage,
      cause: error,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GatewayError("UNSUPPORTED_SCHEME", "Only HTTP and HTTPS URLs are supported.", {
      stage,
      details: { scheme: url.protocol.replace(/:$/, "") },
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new GatewayError("INVALID_URL", "Credentials must be supplied as headers, not in a URL.", {
      stage,
    });
  }
  if (/^\[.*\]$/.test(url.hostname) || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname)) {
    throw new GatewayError("INVALID_URL", "Cloudflare subrequests require a DNS hostname.", {
      stage,
    });
  }
  return url;
}

export async function fetchSource(
  spec: SourceSpec,
  parentSignal?: AbortSignal,
): Promise<FetchedSource> {
  let url = parseHttpUrl(spec.url, "source-validate");
  const headers = validatedHeaders(spec.headers, {
    forbidden: FORBIDDEN_SOURCE_HEADERS,
    stage: "source-validate",
  });
  if (!headers.has("Accept-Encoding")) headers.set("Accept-Encoding", "identity");

  const timedAbort = createTimedAbort(spec.timeoutMs, parentSignal);
  const stats: SourceStats = { bytesRead: 0, sourceGets: 0 };
  let response: Response | undefined;

  try {
    for (let redirects = 0; ; redirects += 1) {
      stats.sourceGets += 1;
      response = await fetch(url.toString(), {
        method: "GET",
        headers,
        redirect: "manual",
        signal: timedAbort.controller.signal,
      });

      if (!REDIRECT_STATUS.has(response.status)) break;
      const location = response.headers.get("Location");
      if (location === null) break;
      if (redirects >= spec.redirect.max) {
        await response.body?.cancel("source redirect limit exceeded");
        throw new GatewayError("SOURCE_REDIRECT_LIMIT", "The source redirect limit was exceeded.", {
          stage: "source-fetch",
          retryable: false,
          details: { max: spec.redirect.max },
        });
      }

      let nextUrl: URL;
      try {
        nextUrl = new URL(location, url);
      } catch (error) {
        await response.body?.cancel("invalid redirect location");
        throw new GatewayError("INVALID_URL", "The source returned an invalid redirect URL.", {
          stage: "source-fetch",
          cause: error,
        });
      }
      parseHttpUrl(nextUrl.toString(), "source-fetch");

      if (
        nextUrl.origin !== url.origin &&
        !spec.redirect.forwardSensitiveHeadersAcrossHosts
      ) {
        for (const name of SENSITIVE_REDIRECT_HEADERS) headers.delete(name);
      }

      await response.body?.cancel("following source redirect");
      url = nextUrl;
    }
  } catch (error) {
    timedAbort.clear();
    if (error instanceof GatewayError) throw error;
    if (timedAbort.timedOut()) {
      throw new GatewayError("SOURCE_TIMEOUT", "The source request timed out.", {
        stage: "source-fetch",
        retryable: true,
        cause: error,
      });
    }
    throw new GatewayError("SOURCE_FETCH_FAILED", "The source request failed.", {
      stage: "source-fetch",
      retryable: true,
      cause: error,
    });
  }

  if (!spec.acceptStatus.includes(response.status)) {
    timedAbort.clear();
    await response.body?.cancel("source status rejected");
    throw new GatewayError("SOURCE_STATUS_REJECTED", "The source status was rejected.", {
      stage: "source-fetch",
      retryable: response.status >= 500,
      details: { status: response.status },
    });
  }
  if (response.body === null) {
    timedAbort.clear();
    throw new GatewayError("SOURCE_BODY_MISSING", "The source response has no body.", {
      stage: "source-fetch",
      retryable: true,
    });
  }

  const contentLength = parseContentLength(response.headers.get("Content-Length"));
  const contentType = response.headers.get("Content-Type") ?? contentTypeForPath(url.pathname);
  const encodedFilename = url.pathname.split("/").at(-1) ?? "";
  let filename = encodedFilename;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    // Keep the encoded path segment when the upstream URL has invalid escapes.
  }
  const abort = (reason?: unknown) => {
    timedAbort.clear();
    if (!timedAbort.controller.signal.aborted) timedAbort.controller.abort(reason);
  };
  const countedStream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        stats.bytesRead += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );

  const byteStream: ByteStream = {
    stream: wrapCancellableStream(
      countedStream,
      abort,
      timedAbort.clear,
      (error) => {
        if (error instanceof GatewayError) return error;
        if (timedAbort.timedOut()) {
          return new GatewayError("SOURCE_TIMEOUT", "The source request timed out.", {
            stage: "source-read",
            retryable: true,
            cause: error,
          });
        }
        if (parentSignal?.aborted === true) {
          return new GatewayError("PIPELINE_ABORTED", "The pipeline was aborted.", {
            stage: "source-read",
            retryable: true,
            cause: error,
          });
        }
        return new GatewayError("SOURCE_FETCH_FAILED", "The source body could not be read.", {
          stage: "source-read",
          retryable: true,
          cause: error,
        });
      },
    ),
    ...(contentLength === undefined ? {} : { knownLength: contentLength }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(filename.length === 0 ? {} : { filename }),
    abort,
  };

  return {
    status: response.status,
    finalUrl: url.toString(),
    ...(contentType === undefined ? {} : { contentType }),
    ...(contentLength === undefined ? {} : { contentLength }),
    byteStream,
    stats,
  };
}
