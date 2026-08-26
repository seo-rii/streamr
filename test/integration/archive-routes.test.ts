import { env, exports } from "cloudflare:workers";
import { gzipSync, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { packTar } from "modern-tar";
import { afterEach, describe, expect, it, vi } from "vitest";

const encoder = new TextEncoder();

function authenticatedJson(path: string, body: unknown): Request {
  return new Request(`https://streamr.test${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MCP_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function makeZip(
  entries: readonly {
    path: string;
    body?: string;
    compression?: "stored" | "deflate";
  }[],
): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let zipError: unknown;
  const zip = new Zip((error, data) => {
    if (error !== null) {
      zipError = error;
      return;
    }
    chunks.push(data);
  });

  for (const entry of entries) {
    const body = encoder.encode(entry.body ?? "");
    if (entry.compression === "deflate") {
      const file = new ZipDeflate(entry.path);
      zip.add(file);
      file.push(body, true);
    } else {
      const file = new ZipPassThrough(entry.path);
      zip.add(file);
      file.push(body, true);
    }
  }
  zip.end();
  if (zipError !== undefined) throw zipError;
  return concatenate(chunks);
}

function archiveResponse(bytes: Uint8Array, contentType: string): Response {
  const copy = new Uint8Array(bytes);
  return new Response(copy.buffer, {
    headers: {
      "Content-Length": String(copy.byteLength),
      "Content-Type": contentType,
    },
  });
}

describe("archive HTTP data plane", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("authenticates archive routes before fetching their source", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(
      new Request("https://streamr.test/v1/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: { url: "https://source.test/archive.zip" } }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTH_REQUIRED" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes ZIP magic without trusting the content type or extension", async () => {
    const archive = makeZip([{ path: "inside.txt", body: "zip" }]);
    const fetchMock = vi.fn(async () => archiveResponse(archive, "application/octet-stream"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(
      authenticatedJson("/v1/probe", {
        source: { url: "https://source.test/download.bin" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 200,
      finalUrl: "https://source.test/download.bin",
      detected: { kind: "archive", format: "zip", layers: ["zip"] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("probes through GZIP and identifies an inner TAR archive", async () => {
    const tar = await packTar([
      { header: { name: "inside.txt", size: 3 }, body: "tar" },
    ]);
    const archive = gzipSync(tar);
    const fetchMock = vi.fn(async () => archiveResponse(archive, "application/octet-stream"));
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(
      authenticatedJson("/v1/probe", {
        source: { url: "https://source.test/download.bin" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      detected: {
        kind: "archive",
        format: "tar.gz",
        layers: ["gzip", "tar"],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lists ZIP duplicate occurrences and unsafe-path metadata", async () => {
    const archive = makeZip([
      { path: "same.txt", body: "first" },
      { path: "same.txt", body: "second", compression: "deflate" },
      { path: "../unsafe.txt", body: "unsafe" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => archiveResponse(archive, "application/zip")),
    );

    const response = await exports.default.fetch(
      authenticatedJson("/v1/list", {
        source: { url: "https://source.test/archive.zip" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      format: "zip",
      layers: ["zip"],
      truncated: false,
      sourceGets: 1,
      entries: [
        { index: 1, path: "same.txt", occurrence: 1, unsafePath: false, type: "file" },
        { index: 2, path: "same.txt", occurrence: 2, unsafePath: false, type: "file" },
        {
          index: 3,
          path: "../unsafe.txt",
          occurrence: 1,
          unsafePath: true,
          type: "file",
        },
      ],
    });
  });

  it("lists TAR duplicate occurrences and unsafe-path metadata", async () => {
    const archive = await packTar([
      { header: { name: "same.txt", size: 5 }, body: "first" },
      { header: { name: "same.txt", size: 6 }, body: "second" },
      { header: { name: "../unsafe.txt", size: 6 }, body: "unsafe" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => archiveResponse(archive, "application/x-tar")),
    );

    const response = await exports.default.fetch(
      authenticatedJson("/v1/list", {
        source: { url: "https://source.test/archive.tar" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      format: "tar",
      layers: ["tar"],
      truncated: false,
      entries: [
        { index: 1, path: "same.txt", occurrence: 1, unsafePath: false, type: "file" },
        { index: 2, path: "same.txt", occurrence: 2, unsafePath: false, type: "file" },
        {
          index: 3,
          path: "../unsafe.txt",
          occurrence: 1,
          unsafePath: true,
          type: "file",
        },
      ],
    });
  });

  it("streams one selected ZIP entry and returns 404 when it is absent", async () => {
    const archive = makeZip([
      { path: "data/first.in", body: "first" },
      { path: "data/selected.in", body: "selected\n", compression: "deflate" },
    ]);
    const fetchMock = vi.fn(async () => archiveResponse(archive, "application/zip"));
    vi.stubGlobal("fetch", fetchMock);

    const selected = await exports.default.fetch(
      authenticatedJson("/v1/stream", {
        source: { url: "https://source.test/archive.zip" },
        archive: { entries: [{ path: "data/selected.in" }] },
        output: { mode: "raw" },
      }),
    );

    expect(selected.status).toBe(200);
    expect(selected.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(selected.headers.get("Content-Disposition")).toContain("selected.in");
    await expect(selected.text()).resolves.toBe("selected\n");

    const missing = await exports.default.fetch(
      authenticatedJson("/v1/stream", {
        source: { url: "https://source.test/archive.zip" },
        archive: { entries: [{ path: "data/missing.in" }] },
        output: { mode: "raw" },
      }),
    );

    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "ENTRY_NOT_FOUND",
        stage: "archive-select",
        details: { path: "data/missing.in", occurrence: 1 },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uploads one selected archive entry to the target", async () => {
    const archive = makeZip([
      { path: "data/skip.txt", body: "skip" },
      { path: "data/upload.txt", body: "upload-body", compression: "deflate" },
    ]);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url === "https://source.test/archive.zip") {
          return archiveResponse(archive, "application/zip");
        }
        if (url === "https://target.test/files/upload.txt") {
          expect(init?.method).toBe("PATCH");
          expect(init?.redirect).toBe("manual");
          expect(new Headers(init?.headers).get("Content-Type")).toBe("text/plain");
          await expect(new Response(init?.body).text()).resolves.toBe("upload-body");
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(
      authenticatedJson("/v1/transfer", {
        source: { url: "https://source.test/archive.zip" },
        archive: { entries: [{ path: "data/upload.txt" }] },
        target: {
          url: "https://target.test/files/upload.txt",
          method: "PATCH",
          contentType: "text/plain",
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sourceGets: 1,
      bytesWritten: 11,
      targetStatus: 204,
      targetResponse: { contentType: null, body: null, truncated: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
