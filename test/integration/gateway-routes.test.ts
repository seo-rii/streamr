import { env, exports } from "cloudflare:workers";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignedStreamUrl } from "../../src/util/signed-url";

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

function zipResponse(entries: Record<string, string>): Response {
  const archive = zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([path, body]) => [path, strToU8(body)]),
    ),
    { level: 0 },
  );
  return new Response(archive.buffer, {
    headers: {
      "Content-Length": String(archive.byteLength),
      "Content-Type": "application/zip",
    },
  });
}

describe("gateway HTTP route integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serves health without bearer authentication", async () => {
    const response = await exports.default.fetch(
      new Request("https://streamr.test/healthz"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "streamr",
      version: "0.2.0",
    });
  });

  it("rejects an invalid bearer token before starting a source request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(
      new Request("https://streamr.test/v1/stream", {
        method: "POST",
        headers: {
          Authorization: "Bearer not-the-configured-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: { url: "https://source.test/raw.txt" },
          output: { mode: "raw" },
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTH_INVALID", stage: "auth" },
    });
  });

  it("protects the stateless MCP endpoint with bearer authentication", async () => {
    const response = await exports.default.fetch(
      new Request("https://streamr.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTH_REQUIRED", stage: "auth" },
    });
  });

  it("streams a raw source through authenticated POST", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("raw-body", {
        headers: {
          "Content-Length": "8",
          "Content-Type": "application/octet-stream",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(
      authenticatedJson("/v1/stream", {
        source: { url: "https://source.test/raw.bin" },
        output: {
          mode: "raw",
          contentType: "text/plain; charset=utf-8",
          filename: "result.txt",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Content-Length")).toBe("8");
    expect(response.headers.get("Content-Disposition")).toContain("result.txt");
    await expect(response.text()).resolves.toBe("raw-body");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the source when setup fails after fetch", async () => {
    let sourceSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sourceSignal = init?.signal ?? undefined;
        return new Response("not-utf8-declared", {
          headers: { "Content-Type": "text/plain; charset=iso-8859-1" },
        });
      }),
    );

    const response = await exports.default.fetch(
      authenticatedJson("/v1/stream", {
        source: { url: "https://source.test/legacy.txt" },
        entryTransforms: [{ type: "newline", mode: "lf" }],
        output: { mode: "raw" },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_TRANSFORM", stage: "transform-validate" },
    });
    expect(sourceSignal?.aborted).toBe(true);
  });

  it("executes a valid signed GET and rejects a tampered signature before fetching", async () => {
    const pipeline = {
      source: { url: "https://source.test/public.txt" },
      output: { mode: "raw" as const },
    };
    const signed = await createSignedStreamUrl(
      "https://streamr.test",
      pipeline,
      env.URL_SIGNING_SECRET,
    );
    const fetchMock = vi.fn(async () => new Response("signed-body"));
    vi.stubGlobal("fetch", fetchMock);

    const validResponse = await exports.default.fetch(new Request(signed.url));
    expect(validResponse.status).toBe(200);
    await expect(validResponse.text()).resolves.toBe("signed-body");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const tampered = new URL(signed.url);
    const signature = tampered.searchParams.get("s");
    if (signature === null || signature.length === 0) throw new Error("missing signature");
    tampered.searchParams.set(
      "s",
      `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`,
    );

    const invalidResponse = await exports.default.fetch(new Request(tampered));
    expect(invalidResponse.status).toBe(403);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "SIGNATURE_INVALID", stage: "signed-url-verify" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("streams selected ZIP files as multipart/mixed in archive order with a manifest", async () => {
    const fetchMock = vi.fn(async () =>
      zipResponse({
        "data/a.txt": "body-a",
        "data/b.txt": "body-b",
        "data/c.txt": "not-selected",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(
      authenticatedJson("/v1/stream", {
        source: { url: "https://source.test/archive.zip" },
        archive: {
          entries: [{ path: "data/b.txt" }, { path: "data/a.txt" }],
        },
        output: { mode: "multipart-mixed" },
      }),
    );

    expect(response.status).toBe(200);
    const contentType = response.headers.get("Content-Type");
    expect(contentType).toMatch(/^multipart\/mixed; boundary=sgw_[a-f0-9]{32}$/);
    const boundary = contentType?.match(/boundary=(.+)$/)?.[1];
    if (boundary === undefined) throw new Error("missing multipart boundary");

    const body = new TextDecoder().decode(await response.arrayBuffer());
    expect(body.indexOf("X-Archive-Path: data%2Fa.txt")).toBeLessThan(
      body.indexOf("X-Archive-Path: data%2Fb.txt"),
    );
    expect(body).toContain("\r\n\r\nbody-a\r\n");
    expect(body).toContain("\r\n\r\nbody-b\r\n");
    expect(body).not.toContain("not-selected");
    expect(body).toContain("X-Stream-Gateway-Control: manifest");
    expect(body).toContain(
      JSON.stringify({
        ok: true,
        requested: 2,
        emitted: 2,
        missing: [],
        errors: [],
      }),
    );
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates distribution transforms before fetching the source", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(
      authenticatedJson("/v1/distribute", {
        source: { url: "https://source.test/archive.zip" },
        routes: [
          {
            path: "data/a.txt",
            transforms: [
              {
                type: "multipart-form-data",
                fieldName: "file",
                filename: "a.txt",
                contentType: "text/plain",
              },
              { type: "append", encoding: "utf8", data: "tail" },
            ],
            target: { url: "https://target.test/a", method: "PUT" },
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_TRANSFORM", stage: "transform-validate" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("distributes selected entries sequentially in archive order", async () => {
    const uploads: { url: string; method: string; body: string }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://source.test/archive.zip") {
        return zipResponse({ "a.txt": "A", "b.txt": "B", "tail.txt": "tail" });
      }

      uploads.push({
        url,
        method: init?.method ?? "GET",
        body: await new Response(init?.body).text(),
      });
      return new Response(null, { status: url.endsWith("/a") ? 201 : 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(
      authenticatedJson("/v1/distribute", {
        source: { url: "https://source.test/archive.zip" },
        routes: [
          {
            id: "route-b",
            path: "b.txt",
            target: { url: "https://target.test/b", method: "PATCH" },
          },
          {
            id: "route-a",
            path: "a.txt",
            target: { url: "https://target.test/a", method: "POST" },
          },
        ],
        failurePolicy: "abort",
      }),
    );

    expect(response.status).toBe(200);
    expect(uploads).toEqual([
      { url: "https://target.test/a", method: "POST", body: "A" },
      { url: "https://target.test/b", method: "PATCH", body: "B" },
    ]);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sourceGets: 1,
      archiveFormat: "zip",
      entriesScanned: 2,
      stoppedEarly: true,
      results: [
        { id: "route-a", path: "a.txt", status: "uploaded", targetStatus: 201 },
        { id: "route-b", path: "b.txt", status: "uploaded", targetStatus: 204 },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
