import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArchiveEntryHandle, OpenedArchive } from "../../src/archive/types";
import { distributeArchive } from "../../src/outputs/distribute";
import type { DistributionRoute, HttpTargetSpec } from "../../src/schemas";
import type { ByteStream } from "../../src/streams/byte-stream";

const encoder = new TextEncoder();

interface FakeEntry {
  path: string;
  body: string;
  occurrence?: number;
  type?: ArchiveEntryHandle["type"];
}

interface FakeArchive {
  archive: OpenedArchive;
  abort: ReturnType<typeof vi.fn>;
  bodyAborts: unknown[];
  skipped: string[];
  yielded: () => number;
  maxActiveEntries: () => number;
}

interface RecordedUpload {
  url: string;
  method: string;
  body: string;
}

function fakeArchive(entries: readonly FakeEntry[]): FakeArchive {
  const archiveAbort = vi.fn();
  const bodyAborts: unknown[] = [];
  const skipped: string[] = [];
  let yielded = 0;
  let activeEntries = 0;
  let maximumActiveEntries = 0;

  const stream = {
    async *[Symbol.asyncIterator](): AsyncGenerator<ArchiveEntryHandle> {
      for (let index = 0; index < entries.length; index += 1) {
        const spec = entries[index];
        if (spec === undefined) throw new Error("missing fake entry");
        yielded += 1;
        let state: "discovered" | "opened" | "skipped" = "discovered";
        let resolveCompletion: () => void = () => undefined;
        const completion = new Promise<void>((resolve) => {
          resolveCompletion = resolve;
        });
        let finished = false;

        const finish = () => {
          if (finished) return;
          finished = true;
          if (state === "opened") activeEntries -= 1;
          resolveCompletion();
        };

        const handle: ArchiveEntryHandle = {
          index: index + 1,
          path: spec.path,
          occurrence: spec.occurrence ?? 1,
          unsafePath: false,
          type: spec.type ?? "file",
          contentType: "text/plain; charset=utf-8",
          async open(): Promise<ByteStream> {
            if (state !== "discovered") throw new Error("fake entry already consumed");
            state = "opened";
            activeEntries += 1;
            maximumActiveEntries = Math.max(maximumActiveEntries, activeEntries);
            const bytes = encoder.encode(spec.body);
            let offset = 0;
            return {
              stream: new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    if (offset >= bytes.byteLength) {
                      finish();
                      controller.close();
                      return;
                    }
                    const end = Math.min(offset + 2, bytes.byteLength);
                    controller.enqueue(bytes.subarray(offset, end));
                    offset = end;
                  },
                },
                { highWaterMark: 0 },
              ),
              contentType: "text/plain; charset=utf-8",
              filename: spec.path.split("/").at(-1) ?? "entry",
              abort(reason?: unknown) {
                bodyAborts.push(reason);
              },
            };
          },
          async skip() {
            if (state !== "discovered") throw new Error("fake entry already consumed");
            state = "skipped";
            skipped.push(spec.path);
            finish();
          },
        };

        yield handle;
        if (state === "discovered") throw new Error("fake entry was not consumed");
        await completion;
      }
    },
  };

  return {
    archive: {
      format: "zip",
      layers: ["zip"],
      entries: stream,
      abort: archiveAbort,
    },
    abort: archiveAbort,
    bodyAborts,
    skipped,
    yielded: () => yielded,
    maxActiveEntries: () => maximumActiveEntries,
  };
}

function target(
  path: string,
  method: HttpTargetSpec["method"] = "PUT",
  responseBodyLimit = 65_536,
): HttpTargetSpec {
  return {
    url: `https://target.test/${path}`,
    method,
    successStatus: [200, 201, 204],
    responseBodyLimit,
    requireContentLength: false,
    timeoutMs: 300_000,
  };
}

function route(
  path: string,
  options: {
    id?: string;
    occurrence?: number;
    required?: boolean;
    method?: HttpTargetSpec["method"];
    transforms?: DistributionRoute["transforms"];
    responseBodyLimit?: number;
  } = {},
): DistributionRoute {
  return {
    ...(options.id === undefined ? {} : { id: options.id }),
    path,
    occurrence: options.occurrence ?? 1,
    required: options.required ?? true,
    transforms: options.transforms ?? [],
    target: target(
      options.id ?? path,
      options.method,
      options.responseBodyLimit,
    ),
  };
}

async function requestBodyText(body: BodyInit | null | undefined): Promise<string> {
  if (body === null || body === undefined) return "";
  return new Response(body).text();
}

function stubTargetFetch(
  responseFor: (upload: RecordedUpload) => Response = () => new Response("ok", { status: 201 }),
): {
  uploads: RecordedUpload[];
  maxActiveUploads: () => number;
} {
  const uploads: RecordedUpload[] = [];
  let activeUploads = 0;
  let maximumActiveUploads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      activeUploads += 1;
      maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
      try {
        const upload = {
          url: String(input),
          method: init?.method ?? "GET",
          body: await requestBodyText(init?.body),
        };
        uploads.push(upload);
        await Promise.resolve();
        return responseFor(upload);
      } finally {
        activeUploads -= 1;
      }
    }),
  );
  return { uploads, maxActiveUploads: () => maximumActiveUploads };
}

afterEach(() => vi.unstubAllGlobals());

describe("archive distribution", () => {
  it("uploads in archive order with one active entry and target, then stops early", async () => {
    const fixture = fakeArchive([
      { path: "a.txt", body: "A" },
      { path: "b.txt", body: "B" },
      { path: "c.txt", body: "C" },
      { path: "not-read.txt", body: "tail" },
    ]);
    const targetFetch = stubTargetFetch();

    const result = await distributeArchive(
      fixture.archive,
      [
        route("c.txt", { id: "c", method: "POST" }),
        route("./a.txt", { id: "a", method: "PUT" }),
        route("b.txt", { id: "b", method: "PATCH" }),
      ],
      "abort",
      undefined,
      1,
    );

    expect(targetFetch.uploads).toEqual([
      { url: "https://target.test/a", method: "PUT", body: "A" },
      { url: "https://target.test/b", method: "PATCH", body: "B" },
      { url: "https://target.test/c", method: "POST", body: "C" },
    ]);
    expect(result.results.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "a.txt", status: "uploaded" },
      { path: "b.txt", status: "uploaded" },
      { path: "c.txt", status: "uploaded" },
    ]);
    expect(result).toMatchObject({
      ok: true,
      archiveFormat: "zip",
      entriesScanned: 3,
      stoppedEarly: true,
      archiveFullyScanned: false,
      integrityScope: "selected-entries",
      sourceGets: 1,
    });
    expect(fixture.yielded()).toBe(3);
    expect(fixture.maxActiveEntries()).toBe(1);
    expect(targetFetch.maxActiveUploads()).toBe(1);
    expect(fixture.abort).toHaveBeenCalledWith("all distribution routes completed");
  });

  it("keeps earlier successes and does not run later routes under abort policy", async () => {
    const fixture = fakeArchive([
      { path: "a.txt", body: "A" },
      { path: "b.txt", body: "B" },
      { path: "c.txt", body: "C" },
    ]);
    const targetFetch = stubTargetFetch((upload) =>
      upload.url.endsWith("/b")
        ? new Response("rejected", { status: 500 })
        : new Response(null, { status: 201 }),
    );

    const result = await distributeArchive(
      fixture.archive,
      [route("a.txt", { id: "a" }), route("b.txt", { id: "b" }), route("c.txt", { id: "c" })],
      "abort",
    );

    expect(targetFetch.uploads.map(({ url }) => url)).toEqual([
      "https://target.test/a",
      "https://target.test/b",
    ]);
    expect(result.results.map(({ status }) => status)).toEqual([
      "uploaded",
      "failed",
      "not-run",
    ]);
    expect(result.results[1]).toMatchObject({
      status: "failed",
      error: {
        code: "TARGET_STATUS_REJECTED",
        details: { status: 500 },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      entriesScanned: 2,
      stoppedEarly: true,
      archiveFullyScanned: false,
      integrityScope: "partial-archive",
    });
    expect(fixture.abort).toHaveBeenCalled();
  });

  it("drains a failed route and continues to later targets", async () => {
    const fixture = fakeArchive([
      { path: "a.txt", body: "A" },
      { path: "b.txt", body: "B" },
      { path: "c.txt", body: "C" },
    ]);
    const targetFetch = stubTargetFetch((upload) => {
      if (upload.url.endsWith("/a")) return new Response(null, { status: 201 });
      if (upload.url.endsWith("/b")) {
        return new Response("redirect", {
          status: 302,
          headers: { Location: "https://other.test/b" },
        });
      }
      return new Response(null, { status: 204 });
    });

    const result = await distributeArchive(
      fixture.archive,
      [route("a.txt", { id: "a" }), route("b.txt", { id: "b" }), route("c.txt", { id: "c" })],
      "continue",
    );

    expect(targetFetch.uploads.map(({ url }) => url)).toEqual([
      "https://target.test/a",
      "https://target.test/b",
      "https://target.test/c",
    ]);
    expect(result.results.map(({ status }) => status)).toEqual([
      "uploaded",
      "failed",
      "uploaded",
    ]);
    expect(result.results[1]).toMatchObject({
      status: "failed",
      error: { code: "TARGET_REDIRECT" },
    });
    expect(result.ok).toBe(false);
  });

  it("reports required and optional missing entries without confusing warnings", async () => {
    const fixture = fakeArchive([{ path: "present.txt", body: "present" }]);
    stubTargetFetch();

    const result = await distributeArchive(
      fixture.archive,
      [
        route("present.txt"),
        route("required.txt"),
        route("optional.txt", { required: false, id: "optional" }),
      ],
      "continue",
    );

    expect(result.results.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "present.txt", status: "uploaded" },
      { path: "required.txt", status: "missing" },
      { path: "optional.txt", status: "missing" },
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      id: "optional",
      path: "optional.txt",
      error: { code: "ENTRY_NOT_FOUND" },
    });
    expect(result).toMatchObject({
      ok: false,
      stoppedEarly: false,
      archiveFullyScanned: true,
      integrityScope: "full-archive",
    });
    expect(fixture.abort).not.toHaveBeenCalled();
  });

  it("matches the exact normalized path and requested occurrence", async () => {
    const fixture = fakeArchive([
      { path: "same.txt", occurrence: 1, body: "first" },
      { path: "same.txt", occurrence: 2, body: "second" },
    ]);
    const targetFetch = stubTargetFetch();

    const result = await distributeArchive(
      fixture.archive,
      [route("./same.txt", { occurrence: 2 })],
      "continue",
    );

    expect(fixture.skipped).toEqual(["same.txt"]);
    expect(targetFetch.uploads[0]?.body).toBe("second");
    expect(result.results[0]).toMatchObject({
      path: "same.txt",
      occurrence: 2,
      status: "uploaded",
    });
  });

  it("drains only the current entry when slice ends early", async () => {
    const fixture = fakeArchive([
      { path: "cut.txt", body: "abcdef" },
      { path: "next.txt", body: "next" },
    ]);
    const targetFetch = stubTargetFetch();

    const result = await distributeArchive(
      fixture.archive,
      [
        route("cut.txt", { transforms: [{ type: "slice", start: 0, length: 1 }] }),
        route("next.txt"),
      ],
      "continue",
    );

    expect(targetFetch.uploads.map(({ body }) => body)).toEqual(["a", "next"]);
    expect(result.results.map(({ status }) => status)).toEqual(["uploaded", "uploaded"]);
    expect(fixture.bodyAborts).toEqual([]);
  });

  it("continues after an output limit failure by discarding the entry remainder", async () => {
    const fixture = fakeArchive([
      { path: "limited.txt", body: "too long" },
      { path: "next.txt", body: "next" },
    ]);
    const targetFetch = stubTargetFetch();

    const result = await distributeArchive(
      fixture.archive,
      [
        route("limited.txt", { transforms: [{ type: "limit", maxBytes: 1 }] }),
        route("next.txt"),
      ],
      "continue",
    );

    expect(result.results.map(({ status }) => status)).toEqual(["failed", "uploaded"]);
    expect(targetFetch.uploads.at(-1)?.body).toBe("next");
    expect(fixture.bodyAborts).toEqual([]);
  });

  it("rejects same-entry fan-out before scanning or uploading", async () => {
    const fixture = fakeArchive([{ path: "same.txt", body: "body" }]);
    const targetFetch = stubTargetFetch();

    await expect(
      distributeArchive(
        fixture.archive,
        [route("same.txt", { id: "one" }), route("./same.txt", { id: "two" })],
        "continue",
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 409 });
    expect(fixture.yielded()).toBe(0);
    expect(targetFetch.uploads).toEqual([]);
  });

  it("propagates a caller abort before scanning the archive", async () => {
    const fixture = fakeArchive([{ path: "same.txt", body: "body" }]);
    const controller = new AbortController();
    controller.abort("client disconnected");

    await expect(
      distributeArchive(fixture.archive, [route("same.txt")], "continue", controller.signal),
    ).rejects.toMatchObject({ code: "PIPELINE_ABORTED" });
    expect(fixture.yielded()).toBe(0);
    expect(fixture.abort).toHaveBeenCalledWith("client disconnected");
  });

  it("bounds retained textual target responses across all routes", async () => {
    const mebibyte = 1024 * 1024;
    const fixture = fakeArchive([
      { path: "a.txt", body: "A" },
      { path: "b.txt", body: "B" },
      { path: "c.txt", body: "C" },
    ]);
    stubTargetFetch((upload) =>
      new Response("x".repeat(mebibyte), {
        status: upload.url.endsWith("/a.txt") ? 500 : 200,
      }),
    );

    const result = await distributeArchive(
      fixture.archive,
      [
        route("a.txt", { responseBodyLimit: mebibyte }),
        route("b.txt", { responseBodyLimit: mebibyte }),
        route("c.txt", { responseBodyLimit: mebibyte }),
      ],
      "continue",
    );

    const captured = result.results.reduce((total, item) => {
      const body =
        item.status === "uploaded"
          ? item.targetResponse.body
          : item.status === "failed"
            ? (item.error.details?.targetResponse as { body?: unknown } | undefined)?.body
            : null;
      return total + (typeof body === "string" ? encoder.encode(body).byteLength : 0);
    }, 0);
    expect(captured).toBe(2 * mebibyte);
    expect(result.results[2]).toMatchObject({
      status: "uploaded",
      targetResponse: { body: "", truncated: true },
    });
  });
});
