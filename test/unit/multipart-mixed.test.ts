import { describe, expect, it, vi } from "vitest";
import type { ArchiveEntryHandle, ArchiveEntryType, OpenedArchive } from "../../src/archive/types";
import { GatewayError } from "../../src/errors";
import {
  createMultipartMixedStream,
  type MultipartMixedManifest,
} from "../../src/outputs/multipart-mixed";
import type { EntrySelector } from "../../src/schemas";
import type { ByteStream } from "../../src/streams/byte-stream";

const encoder = new TextEncoder();

interface FakeEntry {
  path: string;
  body?: string;
  occurrence?: number;
  type?: ArchiveEntryType;
  chunks?: string[];
}

interface FakeArchive {
  archive: OpenedArchive;
  abort: ReturnType<typeof vi.fn>;
  maxActive: () => number;
  bodyPulls: () => number;
}

function fakeArchive(entries: readonly FakeEntry[], throwAfter?: number): FakeArchive {
  const abort = vi.fn();
  let active = 0;
  let maximumActive = 0;
  let pulls = 0;

  const archive: OpenedArchive = {
    format: "test",
    layers: ["test"],
    entries: {
      async *[Symbol.asyncIterator](): AsyncGenerator<ArchiveEntryHandle> {
        for (let offset = 0; offset < entries.length; offset += 1) {
          const specification = entries[offset];
          if (specification === undefined) throw new Error("missing fake entry");
          let consumed = false;
          let resolveCompletion: () => void = () => undefined;
          const completion = new Promise<void>((resolve) => {
            resolveCompletion = resolve;
          });
          const chunks = (specification.chunks ?? [specification.body ?? ""]).map((chunk) =>
            encoder.encode(chunk),
          );

          const handle: ArchiveEntryHandle = {
            index: offset + 1,
            path: specification.path,
            occurrence: specification.occurrence ?? 1,
            unsafePath: false,
            type: specification.type ?? "file",
            size: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
            contentType: "text/plain; charset=utf-8",
            async open(): Promise<ByteStream> {
              if (consumed) throw new Error("fake entry consumed twice");
              consumed = true;
              active += 1;
              maximumActive = Math.max(maximumActive, active);
              let index = 0;
              let finished = false;
              const finish = () => {
                if (finished) return;
                finished = true;
                active -= 1;
                resolveCompletion();
              };
              return {
                stream: new ReadableStream<Uint8Array>(
                  {
                    pull(controller) {
                      pulls += 1;
                      const chunk = chunks[index];
                      index += 1;
                      if (chunk === undefined) {
                        finish();
                        controller.close();
                      } else {
                        controller.enqueue(chunk);
                      }
                    },
                    cancel() {
                      finish();
                    },
                  },
                  { highWaterMark: 0 },
                ),
                knownLength: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
                contentType: "text/plain; charset=utf-8",
                filename: specification.path.split("/").at(-1) || "entry",
                abort: vi.fn(),
              };
            },
            async skip() {
              if (consumed) throw new Error("fake entry consumed twice");
              consumed = true;
              resolveCompletion();
            },
          };

          yield handle;
          if (!consumed) throw new Error("fake entry was not consumed");
          await completion;
          if (throwAfter === offset + 1) {
            throw new GatewayError("CORRUPT_ARCHIVE", "Synthetic archive corruption.", {
              stage: "archive-read",
            });
          }
        }
      },
    },
    abort,
  };

  return {
    archive,
    abort,
    maxActive: () => maximumActive,
    bodyPulls: () => pulls,
  };
}

function pendingIteratorArchive(): {
  archive: OpenedArchive;
  abort: ReturnType<typeof vi.fn>;
  nextPendingStarted: Promise<void>;
  iteratorReturned: Promise<void>;
} {
  let rejectPendingNext: (reason: unknown) => void = () => undefined;
  let markNextPendingStarted: () => void = () => undefined;
  let markIteratorReturned: () => void = () => undefined;
  const pendingNext = new Promise<never>((_resolve, reject) => {
    rejectPendingNext = reject;
  });
  const nextPendingStarted = new Promise<void>((resolve) => {
    markNextPendingStarted = resolve;
  });
  const iteratorReturned = new Promise<void>((resolve) => {
    markIteratorReturned = resolve;
  });
  const abort = vi.fn((reason?: unknown) => {
    rejectPendingNext(
      reason instanceof Error
        ? reason
        : new GatewayError("PIPELINE_ABORTED", "Synthetic archive abort.", {
            stage: "archive-read",
            cause: reason,
          }),
    );
  });
  let nextCalls = 0;
  let consumed = false;
  const entry: ArchiveEntryHandle = {
    index: 1,
    path: "available.txt",
    occurrence: 1,
    unsafePath: false,
    type: "file",
    contentType: "text/plain; charset=utf-8",
    async open(): Promise<ByteStream> {
      if (consumed) throw new Error("pending entry consumed twice");
      consumed = true;
      return {
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("body"));
            controller.close();
          },
        }),
        knownLength: 4,
        contentType: "text/plain; charset=utf-8",
        filename: "available.txt",
        abort: vi.fn(),
      };
    },
    async skip() {
      if (consumed) throw new Error("pending entry consumed twice");
      consumed = true;
    },
  };
  const iterator: AsyncIterator<ArchiveEntryHandle> = {
    async next(): Promise<IteratorResult<ArchiveEntryHandle>> {
      nextCalls += 1;
      if (nextCalls === 1) return { done: false, value: entry };
      markNextPendingStarted();
      return pendingNext;
    },
    async return(): Promise<IteratorResult<ArchiveEntryHandle, undefined>> {
      rejectPendingNext(
        new GatewayError("PIPELINE_ABORTED", "Synthetic iterator return.", {
          stage: "archive-read",
        }),
      );
      markIteratorReturned();
      return { done: true, value: undefined };
    },
  };

  const archive: OpenedArchive = {
    format: "test",
    layers: ["test"],
    entries: {
      [Symbol.asyncIterator](): AsyncIterator<ArchiveEntryHandle> {
        return iterator;
      },
    },
    abort,
  };

  return { archive, abort, nextPendingStarted, iteratorReturned };
}

function selector(
  path: string,
  occurrence = 1,
  required = true,
  id?: string,
): EntrySelector {
  return { ...(id === undefined ? {} : { id }), path, occurrence, required };
}

async function render(
  source: FakeArchive,
  selectors: readonly EntrySelector[],
  transforms: Parameters<typeof createMultipartMixedStream>[2] = [],
): Promise<{ text: string; boundary: string; manifest: MultipartMixedManifest }> {
  const result = await createMultipartMixedStream(source.archive, selectors, transforms);
  const text = await new Response(result.byteStream.stream).text();
  const marker = "X-Stream-Gateway-Control: manifest\r\n\r\n";
  const start = text.lastIndexOf(marker);
  if (start < 0) throw new Error("manifest marker missing");
  const bodyStart = start + marker.length;
  const bodyEnd = text.indexOf(`\r\n--${result.boundary}--\r\n`, bodyStart);
  if (bodyEnd < 0) throw new Error("manifest terminator missing");
  return {
    text,
    boundary: result.boundary,
    manifest: JSON.parse(text.slice(bodyStart, bodyEnd)) as MultipartMixedManifest,
  };
}

describe("multipart/mixed archive output", () => {
  it("emits selected entries in archive order rather than request order", async () => {
    const source = fakeArchive([
      { path: "A.txt", body: "body-a" },
      { path: "B.txt", body: "body-b" },
      { path: "C.txt", body: "body-c" },
    ]);
    const output = await render(source, [
      selector("C.txt", 1, true, "selector-c"),
      selector("A.txt", 1, true, "selector-a"),
      selector("B.txt", 1, false, "selector-b"),
    ]);

    expect(output.text.indexOf("X-Archive-Path: A.txt")).toBeLessThan(
      output.text.indexOf("X-Archive-Path: B.txt"),
    );
    expect(output.text.indexOf("X-Archive-Path: B.txt")).toBeLessThan(
      output.text.indexOf("X-Archive-Path: C.txt"),
    );
    expect(output.text).toContain("X-Stream-Gateway-Selector-Id: selector-a");
    expect(output.text).toContain("X-Stream-Gateway-Selector-Path: A.txt");
    expect(output.text).toContain("X-Stream-Gateway-Selector-Occurrence: 1");
    expect(output.text).toContain("X-Stream-Gateway-Selector-Required: true");
    expect(output.manifest).toEqual({
      ok: true,
      requested: 3,
      emitted: 3,
      missing: [],
      errors: [],
      selectors: [
        {
          id: "selector-c",
          path: "C.txt",
          occurrence: 1,
          required: true,
          status: "emitted",
          archiveIndex: 3,
        },
        {
          id: "selector-a",
          path: "A.txt",
          occurrence: 1,
          required: true,
          status: "emitted",
          archiveIndex: 1,
        },
        {
          id: "selector-b",
          path: "B.txt",
          occurrence: 1,
          required: false,
          status: "emitted",
          archiveIndex: 2,
        },
      ],
      archive: {
        fullyScanned: false,
        stoppedEarly: true,
        integrityScope: "selected-entries",
      },
    });
    expect(output.text.endsWith(`--${output.boundary}--\r\n`)).toBe(true);
  });

  it("matches an exact duplicate occurrence and rejects duplicate selectors defensively", async () => {
    const source = fakeArchive([
      { path: "same.in", occurrence: 1, body: "first" },
      { path: "same.in", occurrence: 2, body: "second" },
    ]);
    const output = await render(source, [selector("same.in", 2)]);
    expect(output.text).toContain("second");
    expect(output.text).not.toContain("first");

    await expect(
      createMultipartMixedStream(fakeArchive([]).archive, [
        selector("./dir//file.txt"),
        selector("dir/file.txt"),
      ]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 409 });
  });

  it("reports required and optional misses while deriving ok only from required selectors", async () => {
    const requiredMissing = await render(fakeArchive([]), [
      selector("required.txt", 1, true),
      selector("optional.txt", 1, false),
    ]);
    expect(requiredMissing.manifest).toMatchObject({
      ok: false,
      requested: 2,
      emitted: 0,
      missing: ["required.txt", "optional.txt"],
      selectors: [
        {
          path: "required.txt",
          occurrence: 1,
          required: true,
          status: "missing",
        },
        {
          path: "optional.txt",
          occurrence: 1,
          required: false,
          status: "missing",
        },
      ],
      archive: {
        fullyScanned: true,
        stoppedEarly: false,
        integrityScope: "full-archive",
      },
    });

    const optionalMissing = await render(fakeArchive([{ path: "required.txt", body: "ok" }]), [
      selector("optional.txt", 1, false),
      selector("required.txt", 1, true),
    ]);
    expect(optionalMissing.manifest).toMatchObject({
      ok: true,
      requested: 2,
      emitted: 1,
      missing: ["optional.txt"],
      selectors: [
        expect.objectContaining({ path: "optional.txt", status: "missing" }),
        expect.objectContaining({ path: "required.txt", status: "emitted", archiveIndex: 1 }),
      ],
      archive: {
        fullyScanned: true,
        stoppedEarly: false,
        integrityScope: "full-archive",
      },
    });
  });

  it("RFC5987-encodes UTF-8, quote, and path separators in part headers", async () => {
    const path = '자료/한 "파일".txt';
    const output = await render(fakeArchive([{ path, body: "content" }]), [
      selector(path, 1, true, '선택 "1"'),
    ]);
    expect(output.text).toContain("filename*=UTF-8''%ED%95%9C%20%22%ED%8C%8C%EC%9D%BC%22.txt");
    expect(output.text).toContain(
      "X-Archive-Path: %EC%9E%90%EB%A3%8C%2F%ED%95%9C%20%22%ED%8C%8C%EC%9D%BC%22.txt",
    );
    expect(output.text).toContain(
      "X-Stream-Gateway-Selector-Id: %EC%84%A0%ED%83%9D%20%221%22",
    );
    expect(output.manifest.selectors[0]).toMatchObject({
      id: '선택 "1"',
      path,
      occurrence: 1,
      required: true,
      status: "emitted",
      archiveIndex: 1,
    });
  });

  it("applies common transforms independently to every selected entry", async () => {
    const output = await render(
      fakeArchive([
        { path: "one.txt", chunks: ["old\r", "\nline"] },
        { path: "two.txt", chunks: ["old\r", "tail"] },
      ]),
      [selector("one.txt"), selector("two.txt")],
      [
        { type: "newline", mode: "lf", ensureFinalNewline: true },
        { type: "replace", search: "old", replacement: "new" },
      ],
    );

    expect(output.text).toContain("new\nline\n\r\n--");
    expect(output.text).toContain("new\ntail\n\r\n--");
    expect(output.manifest.emitted).toBe(2);
  });

  it("records corruption after a completed part and still emits a final manifest", async () => {
    const output = await render(
      fakeArchive(
        [
          { path: "first.txt", body: "first-body" },
          { path: "second.txt", body: "second-body" },
        ],
        1,
      ),
      [selector("first.txt"), selector("second.txt")],
    );

    expect(output.text).toContain("first-body");
    expect(output.text).not.toContain("second-body");
    expect(output.manifest).toMatchObject({
      ok: false,
      requested: 2,
      emitted: 1,
      missing: [],
      selectors: [
        expect.objectContaining({
          path: "first.txt",
          status: "emitted",
          archiveIndex: 1,
        }),
        expect.objectContaining({ path: "second.txt", status: "unresolved" }),
      ],
      archive: {
        fullyScanned: false,
        stoppedEarly: false,
        integrityScope: "partial-archive",
      },
    });
    expect(output.manifest.errors).toContainEqual({
      code: "CORRUPT_ARCHIVE",
      stage: "archive-read",
    });
  });

  it("reports selected-entry integrity when it stops before validating the archive tail", async () => {
    const output = await render(
      fakeArchive(
        [
          { path: "selected.txt", body: "selected" },
          { path: "tail.txt", body: "tail" },
        ],
        1,
      ),
      [selector("selected.txt")],
    );

    expect(output.manifest).toMatchObject({
      ok: true,
      missing: [],
      errors: [],
      archive: {
        fullyScanned: false,
        stoppedEarly: true,
        integrityScope: "selected-entries",
      },
    });
  });

  it("drains a transform-shortened entry before opening the next and keeps active entry at one", async () => {
    const source = fakeArchive([
      { path: "first.txt", chunks: ["a", "discard-1", "discard-2"] },
      { path: "second.txt", chunks: ["b", "discard-3"] },
    ]);
    const result = await createMultipartMixedStream(
      source.archive,
      [selector("first.txt"), selector("second.txt")],
      [{ type: "slice", start: 0, length: 1 }],
    );
    expect(source.bodyPulls()).toBe(0);

    const text = await new Response(result.byteStream.stream).text();
    expect(text).toContain("\r\n\r\na\r\n--");
    expect(text).toContain("\r\n\r\nb\r\n--");
    expect(source.maxActive()).toBe(1);
    expect(source.bodyPulls()).toBe(7);
  });

  it("returns a manifest-only multipart stream when nothing is requested", async () => {
    const output = await render(fakeArchive([]), []);
    expect(output.manifest).toEqual({
      ok: true,
      requested: 0,
      emitted: 0,
      missing: [],
      errors: [],
      selectors: [],
      archive: {
        fullyScanned: false,
        stoppedEarly: true,
        integrityScope: "selected-entries",
      },
    });
    expect(output.text.match(/Content-Type: application\/json/g)).toHaveLength(1);
  });

  it("applies final gzip after multipart encoding", async () => {
    const source = fakeArchive([{ path: "compressed.txt", body: "payload" }]);
    const result = await createMultipartMixedStream(
      source.archive,
      [selector("compressed.txt")],
      [],
      [{ type: "gzip" }],
    );

    expect(result.byteStream.contentType).toBe("application/gzip");
    const decoded = result.byteStream.stream.pipeThrough(
      new DecompressionStream("gzip") as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    );
    const text = await new Response(decoded).text();
    expect(text).toContain("payload");
    expect(text).toContain("X-Stream-Gateway-Control: manifest");
  });

  it("rejects a final byte limit because it could truncate the manifest", async () => {
    const source = fakeArchive([{ path: "limited.txt", body: "payload" }]);

    await expect(
      createMultipartMixedStream(
        source.archive,
        [selector("limited.txt")],
        [],
        [{ type: "limit", maxBytes: 1 }],
      ),
    ).rejects.toMatchObject({
      code: "INVALID_TRANSFORM",
      stage: "transform-validate",
    });
    expect(source.abort).not.toHaveBeenCalled();
  });

  it("does not enqueue a pending iterator result after consumer cancellation", async () => {
    const source = pendingIteratorArchive();
    const result = await createMultipartMixedStream(source.archive, [
      selector("available.txt"),
      selector("missing.txt"),
    ]);
    const reader = result.byteStream.stream.getReader();

    const header = await reader.read();
    expect(new TextDecoder().decode(header.value)).toContain("X-Archive-Path: available.txt");
    await reader.read();
    await reader.read();
    const pendingRead = reader.read();
    await source.nextPendingStarted;
    await reader.cancel("client disconnected while iterator.next was pending");

    await expect(pendingRead).resolves.toEqual({ done: true, value: undefined });
    await source.iteratorReturned;
    expect(source.abort).toHaveBeenCalled();
  });

  it("errors a pending read once and cleans up the iterator on signal abort", async () => {
    const source = pendingIteratorArchive();
    const controller = new AbortController();
    const result = await createMultipartMixedStream(
      source.archive,
      [selector("available.txt"), selector("missing.txt")],
      [],
      [],
      controller.signal,
    );
    const reader = result.byteStream.stream.getReader();

    await reader.read();
    await reader.read();
    await reader.read();
    const pendingRead = reader.read();
    await source.nextPendingStarted;
    controller.abort("request aborted");

    await expect(pendingRead).rejects.toMatchObject({
      code: "PIPELINE_ABORTED",
      stage: "multipart-mixed",
    });
    await source.iteratorReturned;
    expect(source.abort).toHaveBeenCalled();
  });

  it("aborts the archive when the multipart consumer disconnects", async () => {
    const source = fakeArchive([{ path: "large.txt", chunks: ["one", "two", "three"] }]);
    const result = await createMultipartMixedStream(source.archive, [selector("large.txt")]);
    const reader = result.byteStream.stream.getReader();
    await reader.read();
    await reader.cancel("client disconnected");

    expect(source.abort).toHaveBeenCalled();
  });
});
