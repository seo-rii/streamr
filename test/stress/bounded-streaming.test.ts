import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveEntryHandle, OpenedArchive } from "../../src/archive/types";
import { distributeArchive } from "../../src/outputs/distribute";
import { rawResponse } from "../../src/outputs/raw-response";
import { uploadByteStream } from "../../src/outputs/transfer";
import type { DistributionRoute, HttpTargetSpec } from "../../src/schemas";
import type { ByteStream } from "../../src/streams/byte-stream";

const GIBIBYTE = 1024 * 1024 * 1024;
const MEBIBYTE = 1024 * 1024;

declare const RUN_STREAMR_STRESS_FROM_HOST: string | undefined;

const RUN_STRESS =
  (typeof RUN_STREAMR_STRESS_FROM_HOST !== "undefined" &&
    RUN_STREAMR_STRESS_FROM_HOST === "1") ||
  process.env.RUN_STREAMR_STRESS === "1";

interface SyntheticStream {
  byteStream: ByteStream;
  producedBytes(): number;
  maximumOutstandingBytes(): number;
  consume(byteLength: number): void;
  abort: ReturnType<typeof vi.fn>;
}

function syntheticStream(totalBytes: number, chunkBytes: number): SyntheticStream {
  const reusableChunk = new Uint8Array(chunkBytes);
  const abort = vi.fn();
  let produced = 0;
  let consumed = 0;
  let maximumOutstanding = 0;

  return {
    byteStream: {
      stream: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (produced === totalBytes) {
              controller.close();
              return;
            }
            const byteLength = Math.min(chunkBytes, totalBytes - produced);
            produced += byteLength;
            maximumOutstanding = Math.max(maximumOutstanding, produced - consumed);
            controller.enqueue(
              byteLength === reusableChunk.byteLength
                ? reusableChunk
                : reusableChunk.subarray(0, byteLength),
            );
          },
        },
        { highWaterMark: 0 },
      ),
      knownLength: totalBytes,
      contentType: "application/octet-stream",
      abort,
    },
    producedBytes: () => produced,
    maximumOutstandingBytes: () => maximumOutstanding,
    consume(byteLength: number) {
      consumed += byteLength;
    },
    abort,
  };
}

async function consume(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (byteLength: number) => void,
): Promise<number> {
  const reader = stream.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return bytes;
      bytes += result.value.byteLength;
      onChunk?.(result.value.byteLength);
      // A deliberately slower consumer gives upstream queues an opportunity to
      // overproduce if backpressure is not wired through the pipeline.
      await Promise.resolve();
    }
  } finally {
    reader.releaseLock();
  }
}

function target(path: string, timeoutMs = 300_000): HttpTargetSpec {
  return {
    url: `https://target.test/${path}`,
    method: "PUT",
    successStatus: [201, 204],
    responseBodyLimit: 0,
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

interface ManyEntryArchive {
  archive: OpenedArchive;
  maximumActiveEntries(): number;
  abort: ReturnType<typeof vi.fn>;
}

function manyEntryArchive(paths: readonly string[]): ManyEntryArchive {
  let activeEntries = 0;
  let maximumActiveEntries = 0;
  const abort = vi.fn();

  const entries = {
    async *[Symbol.asyncIterator](): AsyncGenerator<ArchiveEntryHandle> {
      for (let index = 0; index < paths.length; index += 1) {
        const path = paths[index];
        if (path === undefined) throw new Error("missing stress entry path");
        let state: "discovered" | "opened" | "skipped" = "discovered";
        let finished = false;
        let resolveCompletion: () => void = () => undefined;
        const completion = new Promise<void>((resolve) => {
          resolveCompletion = resolve;
        });
        const finish = () => {
          if (finished) return;
          finished = true;
          if (state === "opened") activeEntries -= 1;
          resolveCompletion();
        };

        const handle: ArchiveEntryHandle = {
          index: index + 1,
          path,
          occurrence: 1,
          unsafePath: false,
          type: "file",
          size: 1,
          contentType: "application/octet-stream",
          async open() {
            if (state !== "discovered") throw new Error("stress entry already consumed");
            state = "opened";
            activeEntries += 1;
            maximumActiveEntries = Math.max(maximumActiveEntries, activeEntries);
            let sent = false;
            return {
              stream: new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    if (sent) {
                      finish();
                      controller.close();
                      return;
                    }
                    sent = true;
                    controller.enqueue(new Uint8Array([index % 256]));
                  },
                  cancel() {
                    finish();
                  },
                },
                { highWaterMark: 0 },
              ),
              knownLength: 1,
              contentType: "application/octet-stream",
              filename: path,
              abort: finish,
            } satisfies ByteStream;
          },
          async skip() {
            if (state !== "discovered") throw new Error("stress entry already consumed");
            state = "skipped";
            finish();
          },
        };

        yield handle;
        if (state === "discovered") throw new Error("stress entry was not consumed");
        await completion;
      }
    },
  };

  return {
    archive: { format: "zip", layers: ["zip"], entries, abort },
    maximumActiveEntries: () => maximumActiveEntries,
    abort,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("bounded small stress", () => {
  it("distributes 200 entries sequentially in archive order", async () => {
    const paths = Array.from(
      { length: 200 },
      (_, index) => `entries/${index.toString().padStart(3, "0")}.bin`,
    );
    const fixture = manyEntryArchive(paths);
    let activeTargets = 0;
    let maximumActiveTargets = 0;
    const targetOrder: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        activeTargets += 1;
        maximumActiveTargets = Math.max(maximumActiveTargets, activeTargets);
        try {
          const body = init?.body as ReadableStream<Uint8Array> | undefined;
          if (body === undefined) throw new Error("missing stress target body");
          expect(await consume(body)).toBe(1);
          targetOrder.push(new URL(String(input)).pathname.slice(1));
          return new Response(null, { status: 204 });
        } finally {
          activeTargets -= 1;
        }
      }),
    );

    const result = await distributeArchive(
      fixture.archive,
      [...paths].reverse().map(route),
      "abort",
    );

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(200);
    expect(result.results.every(({ status }) => status === "uploaded")).toBe(true);
    expect(result.results.map(({ path }) => path)).toEqual(paths);
    expect(targetOrder).toEqual(paths);
    expect(fixture.maximumActiveEntries()).toBe(1);
    expect(maximumActiveTargets).toBe(1);
    expect(fixture.abort).toHaveBeenCalledWith("all distribution routes completed");
  });
});

describe.runIf(RUN_STRESS)("opt-in 1 GiB streaming stress", () => {
  it(
    "streams a synthetic 1 GiB raw response with a bounded outstanding window",
    async () => {
      const source = syntheticStream(GIBIBYTE, MEBIBYTE);
      const response = rawResponse(source.byteStream, {});
      if (response.body === null) throw new Error("raw stress response body is missing");

      // The raw response pump may begin before the client reads, but must stop
      // after a bounded amount instead of consuming the full synthetic source.
      await Promise.resolve();
      await Promise.resolve();
      expect(source.producedBytes()).toBeLessThanOrEqual(8 * MEBIBYTE);

      const consumed = await consume(response.body, (byteLength) => source.consume(byteLength));
      expect(consumed).toBe(GIBIBYTE);
      expect(source.producedBytes()).toBe(GIBIBYTE);
      expect(source.maximumOutstandingBytes()).toBeLessThanOrEqual(8 * MEBIBYTE);
      expect(source.abort).not.toHaveBeenCalled();
    },
    120_000,
  );

  it(
    "streams a synthetic 1 GiB transfer and propagates stalled-target backpressure",
    async () => {
      const source = syntheticStream(GIBIBYTE, MEBIBYTE);
      let releaseTarget: () => void = () => undefined;
      const targetGate = new Promise<void>((resolve) => {
        releaseTarget = resolve;
      });
      let signalFetchStarted: () => void = () => undefined;
      const fetchStarted = new Promise<void>((resolve) => {
        signalFetchStarted = resolve;
      });
      let receivedBytes = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          signalFetchStarted();
          await targetGate;
          const body = init?.body as ReadableStream<Uint8Array> | undefined;
          if (body === undefined) throw new Error("missing 1 GiB target body");
          receivedBytes = await consume(body, (byteLength) => source.consume(byteLength));
          return new Response(null, { status: 201 });
        }),
      );

      const upload = uploadByteStream(source.byteStream, target("one-gib", 300_000));
      await fetchStarted;
      await Promise.resolve();
      await Promise.resolve();
      expect(source.producedBytes()).toBeLessThanOrEqual(8 * MEBIBYTE);
      releaseTarget();

      const result = await upload;
      expect(receivedBytes).toBe(GIBIBYTE);
      expect(result.bytesWritten).toBe(GIBIBYTE);
      expect(source.maximumOutstandingBytes()).toBeLessThanOrEqual(8 * MEBIBYTE);
      expect(source.abort).not.toHaveBeenCalled();
    },
    120_000,
  );
});
