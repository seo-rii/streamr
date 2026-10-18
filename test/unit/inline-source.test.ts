import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../src/constants";
import { inlineSourceSchema, sourceSchema, transferRequestSchema } from "../../src/schemas";
import { detectFormat } from "../../src/archive/detect";
import { openSource, sourceDetectionHints } from "../../src/source/open";
import { createInlineByteStream } from "../../src/source/inline";

describe("inline source", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("requires the inline discriminant and encoding, and keeps HTTP sources compatible", () => {
    expect(inlineSourceSchema.safeParse({ type: "inline", data: "hello" }).success).toBe(false);
    expect(inlineSourceSchema.safeParse({ type: "inline", encoding: "hex", data: "00" }).success).toBe(false);
    expect(inlineSourceSchema.safeParse({ type: "inline", encoding: "utf8", data: "", extra: true }).success).toBe(false);
    expect(sourceSchema.safeParse({ encoding: "utf8", data: "hello" }).success).toBe(false);
    expect(sourceSchema.safeParse({ type: "inline", encoding: "utf8", data: "", url: "https://source.test/file" }).success).toBe(false);
    expect(sourceSchema.safeParse({ url: "https://source.test/file" }).success).toBe(true);
    expect(sourceSchema.safeParse({ type: "http", url: "https://source.test/file" }).success).toBe(true);

    const request = transferRequestSchema.parse({
      source: { type: "inline", encoding: "utf8", data: "" },
      target: { url: "https://target.test/upload", method: "PUT" },
    });
    expect(request.entryTransforms).toEqual([]);
    expect(request.target.requireContentLength).toBe(false);
    expect(transferRequestSchema.safeParse({
      ...request,
      content: { encoding: "utf8", data: "hello" },
    }).success).toBe(false);
  });

  it("encodes Unicode and NUL as UTF-8 with a known byte length", async () => {
    const data = "안녕🙂\0tail";
    const source = createInlineByteStream({ type: "inline", encoding: "utf8", data });

    expect(source.knownLength).toBe(new TextEncoder().encode(data).byteLength);
    expect(source.contentType).toBe("text/plain; charset=utf-8");
    await expect(new Response(source.stream).text()).resolves.toBe(data);
  });

  it("opens inline bytes without a fetch or fabricated HTTP metadata", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const data = "안녕\0";
    const source = await openSource({ type: "inline", encoding: "utf8", data, filename: "notes.txt" });

    expect(source).not.toHaveProperty("status");
    expect(source).not.toHaveProperty("finalUrl");
    expect(source.contentLength).toBe(new TextEncoder().encode(data).byteLength);
    expect(source.contentType).toBe("text/plain; charset=utf-8");
    expect(source.byteStream.filename).toBe("notes.txt");
    expect(source.stats).toEqual({ sourceGets: 0, bytesRead: new TextEncoder().encode(data).byteLength });
    await expect(new Response(source.byteStream.stream).text()).resolves.toBe(data);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the inline filename as an archive detection hint", async () => {
    const source = await openSource({
      type: "inline", encoding: "base64", data: "", filename: "archive.zip",
    });

    expect(detectFormat(new Uint8Array(), sourceDetectionHints(source))).toMatchObject({
      kind: "archive", format: "zip", source: "extension",
    });
    await source.byteStream.stream.cancel();
  });

  it.each([
    { data: "AA==", expected: [0] },
    { data: "AP8=", expected: [0, 255] },
    { data: "AAEC", expected: [0, 1, 2] },
  ])("decodes padded and unpadded complete Base64 groups ($data)", async ({ data, expected }) => {
    const source = createInlineByteStream({ type: "inline", encoding: "base64", data });

    expect(source.knownLength).toBe(expected.length);
    expect(source.contentType).toBe("application/octet-stream");
    expect(new Uint8Array(await new Response(source.stream).arrayBuffer()))
      .toEqual(new Uint8Array(expected));
  });

  it("preserves supplied content metadata", async () => {
    const source = createInlineByteStream({ type: "inline",
      encoding: "base64",
      data: "AA==",
      contentType: "application/x-custom",
      filename: "자료.bin",
    });

    expect(source.contentType).toBe("application/x-custom");
    expect(source.filename).toBe("자료.bin");
    await source.stream.cancel();
  });

  it.each(["utf8", "base64"] as const)("accepts an empty %s payload", async (encoding) => {
    const source = createInlineByteStream({ type: "inline", encoding, data: "" });

    expect(source.knownLength).toBe(0);
    expect((await new Response(source.stream).arrayBuffer()).byteLength).toBe(0);
  });

  it.each(["%%%=", "a", "a===", "AA=A", "=AAA", "AAAA====", "AA-_"])(
    "rejects malformed Base64 synchronously (%s)",
    (data) => {
      expect(() => createInlineByteStream({ type: "inline", encoding: "base64", data }))
        .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    },
  );

  it.each(["\ud800", "\udc00", "ok\ud800tail", "\ud800\ud800"])(
    "rejects unpaired surrogates rather than replacing them (%j)",
    (data) => {
      expect(() => createInlineByteStream({ type: "inline", encoding: "utf8", data }))
        .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    },
  );

  it.each([
    { contentType: "text/plain\r\nX-Injected: yes" },
    { contentType: "text/plain\0" },
    { filename: "file\nX-Injected: yes" },
  ])("rejects invalid inline metadata ($contentType $filename)", (metadata) => {
    expect(() => createInlineByteStream({ type: "inline", encoding: "utf8", data: "ok", ...metadata }))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it.each(["utf8", "base64"] as const)("accepts the decoded limit for %s", async (encoding) => {
    const value = "a".repeat(LIMITS.inlineSourceBytes);
    const source = createInlineByteStream({ type: "inline",
      encoding,
      data: encoding === "base64" ? btoa(value) : value,
    });

    expect(source.knownLength).toBe(LIMITS.inlineSourceBytes);
    await source.stream.cancel();
  });

  it.each(["utf8", "base64"] as const)("rejects a decoded %s payload over the limit", (encoding) => {
    const value = "a".repeat(LIMITS.inlineSourceBytes + 1);

    expect(() => createInlineByteStream({ type: "inline",
      encoding,
      data: encoding === "base64" ? btoa(value) : value,
    })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST", status: 413 }));
  });

  it("measures the UTF-8 limit in bytes rather than UTF-16 code units", () => {
    const data = "한".repeat(Math.floor(LIMITS.inlineSourceBytes / 3) + 1);
    expect(data.length).toBeLessThan(LIMITS.inlineSourceBytes);
    expect(() => createInlineByteStream({ type: "inline", encoding: "utf8", data }))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST", status: 413 }));
  });

  it.each(["utf8", "base64"] as const)("emits bounded chunks without losing %s bytes", async (encoding) => {
    const text = "한😀\0".repeat(20_000);
    const expected = new TextEncoder().encode(text);
    const binary = Array.from(expected, (byte) => String.fromCharCode(byte)).join("");
    const source = createInlineByteStream({ type: "inline",
      encoding,
      data: encoding === "base64" ? btoa(binary) : text,
    });
    const reader = source.stream.getReader();
    let offset = 0;
    let chunks = 0;

    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        expect(result.value.byteLength).toBeGreaterThan(0);
        expect(result.value.byteLength).toBeLessThanOrEqual(64 * 1024);
        expect(result.value).toEqual(expected.subarray(offset, offset + result.value.byteLength));
        offset += result.value.byteLength;
        chunks += 1;
      }
    } finally {
      reader.releaseLock();
    }

    expect(chunks).toBeGreaterThan(1);
    expect(offset).toBe(expected.byteLength);
  });

  it("errors a partially read stream when aborted", async () => {
    const source = createInlineByteStream({ type: "inline", encoding: "utf8", data: "a".repeat(150_000) });
    const reader = source.stream.getReader();
    const reason = new Error("stop inline source");
    await reader.read();

    source.abort(reason);
    await expect(reader.read()).rejects.toBe(reason);
    reader.releaseLock();
    expect(() => source.abort(reason)).not.toThrow();
  });

  it("propagates a parent abort signal after streaming starts", async () => {
    const controller = new AbortController();
    const source = createInlineByteStream({
      type: "inline", encoding: "utf8", data: "a".repeat(150_000),
    }, controller.signal);
    const reader = source.stream.getReader();
    await reader.read();
    const reason = new Error("parent request aborted");

    controller.abort(reason);
    await expect(reader.read()).rejects.toMatchObject({ code: "PIPELINE_ABORTED" });
    reader.releaseLock();
  });

  it("honors an already aborted parent signal", () => {
    const controller = new AbortController();
    const reason = new Error("request already aborted");
    controller.abort(reason);
    expect(() => createInlineByteStream({ type: "inline", encoding: "utf8", data: "hello" }, controller.signal))
      .toThrowError(expect.objectContaining({ code: "PIPELINE_ABORTED" }));
  });

  it("permits consumer cancellation before all inline data has been emitted", async () => {
    const source = createInlineByteStream({ type: "inline", encoding: "base64", data: btoa("a".repeat(150_000)) });
    const reader = source.stream.getReader();
    await reader.read();

    await reader.cancel("target stopped reading");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();
    expect(() => source.abort(new Error("already cancelled"))).not.toThrow();
  });
});
