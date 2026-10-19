import { env } from "cloudflare:workers";
import { packTar } from "modern-tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../src/constants";
import { routeRequest } from "../../src/routes";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const override = "application/x-explicit";
const sourceUrl = "https://source.test/payload.bin";
const targetUrl = "https://target.test/upload";
const cleanups: Array<() => void> = [];
const pendingRequests: Array<Promise<Response>> = [];

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

function dispatch(path: string, body: unknown): Promise<Response> {
  const request = new Request(`https://streamr.test${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MCP_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  // Keep the gated source and target I/O in the test's request context.
  const pending = routeRequest(request, env, {} as ExecutionContext);
  pendingRequests.push(pending);
  void pending.catch(() => undefined);
  return pending;
}

/** The source cannot finish until the test has observed downstream progress. */
function gatedSource(first: Uint8Array, rest: Uint8Array, knownLength = false) {
  const remaining = gate();
  const restRequested = gate();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let firstPending = true;
  let ended = false;
  let released = false;
  let sourceSignal: AbortSignal | undefined;
  const stop = () => {
    if (!ended) {
      ended = true;
      controller?.error(sourceSignal?.reason ?? new DOMException("Source stopped.", "AbortError"));
    }
    remaining.release();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    async pull(value) {
      if (firstPending) {
        firstPending = false;
        value.enqueue(first);
        return;
      }
      restRequested.release();
      await remaining.promise;
      if (ended) return;
      if (rest.byteLength > 0) value.enqueue(rest);
      ended = true;
      value.close();
    },
    cancel() {
      ended = true;
      remaining.release();
    },
  }, { highWaterMark: 0 });
  cleanups.push(() => {
    stop();
    sourceSignal?.removeEventListener("abort", stop);
  });

  return {
    get released() { return released; },
    get signal() { return sourceSignal; },
    restRequested: restRequested.promise,
    release() {
      released = true;
      remaining.release();
    },
    response(signal?: AbortSignal | null): Response {
      sourceSignal = signal ?? undefined;
      if (sourceSignal?.aborted) stop();
      else sourceSignal?.addEventListener("abort", stop, { once: true });
      const headers = new Headers({ "Content-Type": "text/plain" });
      if (knownLength) headers.set("Content-Length", String(first.byteLength + rest.byteLength));
      return new Response(stream, { headers });
    },
  };
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let result = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return result + decoder.decode();
    result += decoder.decode(chunk.value, { stream: true });
  }
}

describe("explicit MIME overrides", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    await Promise.allSettled(pendingRequests.splice(0));
    vi.unstubAllGlobals();
  });

  it.each([false, true])("streams the first chunk before the MIME prefix fills (known length: %s)", async (knownLength) => {
    const source = gatedSource(encoder.encode("first\n"), encoder.encode("tail\n"), knownLength);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => source.response(init?.signal)));

    const response = await dispatch("/v1/stream", {
      source: { url: sourceUrl },
      output: { contentType: override },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(override);
    expect(response.headers.get("Content-Length")).toBe(knownLength ? "11" : null);
    const reader = response.body!.getReader();
    try {
      expect(decoder.decode((await reader.read()).value)).toBe("first\n");
      expect(source.released).toBe(false);
      source.release();
      await expect(readText(reader)).resolves.toBe("tail\n");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  });

  it.each([false, true])("starts uploading before the source fills the MIME prefix (newline transform: %s)", async (normalizeNewlines) => {
    const source = gatedSource(encoder.encode("first\r\n"), encoder.encode("tail\r\n"));
    const firstUploaded = gate();
    let uploaded = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === sourceUrl) return source.response(init?.signal);
      expect(String(input)).toBe(targetUrl);
      expect(new Headers(init?.headers).get("Content-Type")).toBe(override);
      if (!(init?.body instanceof ReadableStream)) throw new Error("Missing streaming upload body.");
      const reader = init.body.getReader();
      try {
        uploaded = decoder.decode((await reader.read()).value);
        expect(source.released).toBe(false);
        firstUploaded.release();
        uploaded += await readText(reader);
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return new Response(null, { status: 201 });
    }));

    const pending = dispatch("/v1/transfer", {
      source: { url: sourceUrl },
      entryTransforms: normalizeNewlines ? [{ type: "newline", mode: "lf" }] : [],
      target: { url: targetUrl, method: "PUT", contentType: override },
    });
    await firstUploaded.promise;
    expect(uploaded).toBe(normalizeNewlines ? "first\n" : "first\r\n");
    source.release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(uploaded).toBe(normalizeNewlines ? "first\ntail\n" : "first\r\ntail\r\n");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      bytesWritten: normalizeNewlines ? 11 : 13,
      targetStatus: 201,
    });
  });

  it("streams a selected TAR entry before the entry's MIME prefix fills", async () => {
    const tar = await packTar([{
      header: { name: "selected.bin", size: 128 },
      body: "x".repeat(64) + "y".repeat(64),
    }]);
    // The archive header is available; the second half of the selected entry is gated.
    const source = gatedSource(tar.subarray(0, 512 + 64), tar.subarray(512 + 64));
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => source.response(init?.signal)));

    const response = await dispatch("/v1/stream", {
      source: { url: "https://source.test/archive.tar" },
      archive: { entries: [{ path: "selected.bin" }] },
      output: { contentType: override },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(override);
    expect(response.headers.get("Content-Length")).toBe("128");
    expect(response.headers.get("X-Stream-Gateway-Integrity-Scope")).toBe("selected-entry");
    const reader = response.body!.getReader();
    try {
      expect(decoder.decode((await reader.read()).value)).toBe("x".repeat(64));
      expect(source.released).toBe(false);
      source.release();
      await expect(readText(reader)).resolves.toBe("y".repeat(64));
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  });

  it.each(["/v1/stream", "/v1/transfer"])("retains magic precedence without an override on %s", async (path) => {
    const first = new Uint8Array(64);
    first.set([0x1f, 0x8b, 0x08]);
    const source = gatedSource(first, new Uint8Array(1));
    let uploadedContentType: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === sourceUrl) return source.response(init?.signal);
      uploadedContentType = new Headers(init?.headers).get("Content-Type");
      await new Response(init?.body).arrayBuffer();
      return new Response(null, { status: 201 });
    }));

    const pending = dispatch(path, {
      source: { url: sourceUrl },
      ...(path === "/v1/stream" ? {} : { target: { url: targetUrl, method: "PUT" } }),
    });
    await source.restRequested;
    source.release();
    const response = await pending;
    expect(response.status).toBe(200);
    if (path === "/v1/stream") {
      expect(response.headers.get("Content-Type")).toBe("application/gzip");
      expect((await response.arrayBuffer()).byteLength).toBe(65);
    } else {
      expect(uploadedContentType).toBe("application/gzip");
      await expect(response.json()).resolves.toMatchObject({ ok: true, bytesWritten: 65 });
    }
  });

  it.each(["/v1/stream", "/v1/transfer"])("preserves empty bodies with an override on %s", async (path) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === sourceUrl) {
        return new Response("", { headers: { "Content-Length": "0" } });
      }
      expect(new Headers(init?.headers).get("Content-Type")).toBe(override);
      await expect(new Response(init?.body).text()).resolves.toBe("");
      return new Response(null, { status: 201 });
    }));

    const response = await dispatch(path, {
      source: { url: sourceUrl },
      ...(path === "/v1/stream"
        ? { output: { contentType: override } }
        : { target: { url: targetUrl, method: "PUT", contentType: override } }),
    });
    expect(response.status).toBe(200);
    if (path === "/v1/stream") {
      expect(response.headers.get("Content-Type")).toBe(override);
      expect(response.headers.get("Content-Length")).toBe("0");
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    } else {
      await expect(response.json()).resolves.toMatchObject({ ok: true, bytesWritten: 0 });
    }
  });

  it("cancels a stalled source after an overridden response starts", async () => {
    const source = gatedSource(encoder.encode("first"), encoder.encode("tail"));
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => source.response(init?.signal)));
    const response = await dispatch("/v1/stream", {
      source: { url: sourceUrl },
      output: { contentType: override },
    });
    const reader = response.body!.getReader();
    try {
      expect(decoder.decode((await reader.read()).value)).toBe("first");
      expect(source.released).toBe(false);
      await reader.cancel("consumer disconnected");
      expect(source.signal?.aborted).toBe(true);
    } finally {
      reader.releaseLock();
    }
  });

  it.each(["/v1/stream", "/v1/transfer"])("retains the entry byte limit with an override on %s", async (path) => {
    let sourceSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sourceSignal = init?.signal ?? undefined;
      return new Response("small fixture", {
        headers: { "Content-Length": String(LIMITS.entryOutputBytes + 1) },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await dispatch(path, {
      source: { url: sourceUrl },
      ...(path === "/v1/stream"
        ? { output: { contentType: override } }
        : { target: { url: targetUrl, method: "PUT", contentType: override } }),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "ENTRY_OUTPUT_LIMIT" } });
    expect(sourceSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
