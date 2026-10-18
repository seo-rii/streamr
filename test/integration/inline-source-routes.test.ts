import { env, exports } from "cloudflare:workers";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../src/constants";
import { createGatewayOperations, routeRequest } from "../../src/routes";
import { streamRequestSchema } from "../../src/schemas";

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

const target = { url: "https://target.test/upload", method: "PUT" };

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function inlineZip(entries: Record<string, string>) {
  const bytes = zipSync(Object.fromEntries(
    Object.entries(entries).map(([path, text]) => [path, strToU8(text)]),
  ), { level: 0 });
  return {
    byteLength: bytes.byteLength,
    source: {
      type: "inline" as const,
      encoding: "base64" as const,
      data: base64(bytes),
      filename: "archive.zip",
    },
  };
}

describe("inline source HTTP pipelines", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams Unicode text and preserves inline source metadata", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const data = "안녕🙂\0tail";
    const response = await exports.default.fetch(authenticatedJson("/v1/stream", {
      source: { type: "inline", encoding: "utf8", data, filename: "notes.txt" },
      output: { mode: "raw" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Content-Length")).toBe(String(new TextEncoder().encode(data).byteLength));
    expect(response.headers.get("Content-Disposition")).toContain("notes.txt");
    await expect(response.text()).resolves.toBe(data);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams every Base64-decoded binary byte", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const response = await exports.default.fetch(authenticatedJson("/v1/stream", {
      source: { type: "inline", encoding: "base64", data: base64(bytes) },
      output: { mode: "raw" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Length")).toBe("256");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies existing text transforms and output overrides to inline streams", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(authenticatedJson("/v1/stream", {
      source: { type: "inline", encoding: "utf8", data: "old\r\nold\r", filename: "source.txt" },
      entryTransforms: [
        { type: "newline", mode: "lf", ensureFinalNewline: true },
        { type: "replace", search: "old", replacement: "new" },
      ],
      output: { mode: "raw", contentType: "text/custom", filename: "result.txt" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/custom");
    expect(response.headers.get("Content-Disposition")).toContain("result.txt");
    await expect(response.text()).resolves.toBe("new\nnew\n");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes inline bytes without reporting HTTP response metadata", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const data = "hello🙂";
    const response = await exports.default.fetch(authenticatedJson("/v1/probe", {
      source: { type: "inline", encoding: "utf8", data },
    }));

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      ok: true,
      contentType: "text/plain; charset=utf-8",
      contentLength: new TextEncoder().encode(data).byteLength,
      detected: { kind: "file", format: "raw", layers: [] },
    });
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("finalUrl");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("detects an inline ZIP by magic despite misleading metadata", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const fixture = inlineZip({ "inside.txt": "zip" });
    const response = await exports.default.fetch(authenticatedJson("/v1/probe", {
      source: { ...fixture.source, filename: "notes.txt", contentType: "text/plain" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      contentLength: fixture.byteLength,
      detected: { kind: "archive", format: "zip", layers: ["zip"] },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists files from an inline Base64 archive", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const fixture = inlineZip({ "a.txt": "body-a", "b.txt": "body-b" });
    const response = await exports.default.fetch(authenticatedJson("/v1/list", {
      source: fixture.source,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      format: "zip",
      layers: ["zip"],
      sourceGets: 0,
      truncated: false,
      entries: [
        { path: "a.txt", type: "file", occurrence: 1, size: 6 },
        { path: "b.txt", type: "file", occurrence: 1, size: 6 },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("transfers one selected file from an inline archive", async () => {
    const fixture = inlineZip({ "a.txt": "not-selected", "b.txt": "selected" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(target.url);
      await expect(new Response(init?.body).text()).resolves.toBe("selected");
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: fixture.source,
      archive: { entries: [{ path: "b.txt" }] },
      target: { ...target, requireContentLength: true },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, sourceGets: 0, bytesRead: fixture.byteLength, bytesWritten: 8, targetStatus: 201,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streams selected inline archive files as multipart/mixed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const fixture = inlineZip({ "a.txt": "body-a", "b.txt": "body-b" });
    const response = await exports.default.fetch(authenticatedJson("/v1/stream", {
      source: fixture.source,
      archive: { entries: [{ path: "b.txt" }, { path: "a.txt" }] },
      output: { mode: "multipart-mixed" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^multipart\/mixed; boundary=sgw_/);
    const body = await response.text();
    expect(body).toContain("\r\n\r\nbody-a\r\n");
    expect(body).toContain("\r\n\r\nbody-b\r\n");
    expect(body).toContain("X-Stream-Gateway-Control: manifest");
    expect(body.indexOf("X-Archive-Path: a.txt")).toBeLessThan(body.indexOf("X-Archive-Path: b.txt"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("distributes inline archive files to their existing target routes", async () => {
    const fixture = inlineZip({ "a.txt": "A", "b.txt": "B", "tail.txt": "tail" });
    const uploads: { url: string; body: string }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      uploads.push({ url: String(input), body: await new Response(init?.body).text() });
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(authenticatedJson("/v1/distribute", {
      source: fixture.source,
      routes: [
        { path: "b.txt", target: { ...target, url: "https://target.test/b" } },
        { path: "a.txt", target: { ...target, url: "https://target.test/a" } },
      ],
    }));

    expect(response.status).toBe(200);
    expect(uploads).toEqual([
      { url: "https://target.test/a", body: "A" },
      { url: "https://target.test/b", body: "B" },
    ]);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, sourceGets: 0, archiveFormat: "zip",
      results: [
        { path: "a.txt", status: "uploaded", targetStatus: 201 },
        { path: "b.txt", status: "uploaded", targetStatus: 201 },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("creates and executes a signed URL for a small inline pipeline", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const operations = createGatewayOperations(env, "https://streamr.test");
    const signed = await operations.createStreamUrl(streamRequestSchema.parse({
      source: { type: "inline", encoding: "utf8", data: "signed\r\ninline" },
      entryTransforms: [{ type: "newline", mode: "lf", ensureFinalNewline: true }],
      output: { mode: "raw" },
    }), new AbortController().signal) as { ok: boolean; url: string };

    expect(signed.ok).toBe(true);
    const response = await exports.default.fetch(new Request(signed.url));
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("signed\ninline\n");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the signed URL payload limit smaller than the inline source limit", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const operations = createGatewayOperations(env, "https://streamr.test");

    await expect(operations.createStreamUrl(streamRequestSchema.parse({
      source: { type: "inline", encoding: "utf8", data: "x".repeat(LIMITS.signedPayloadBytes) },
      output: { mode: "raw" },
    }), new AbortController().signal)).rejects.toMatchObject({ code: "SIGNED_URL_PAYLOAD_TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("continues to fetch explicitly typed HTTP sources", async () => {
    const fetchMock = vi.fn(async () => new Response("legacy", { headers: { "Content-Type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await exports.default.fetch(authenticatedJson("/v1/stream", {
      source: { type: "http", url: "https://source.test/file" },
      output: { mode: "raw" },
    }));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("legacy");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://source.test/file", expect.any(Object));
  });

  it.each([
    { token: undefined, code: "AUTH_REQUIRED" },
    { token: "not-the-configured-token", code: "AUTH_INVALID" },
  ])("requires bearer authentication before target fetch ($code)", async ({ token, code }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const headers = new Headers({ "Content-Type": "application/json" });
    if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);

    const response = await exports.default.fetch(new Request("https://streamr.test/v1/transfer", {
      method: "POST",
      headers,
      body: JSON.stringify({ source: { type: "inline", encoding: "utf8", data: "hello" }, target }),
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads Unicode and NUL directly without a source GET", async () => {
    const data = "안녕🙂\0tail\r\n";
    const bytes = new TextEncoder().encode(data);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(target.url);
      expect(init?.method).toBe("PUT");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(bytes);
      return Response.json({ stored: true }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data },
      target: { ...target, requireContentLength: true },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sourceGets: 0,
      bytesRead: bytes.byteLength,
      bytesWritten: bytes.byteLength,
      targetStatus: 201,
      targetResponse: {
        contentType: "application/json",
        body: '{"stored":true}',
        truncated: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves every binary byte when decoding Base64 for a PATCH", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(target.url);
      expect(init?.method).toBe("PATCH");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/octet-stream");
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(bytes);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "base64", data: btoa(String.fromCharCode(...bytes)) },
      target: { ...target, method: "PATCH", requireContentLength: true },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, sourceGets: 0, bytesRead: 256, bytesWritten: 256, targetStatus: 204,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["utf8", "base64"])("uploads a known-length empty %s payload", async (encoding) => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((await new Response(init?.body).arrayBuffer()).byteLength).toBe(0);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding, data: "" },
      target: { ...target, requireContentLength: true },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, sourceGets: 0, bytesRead: 0, bytesWritten: 0, targetStatus: 204,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("counts original bytes separately from transformed upload bytes", async () => {
    const original = "one\r\ntwo\r\nthree";
    const transformed = "one\ntwo\nthree\n";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await expect(new Response(init?.body).text()).resolves.toBe(transformed);
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data: original },
      entryTransforms: [{ type: "newline", mode: "lf", ensureFinalNewline: true }],
      target,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sourceGets: 0,
      bytesRead: new TextEncoder().encode(original).byteLength,
      bytesWritten: new TextEncoder().encode(transformed).byteLength,
    });
  });

  it("wraps transformed inline text in multipart/form-data", async () => {
    let uploadedBytes = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const contentType = headers.get("Content-Type") ?? "";
      expect(contentType).toMatch(/^multipart\/form-data; boundary=sgw_form_/);
      const body = await new Response(init?.body).arrayBuffer();
      uploadedBytes = body.byteLength;
      const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
      expect(form.get("problemId")).toBe("1234");
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      if (!(file instanceof File)) throw new Error("expected multipart file");
      expect(file.name).toBe("answer.txt");
      expect(file.type).toBe("text/plain");
      await expect(file.text()).resolves.toBe("one\ntwo\n");
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const original = "one\r\ntwo";
    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data: original, filename: "source.txt" },
      entryTransforms: [
        { type: "newline", mode: "lf", ensureFinalNewline: true },
        {
          type: "multipart-form-data",
          fieldName: "file",
          filename: "answer.txt",
          contentType: "text/plain",
          fields: { problemId: "1234" },
        },
      ],
      target: { ...target, method: "POST" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, sourceGets: 0, bytesRead: original.length, bytesWritten: uploadedBytes,
    });
    expect(uploadedBytes).toBeGreaterThan(original.length);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit target content type and preserves target authentication headers", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Content-Type")).toBe("application/x-upload");
      expect(headers.get("Authorization")).toBe("Bearer target-token");
      await expect(new Response(init?.body).text()).resolves.toBe("hello");
      return new Response(null, { status: 201 });
    }));

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data: "hello", contentType: "text/csv" },
      target: {
        ...target,
        contentType: "application/x-upload",
        headers: { Authorization: "Bearer target-token", "Content-Type": "application/ignored" },
      },
    }));

    expect(response.status).toBe(200);
    await response.json();
  });

  it("rejects requireContentLength when a transform makes the length unknown", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data: "hello" },
      entryTransforms: [{ type: "gzip" }],
      target: { ...target, requireContentLength: true },
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false, error: { code: "CONTENT_LENGTH_UNKNOWN" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing encoding", source: { type: "inline", data: "hello" } },
    { label: "malformed Base64", source: { type: "inline", encoding: "base64", data: "%%%=" } },
    { label: "unpaired Unicode", source: { type: "inline", encoding: "utf8", data: "\ud800" } },
    { label: "content type injection", source: { type: "inline", encoding: "utf8", data: "ok", contentType: "text/plain\r\nX: yes" } },
    { label: "NUL content type", source: { type: "inline", encoding: "utf8", data: "ok", contentType: "text/plain\0" } },
    { label: "filename injection", source: { type: "inline", encoding: "utf8", data: "ok", filename: "a\nb.txt" } },
  ])("rejects $label before target fetch", async ({ source }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", { source, target }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false, error: { code: "INVALID_REQUEST" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects decoded inline content over 4 MiB before target fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "base64", data: btoa("x".repeat(LIMITS.inlineSourceBytes + 1)) },
      target,
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      ok: false, error: { code: "INVALID_REQUEST" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds and cancels an oversized JSON request body", async () => {
    const fetchMock = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
      },
      cancel,
    }, { highWaterMark: 0 });
    const response = await exports.default.fetch(new Request("https://streamr.test/v1/transfer", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.MCP_API_TOKEN}`, "Content-Type": "application/json" },
      body,
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      ok: false, error: { code: "INVALID_REQUEST", stage: "request-parse" },
    });
    expect(chunks).toBe(LIMITS.controlRequestBytes / (1024 * 1024) + 1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { target: { ...target, url: "file:///tmp/upload" }, code: "UNSUPPORTED_SCHEME" },
    { target: { ...target, headers: { "Content-Length": "4" } }, code: "INVALID_HEADER" },
  ])("validates the target before upload ($code)", async ({ target: invalidTarget, code }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data: "hello" }, target: invalidTarget,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates transform ordering before target fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data: "hello" },
      entryTransforms: [{ type: "gzip" }, { type: "newline", mode: "lf" }],
      target,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false, error: { code: "INVALID_TRANSFORM", stage: "transform-validate" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("captures only the configured target response bytes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Response(init?.body).arrayBuffer();
      return new Response("stored successfully", { status: 201, headers: { "Content-Type": "text/plain" } });
    }));

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data: "hello" },
      target: { ...target, responseBodyLimit: 6 },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true, targetResponse: { contentType: "text/plain", body: "stored", truncated: true },
    });
  });

  it("reports target rejection with a bounded response", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Response(init?.body).arrayBuffer();
      return new Response("rejected payload details", { status: 422, headers: { "Content-Type": "text/plain" } });
    }));

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data: "hello" },
      target: { ...target, responseBodyLimit: 8 },
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "TARGET_STATUS_REJECTED",
        details: { status: 422, targetResponse: { body: "rejected", truncated: true } },
      },
    });
  });

  it("does not follow target redirects", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Response(init?.body).arrayBuffer();
      return new Response(null, { status: 307, headers: { Location: "https://other.test/upload" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data: "hello" }, target,
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "TARGET_REDIRECT" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([5, 150_000])("returns a structured error when the target fetch fails (%i bytes)", async (byteLength) => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("connection refused")));
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data: "x".repeat(byteLength) }, target,
    }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false, error: { code: "TARGET_FETCH_FAILED", retryable: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts an inline transfer while the target is reading its request", async () => {
    const byteLength = 1024 * 1024;
    const parent = new AbortController();
    let markReading: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => { markReading = resolve; });
    let targetSignal: AbortSignal | undefined;
    let firstChunkBytes = 0;
    let targetCancelled = false;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      const signal = init?.signal;
      if (!(body instanceof ReadableStream) || signal === null || signal === undefined) {
        throw new Error("missing cancellable target request");
      }
      targetSignal = signal;
      const reader = body.getReader();
      try {
        const first = await reader.read();
        firstChunkBytes = first.value?.byteLength ?? 0;
        const disconnected = new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        markReading?.();
        await disconnected;
        throw new Error("target should have been disconnected");
      } finally {
        await reader.cancel("request aborted").catch(() => undefined);
        reader.releaseLock();
        targetCancelled = true;
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request(authenticatedJson("/v1/transfer", {
      source: { type: "inline", encoding: "utf8", data: "x".repeat(byteLength) },
      target,
    }), { signal: parent.signal });
    // Invoke the router directly so the test controls the original request signal.
    const pendingResponse = routeRequest(request, env, {} as ExecutionContext);
    await reading;

    parent.abort(new DOMException("client disconnected", "AbortError"));
    const response = await pendingResponse;
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "TARGET_FETCH_FAILED" } });
    expect(firstChunkBytes).toBeGreaterThan(0);
    expect(firstChunkBytes).toBeLessThan(byteLength);
    expect(targetSignal?.aborted).toBe(true);
    expect(targetCancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
