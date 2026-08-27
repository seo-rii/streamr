import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveEntryHandle, OpenedArchive } from "../../src/archive/types";
import { distributeArchive } from "../../src/outputs/distribute";
import { uploadByteStream } from "../../src/outputs/transfer";
import type { DistributionRoute, HttpTargetSpec } from "../../src/schemas";
import type { ByteStream } from "../../src/streams/byte-stream";

const encoder = new TextEncoder();

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function target(path: string, timeoutMs = 300_000): HttpTargetSpec {
  return {
    url: `https://target.test/${path}`,
    method: "PUT",
    successStatus: [200, 201, 204],
    responseBodyLimit: 65_536,
    requireContentLength: false,
    timeoutMs,
  };
}

function route(path: string): DistributionRoute {
  return {
    id: path,
    path,
    occurrence: 1,
    required: true,
    transforms: [],
    target: target(path),
  };
}

function chunkStream(chunks: readonly string[]): {
  byteStream: ByteStream;
  abort: ReturnType<typeof vi.fn>;
} {
  const abort = vi.fn();
  let index = 0;
  return {
    byteStream: {
      stream: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const chunk = chunks[index];
            if (chunk === undefined) {
              controller.close();
              return;
            }
            index += 1;
            controller.enqueue(encoder.encode(chunk));
          },
        },
        { highWaterMark: 0 },
      ),
      abort,
    },
    abort,
  };
}

async function consume(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return bytes;
      bytes += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

interface InstrumentedEntrySpec {
  path: string;
  chunks: number;
  failOnRead?: number;
}

interface InstrumentedArchive {
  archive: OpenedArchive;
  abort: ReturnType<typeof vi.fn>;
  readChunks(path: string): number;
  yielded(): number;
}

function instrumentedArchive(
  specs: readonly InstrumentedEntrySpec[],
  iteratorFailureAfter?: number,
): InstrumentedArchive {
  const readCounts = new Map<string, number>();
  let yielded = 0;
  let activeAbort: ((reason?: unknown) => void) | undefined;
  const abort = vi.fn((reason?: unknown) => activeAbort?.(reason));

  const entries = {
    async *[Symbol.asyncIterator](): AsyncGenerator<ArchiveEntryHandle> {
      for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index];
        if (spec === undefined) throw new Error("missing instrumented entry");
        yielded += 1;
        let state: "discovered" | "opened" | "skipped" = "discovered";
        let completed = false;
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        let resolveCompletion: () => void = () => undefined;
        const completion = new Promise<void>((resolve) => {
          resolveCompletion = resolve;
        });
        const finish = () => {
          if (completed) return;
          completed = true;
          resolveCompletion();
        };
        const abortEntry = (reason?: unknown) => {
          if (completed) return;
          finish();
          try {
            controller?.error(
              reason instanceof Error ? reason : new Error(String(reason ?? "archive aborted")),
            );
          } catch {
            // The stream may already have transitioned while the abort propagated.
          }
        };

        const handle: ArchiveEntryHandle = {
          index: index + 1,
          path: spec.path,
          occurrence: 1,
          unsafePath: false,
          type: "file",
          contentType: "application/octet-stream",
          async open() {
            if (state !== "discovered") throw new Error("entry already consumed");
            state = "opened";
            activeAbort = abortEntry;
            return {
              stream: new ReadableStream<Uint8Array>(
                {
                  start(streamController) {
                    controller = streamController;
                  },
                  pull(streamController) {
                    const read = readCounts.get(spec.path) ?? 0;
                    if (spec.failOnRead !== undefined && read + 1 === spec.failOnRead) {
                      finish();
                      streamController.error(new Error(`drain failed for ${spec.path}`));
                      return;
                    }
                    if (read >= spec.chunks) {
                      finish();
                      streamController.close();
                      return;
                    }
                    readCounts.set(spec.path, read + 1);
                    streamController.enqueue(new Uint8Array([index + 1]));
                  },
                  cancel() {
                    finish();
                  },
                },
                { highWaterMark: 0 },
              ),
              contentType: "application/octet-stream",
              filename: spec.path,
              abort: abortEntry,
            } satisfies ByteStream;
          },
          async skip() {
            if (state !== "discovered") throw new Error("entry already consumed");
            state = "skipped";
            finish();
          },
        };

        yield handle;
        if (state === "discovered") throw new Error("entry was not consumed");
        await completion;
        activeAbort = undefined;
        if (iteratorFailureAfter === index + 1) {
          throw new Error("archive iterator failed");
        }
      }
    },
  };

  return {
    archive: { format: "zip", layers: ["zip"], entries, abort },
    abort,
    readChunks: (path) => readCounts.get(path) ?? 0,
    yielded: () => yielded,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("target streaming edges", () => {
  it("waits for request EOF when a target returns 201 immediately", async () => {
    const source = chunkStream(["ab", "cd", "ef"]);
    let requestBody: ReadableStream<Uint8Array> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = init?.body as ReadableStream<Uint8Array> | undefined;
        return Promise.resolve(new Response(null, { status: 201 }));
      }),
    );

    let settled = false;
    const upload = uploadByteStream(source.byteStream, target("immediate")).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(requestBody).toBeDefined());
    expect(settled).toBe(false);

    if (requestBody === undefined) throw new Error("target request body was not captured");
    const reader = requestBody.getReader();
    const first = await reader.read();
    expect(first).toMatchObject({ done: false });
    await Promise.resolve();
    expect(settled).toBe(false);
    let uploadedBytes = first.value?.byteLength ?? 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      uploadedBytes += result.value.byteLength;
    }
    reader.releaseLock();

    const result = await upload;
    expect(uploadedBytes).toBe(6);
    expect(result).toMatchObject({ targetStatus: 201, bytesWritten: 6 });
    expect(source.abort).not.toHaveBeenCalled();
  });

  it("reads an early duplex response while its body unlocks the request upload", async () => {
    const source = chunkStream(["ab", "cd", "ef"]);
    let targetBytes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const requestBody = init?.body as ReadableStream<Uint8Array> | undefined;
        if (requestBody === undefined) throw new Error("missing duplex request body");
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                // The simulated target will not consume the request until the
                // client begins reading this response body.
                targetBytes = await consume(requestBody);
                controller.enqueue(encoder.encode("ack"));
                controller.close();
              },
            }),
            { status: 201, headers: { "Content-Type": "text/plain" } },
          ),
        );
      }),
    );

    const result = await uploadByteStream(source.byteStream, target("duplex", 500));

    expect(targetBytes).toBe(6);
    expect(result).toEqual({
      targetStatus: 201,
      bytesWritten: 6,
      targetResponse: { contentType: "text/plain", body: "ack", truncated: false },
    });
    expect(source.abort).not.toHaveBeenCalled();
  });

  it.each([
    { status: 302, code: "TARGET_REDIRECT" },
    { status: 500, code: "TARGET_STATUS_REJECTED" },
  ])("awaits request cancellation before returning $code", async ({ status, code }) => {
    const cancelStarted = deferred();
    const allowCancel = deferred();
    const abort = vi.fn();
    const source: ByteStream = {
      stream: new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancelStarted.resolve();
            return allowCancel.promise;
          },
        },
        { highWaterMark: 0 },
      ),
      abort,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status }))),
    );

    let settled = false;
    const upload = uploadByteStream(source, target(`early-${status}`)).finally(() => {
      settled = true;
    });
    await cancelStarted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(abort).toHaveBeenCalled();

    allowCancel.resolve();
    await expect(upload).rejects.toMatchObject({
      code,
      details: { status, requestBodyState: "cancelled" },
    });
  });

  it("cancels the request deterministically when an accepted response disconnects", async () => {
    let sourceCancelled = false;
    const abort = vi.fn();
    const source: ByteStream = {
      stream: new ReadableStream<Uint8Array>(
        {
          cancel() {
            sourceCancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      abort,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error("target disconnected"));
              },
            }),
            { status: 201, headers: { "Content-Type": "text/plain" } },
          ),
        ),
      ),
    );

    await expect(uploadByteStream(source, target("disconnect"))).rejects.toMatchObject({
      code: "TARGET_FETCH_FAILED",
      stage: "target-response",
      details: { requestBodyState: "cancelled" },
    });
    expect(sourceCancelled).toBe(true);
    expect(abort).toHaveBeenCalled();
  });

  it("times out while a textual target response body is stalled", async () => {
    const source = chunkStream(["request"]);
    let responseCancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as ReadableStream<Uint8Array> | undefined;
        if (body === undefined) throw new Error("missing target request body");
        await consume(body);
        return new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined);
            },
            cancel() {
              responseCancelled = true;
            },
          }),
          { status: 201, headers: { "Content-Type": "text/plain" } },
        );
      }),
    );

    await expect(uploadByteStream(source.byteStream, target("stalled", 25))).rejects.toMatchObject({
      code: "TARGET_TIMEOUT",
      stage: "target-response",
    });
    expect(responseCancelled).toBe(true);
  });

  it("does not report a response timeout until response cancellation settles", async () => {
    const source = chunkStream(["request"]);
    const cancelStarted = deferred();
    const allowCancel = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as ReadableStream<Uint8Array> | undefined;
        if (body === undefined) throw new Error("missing timeout request body");
        await consume(body);
        return new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined);
            },
            cancel() {
              cancelStarted.resolve();
              return allowCancel.promise;
            },
          }),
          { status: 201, headers: { "Content-Type": "text/plain" } },
        );
      }),
    );

    let settled = false;
    const upload = uploadByteStream(source.byteStream, target("await-timeout-cleanup", 25)).finally(
      () => {
        settled = true;
      },
    );
    await cancelStarted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);

    allowCancel.resolve();
    await expect(upload).rejects.toMatchObject({
      code: "TARGET_TIMEOUT",
      stage: "target-response",
      details: { requestBodyState: "completed" },
    });
    expect(source.abort).not.toHaveBeenCalled();
  });

  it("aborts instead of draining a large rejected entry under abort policy", async () => {
    const totalChunks = 50_000;
    const fixture = instrumentedArchive([{ path: "large.bin", chunks: totalChunks }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );

    const result = await distributeArchive(fixture.archive, [route("large.bin")], "abort");
    const chunksAtReturn = fixture.readChunks("large.bin");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: "failed" });
    expect(fixture.abort).toHaveBeenCalled();
    expect(chunksAtReturn).toBeLessThan(totalChunks);
    expect(fixture.readChunks("large.bin")).toBe(chunksAtReturn);
  });

  it("drains a rejected entry before processing the next route under continue policy", async () => {
    const fixture = instrumentedArchive([
      { path: "rejected.bin", chunks: 257 },
      { path: "accepted.bin", chunks: 3 },
    ]);
    const targetCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        targetCalls.push(url);
        if (url.endsWith("/rejected.bin")) return new Response(null, { status: 500 });
        const body = init?.body as ReadableStream<Uint8Array> | undefined;
        if (body === undefined) throw new Error("missing target request body");
        await consume(body);
        return new Response(null, { status: 201 });
      }),
    );

    const result = await distributeArchive(
      fixture.archive,
      [route("rejected.bin"), route("accepted.bin")],
      "continue",
    );

    expect(targetCalls).toEqual([
      "https://target.test/rejected.bin",
      "https://target.test/accepted.bin",
    ]);
    expect(fixture.readChunks("rejected.bin")).toBe(257);
    expect(fixture.readChunks("accepted.bin")).toBe(3);
    expect(result.results.map(({ status }) => status)).toEqual(["failed", "uploaded"]);
  });

  it("returns exactly one result per route when draining an entry fails", async () => {
    const fixture = instrumentedArchive([
      { path: "broken.bin", chunks: 100, failOnRead: 4 },
      { path: "second.bin", chunks: 1 },
      { path: "third.bin", chunks: 1 },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );
    const requested = [route("broken.bin"), route("second.bin"), route("third.bin")];

    const result = await distributeArchive(fixture.archive, requested, "continue");

    expect(result.results).toHaveLength(requested.length);
    expect(new Set(result.results.map(({ id }) => id)).size).toBe(requested.length);
    expect(result.results.map(({ status }) => status)).toEqual(["failed", "not-run", "not-run"]);
    expect(result.errors).toHaveLength(1);
    expect(fixture.yielded()).toBe(1);
  });

  it("returns exactly one result per route when archive iteration fails", async () => {
    const fixture = instrumentedArchive([{ path: "first.bin", chunks: 2 }], 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as ReadableStream<Uint8Array> | undefined;
        if (body === undefined) throw new Error("missing target request body");
        await consume(body);
        return new Response(null, { status: 201 });
      }),
    );
    const requested = [route("first.bin"), route("second.bin"), route("third.bin")];

    const result = await distributeArchive(fixture.archive, requested, "continue");

    expect(result.results).toHaveLength(requested.length);
    expect(new Set(result.results.map(({ id }) => id)).size).toBe(requested.length);
    expect(result.results.map(({ status }) => status)).toEqual([
      "uploaded",
      "not-run",
      "not-run",
    ]);
    expect(result.errors).toHaveLength(1);
  });

  it("enforces one aggregate output limit across distribution routes", async () => {
    const fixture = instrumentedArchive([
      { path: "first.bin", chunks: 2 },
      { path: "second.bin", chunks: 2 },
      { path: "third.bin", chunks: 1 },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as ReadableStream<Uint8Array> | undefined;
        if (body === undefined) throw new Error("missing target request body");
        await consume(body);
        return new Response(null, { status: 201 });
      }),
    );

    const result = await distributeArchive(
      fixture.archive,
      [route("first.bin"), route("second.bin"), route("third.bin")],
      "continue",
      undefined,
      undefined,
      3,
    );

    expect(result.results.map(({ status }) => status)).toEqual([
      "uploaded",
      "failed",
      "not-run",
    ]);
    expect(result.results[1]).toMatchObject({
      error: { code: "OUTPUT_LIMIT_EXCEEDED", stage: "request-limit" },
    });
    expect(result.errors).toHaveLength(1);
    expect(fixture.yielded()).toBe(2);
  });
});
