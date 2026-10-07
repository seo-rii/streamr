import { env, exports } from "cloudflare:workers";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { imageDimensions, makePng } from "../fixtures/image-fixtures";

function request(path: string, body: unknown): Request {
  return new Request(`https://streamr.test${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MCP_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function sourceResponse(bytes: Uint8Array, contentType = "image/png"): Response {
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": contentType, "Content-Length": String(bytes.byteLength) },
  });
}

describe("image HTTP pipelines", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { type: "image", format: "avif" },
    { type: "image", format: "jpeg", quality: 0 },
    { type: "image", format: "webp", quality: 101 },
    { type: "image", format: "png", quality: 80 },
    { type: "image", format: "png", background: "#ffffff" },
    { type: "image", format: "jpeg", background: "white" },
    { type: "image", format: "png", resize: {} },
    { type: "image", format: "png", resize: { width: 0 } },
    { type: "image", format: "png", resize: { width: 4_097 } },
    { type: "image", format: "png", resize: { width: 4, fit: "cover" } },
    { type: "image", format: "png", resize: { width: 1_001, height: 1_000 } },
    { type: "image", format: "png", code: "return input" },
  ])("rejects invalid image options before source fetch: %j", async (transform) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(request("/v1/stream", {
      source: { url: "https://source.test/photo.png" },
      entryTransforms: [transform],
    }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("rejects image as a final-stream transform before source fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(request("/v1/stream", {
      source: { url: "https://source.test/archive.zip" },
      archive: { entries: [{ path: "a.png" }, { path: "b.png" }] },
      finalTransforms: [{ type: "image", format: "webp" }],
      output: { mode: "multipart-mixed" },
    }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await response.body?.cancel();
  });

  it.each([
    { entryTransforms: [{ type: "image", format: "png" }, { type: "image", format: "jpeg" }] },
    { entryTransforms: [{ type: "image", format: "png" }, { type: "newline", mode: "lf" }] },
    { entryTransforms: [{ type: "image", format: "png" }, { type: "slice", start: 0, length: 10 }] },
    { entryTransforms: [{ type: "gzip" }, { type: "image", format: "png" }] },
  ])("rejects invalid image operator placement before source fetch: %j", async ({ entryTransforms }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(request("/v1/stream", {
      source: { url: "https://source.test/photo.png" }, entryTransforms,
    }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await response.body?.cancel();
  });

  it("serves converted bytes with matching MIME, filename, and exact length", async () => {
    const fetchMock = vi.fn(async () => sourceResponse(makePng()));
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(request("/v1/stream", {
      source: { url: "https://source.test/photo.png" },
      entryTransforms: [{ type: "image", format: "jpeg", quality: 80, resize: { width: 8 } }],
    }));
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(imageDimensions(bytes)).toEqual({ format: "jpeg", width: 8, height: 4 });
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Content-Disposition")).toContain("photo.jpg");
    expect(response.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uploads a converted image to a target requiring Content-Length", async () => {
    let uploaded: Uint8Array | undefined;
    let contentType: string | null = null;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === "https://source.test/photo.png") return sourceResponse(makePng());
      contentType = new Headers(init?.headers).get("Content-Type");
      uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer());
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(request("/v1/transfer", {
      source: { url: "https://source.test/photo.png" },
      entryTransforms: [{ type: "image", format: "webp", quality: 70 }],
      target: { url: "https://target.test/upload", method: "PUT", requireContentLength: true },
    }));
    expect(response.status).toBe(200);
    expect(uploaded).toBeDefined();
    expect(imageDimensions(uploaded!)).toEqual({ format: "webp", width: 16, height: 8 });
    expect(contentType).toBe("image/webp");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sourceGets: 1,
      targetStatus: 201,
      bytesWritten: uploaded!.byteLength,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("converts archive entries in order and retains the multipart manifest", async () => {
    const archive = zipSync({ "a.png": makePng(), "b.png": makePng(8, 8) });
    const fetchMock = vi.fn(async () => sourceResponse(archive, "application/zip"));
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(request("/v1/stream", {
      source: { url: "https://source.test/photos.zip" },
      archive: { entries: [{ path: "b.png" }, { path: "a.png" }] },
      entryTransforms: [{ type: "image", format: "jpeg" }],
      output: { mode: "multipart-mixed" },
    }));
    expect(response.status).toBe(200);
    // Inspect ASCII envelope headers/control JSON; JPEG parts remain binary.
    const body = new TextDecoder().decode(await response.arrayBuffer());
    expect(body.match(/Content-Type: image\/jpeg/g)).toHaveLength(2);
    expect(body).toContain("filename*=UTF-8''a.jpg");
    expect(body).toContain("filename*=UTF-8''b.jpg");
    expect(body.indexOf("X-Archive-Path: a.png")).toBeLessThan(body.indexOf("X-Archive-Path: b.png"));
    const manifest = body.split("X-Stream-Gateway-Control: manifest\r\n\r\n")[1]?.split("\r\n--")[0];
    expect(JSON.parse(manifest ?? "null")).toMatchObject({ ok: true, requested: 2, emitted: 2, errors: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses different per-route image transforms with one source GET and sequential uploads", async () => {
    const archive = zipSync({ "a.png": makePng(), "b.png": makePng(8, 8) });
    const uploads: { url: string; method: string; contentType: string | null; dimensions: ReturnType<typeof imageDimensions> }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://source.test/photos.zip") return sourceResponse(archive, "application/zip");
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      uploads.push({
        url,
        method: init?.method ?? "GET",
        contentType: new Headers(init?.headers).get("Content-Type"),
        dimensions: imageDimensions(bytes),
      });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(request("/v1/distribute", {
      source: { url: "https://source.test/photos.zip" },
      routes: [
        { path: "b.png", transforms: [{ type: "image", format: "webp", resize: { width: 3 } }], target: { url: "https://target.test/b", method: "PATCH" } },
        { path: "a.png", transforms: [{ type: "image", format: "jpeg", resize: { width: 2 } }], target: { url: "https://target.test/a", method: "POST" } },
      ],
    }));
    expect(response.status).toBe(200);
    expect(uploads).toEqual([
      { url: "https://target.test/a", method: "POST", contentType: "image/jpeg", dimensions: { format: "jpeg", width: 2, height: 1 } },
      { url: "https://target.test/b", method: "PATCH", contentType: "image/webp", dimensions: { format: "webp", width: 3, height: 3 } },
    ]);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sourceGets: 1,
      entriesScanned: 2,
      results: [{ path: "a.png", status: "uploaded" }, { path: "b.png", status: "uploaded" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("continues distribution after a corrupt image without uploading the failed entry", async () => {
    const archive = zipSync({ "bad.png": makePng().subarray(0, 20), "good.png": makePng() });
    const uploads: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://source.test/photos.zip") return sourceResponse(archive, "application/zip");
      uploads.push(url);
      expect(imageDimensions(new Uint8Array(await new Response(init?.body).arrayBuffer())).format).toBe("webp");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(request("/v1/distribute", {
      source: { url: "https://source.test/photos.zip" },
      routes: ["bad.png", "good.png"].map((path) => ({
        path,
        transforms: [{ type: "image", format: "webp" }],
        target: { url: `https://target.test/${path}`, method: "PUT" },
      })),
      failurePolicy: "continue",
    }));
    expect(response.status).toBe(200);
    expect(uploads).toEqual(["https://target.test/good.png"]);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      sourceGets: 1,
      results: [
        { path: "bad.png", status: "failed", error: { code: "IMAGE_INVALID" } },
        { path: "good.png", status: "uploaded" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
