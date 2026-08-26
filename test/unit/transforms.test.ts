import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../src/constants";
import type { EntryTransformSpec } from "../../src/schemas";
import type { ByteStream } from "../../src/streams/byte-stream";
import {
  applyEntryTransforms,
  applyFinalTransforms,
  validateEntryTransforms,
} from "../../src/transforms";

const encoder = new TextEncoder();

function inputStream(
  chunks: Array<string | Uint8Array>,
  options: { knownLength?: number; contentType?: string; abort?: (reason?: unknown) => void } = {},
): ByteStream {
  const bytes = chunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk));
  let index = 0;
  return {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = bytes[index];
        index += 1;
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    }),
    ...(options.knownLength === undefined ? {} : { knownLength: options.knownLength }),
    ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    abort: options.abort ?? vi.fn(),
  };
}

async function readBytes(stream: ByteStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream.stream).arrayBuffer());
}

async function readText(stream: ByteStream): Promise<string> {
  return new TextDecoder().decode(await readBytes(stream));
}

describe("newline transform", () => {
  it("normalizes CR, LF, and a split CRLF while preserving split UTF-8", async () => {
    const source = encoder.encode("가\r\n나\r다\n끝");
    const transformed = await applyEntryTransforms(
      inputStream([
        source.subarray(0, 1),
        source.subarray(1, 4),
        source.subarray(4, 5),
        source.subarray(5),
      ], { contentType: "text/plain; charset=utf-8" }),
      [{ type: "newline", mode: "crlf", ensureFinalNewline: true }],
    );

    await expect(readText(transformed)).resolves.toBe("가\r\n나\r\n다\r\n끝\r\n");
    expect(transformed.knownLength).toBeUndefined();
  });

  it("waits across an empty chunk before deciding whether a trailing CR is part of CRLF", async () => {
    const transformed = await applyEntryTransforms(inputStream(["a\r", new Uint8Array(), "\nb"]), [
      { type: "newline", mode: "lf", ensureFinalNewline: false },
    ]);
    await expect(readText(transformed)).resolves.toBe("a\nb");
  });

  it("does not add a final newline to an empty stream", async () => {
    const transformed = await applyEntryTransforms(inputStream([]), [
      { type: "newline", mode: "lf", ensureFinalNewline: true },
    ]);
    await expect(readText(transformed)).resolves.toBe("");
  });

  it("rejects malformed UTF-8 and an explicit non-UTF-8 charset", async () => {
    const malformed = await applyEntryTransforms(inputStream([new Uint8Array([0xc3, 0x28])]), [
      { type: "newline", mode: "lf", ensureFinalNewline: false },
    ]);
    await expect(readText(malformed)).rejects.toMatchObject({ code: "INVALID_UTF8" });

    await expect(
      applyEntryTransforms(inputStream(["text"], { contentType: "text/plain; charset=euc-kr" }), [
        { type: "newline", mode: "lf", ensureFinalNewline: false },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_TRANSFORM" });
  });
});

describe("literal replace transform", () => {
  it("replaces matches split across chunks without corrupting multibyte characters", async () => {
    const transformed = await applyEntryTransforms(inputStream(["🙂xa", "bc🙂", "abc!"]), [
      { type: "replace", search: "abc", replacement: "한" },
    ]);
    await expect(readText(transformed)).resolves.toBe("🙂x한🙂한!");
  });

  it("uses non-overlapping literal replacement semantics", async () => {
    const transformed = await applyEntryTransforms(inputStream(["a", "aa"]), [
      { type: "replace", search: "aa", replacement: "X" },
    ]);
    await expect(readText(transformed)).resolves.toBe("Xa");
  });

  it("rejects unpaired surrogates in textual transform metadata", () => {
    expect(() =>
      validateEntryTransforms([{ type: "replace", search: "a", replacement: "\ud800" }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSFORM" }));
    expect(() =>
      validateEntryTransforms([{ type: "prepend", encoding: "utf8", data: "\udc00" }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSFORM" }));
  });

  it("keeps surrogate pairs intact when retaining a boundary suffix", async () => {
    const transformed = await applyEntryTransforms(inputStream(["🙂", "z"]), [
      { type: "replace", search: "ab", replacement: "x" },
    ]);
    await expect(readText(transformed)).resolves.toBe("🙂z");
  });

  it("emits expansion chunks under downstream demand before reading more source data", async () => {
    let pulls = 0;
    const source: ByteStream = {
      stream: new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(encoder.encode("aaaa"));
            else controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
      abort: vi.fn(),
    };
    const transformed = await applyEntryTransforms(source, [
      { type: "replace", search: "a", replacement: "expanded" },
    ]);
    const reader = transformed.stream.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toBe("expanded");
    expect(pulls).toBe(1);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("expanded");
    expect(pulls).toBe(1);
    await reader.cancel();
  });
});

describe("affix transforms", () => {
  it("prepends UTF-8 and appends base64 data", async () => {
    const transformed = await applyEntryTransforms(inputStream(["body"], { knownLength: 4 }), [
      { type: "prepend", encoding: "utf8", data: "앞:" },
      { type: "append", encoding: "base64", data: btoa(":tail") },
    ]);
    await expect(readText(transformed)).resolves.toBe("앞:body:tail");
    expect(transformed.knownLength).toBeUndefined();
  });

  it("rejects malformed base64 and decoded values over 64 KiB", () => {
    expect(() =>
      validateEntryTransforms([{ type: "prepend", encoding: "base64", data: "%%%=" }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSFORM" }));
    expect(() =>
      validateEntryTransforms([
        { type: "append", encoding: "base64", data: btoa("x".repeat(LIMITS.affixBytes + 1)) },
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSFORM" }));
  });
});

describe("slice and limit transforms", () => {
  it("slices across chunks, reports an exact known length, and stops upstream early", async () => {
    const abort = vi.fn();
    const transformed = await applyEntryTransforms(
      inputStream(["abc", "def", "ghi"], { knownLength: 9, abort }),
      [{ type: "slice", start: 2, length: 4 }],
    );
    expect(transformed.knownLength).toBe(4);
    await expect(readText(transformed)).resolves.toBe("cdef");
    expect(abort).toHaveBeenCalledWith("slice length reached");
  });

  it("streams to EOF when slice length is omitted", async () => {
    const transformed = await applyEntryTransforms(
      inputStream(["abc", "def"], { knownLength: 6 }),
      [{ type: "slice", start: 4 }],
    );
    expect(transformed.knownLength).toBe(2);
    await expect(readText(transformed)).resolves.toBe("ef");
  });

  it("rejects an unknown-length stream only when it crosses the output limit", async () => {
    const abort = vi.fn();
    const transformed = await applyEntryTransforms(inputStream(["12", "34"], { abort }), [
      { type: "limit", maxBytes: 3 },
    ]);
    await expect(readText(transformed)).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
    expect(abort).toHaveBeenCalled();
  });

  it("rejects a known oversized stream before consumption", async () => {
    const abort = vi.fn();
    await expect(
      applyEntryTransforms(inputStream(["1234"], { knownLength: 4, abort }), [
        { type: "limit", maxBytes: 3 },
      ]),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT_EXCEEDED" });
    expect(abort).toHaveBeenCalledWith("known output length exceeds the limit");
  });
});

describe("compression transforms", () => {
  it("gzip-compresses and auto-detects gzip decompression", async () => {
    const compressed = await applyEntryTransforms(inputStream(["large ", "payload ".repeat(100)]), [
      { type: "gzip" },
    ]);
    expect(compressed.contentType).toBe("application/gzip");
    expect(compressed.knownLength).toBeUndefined();
    const compressedBytes = await readBytes(compressed);

    const decompressed = await applyEntryTransforms(inputStream([compressedBytes]), [
      { type: "decompress", format: "auto" },
    ]);
    await expect(readText(decompressed)).resolves.toBe(`large ${"payload ".repeat(100)}`);
  });

  it("reports truncated and undetected formats explicitly", async () => {
    const truncatedBzip2 = await applyEntryTransforms(
      inputStream([new Uint8Array([0x42, 0x5a, 0x68])]),
      [{ type: "decompress", format: "auto" }],
    );
    await expect(readText(truncatedBzip2)).rejects.toMatchObject({
      code: "CORRUPT_ARCHIVE",
      details: { format: "bzip2" },
    });
    await expect(
      applyEntryTransforms(inputStream(["plain"]), [{ type: "decompress", format: "auto" }]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });
});

describe("multipart/form-data transform", () => {
  it("places scalar fields before one streamed file and terminates the random boundary", async () => {
    const transformed = await applyEntryTransforms(inputStream(["file-body"], { knownLength: 9 }), [
      {
        type: "multipart-form-data",
        fieldName: "upload",
        filename: '한글 "01".in',
        contentType: "text/plain",
        fields: { problemId: "1234" },
      },
    ]);
    const contentType = transformed.contentType ?? "";
    const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
    expect(boundary).toMatch(/^sgw_form_[0-9a-f]{32}$/);
    expect(transformed.knownLength).toBeUndefined();

    const body = await readText(transformed);
    expect(body).toContain('name="problemId"\r\n\r\n1234\r\n');
    expect(body).toContain('name="upload"; filename="__ \\"01\\".in"; filename*=UTF-8');
    expect(body).toContain("Content-Type: text/plain\r\n\r\nfile-body");
    expect(body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
  });

  it("must be last and may be disabled for non-target pipelines", () => {
    const form: EntryTransformSpec = {
      type: "multipart-form-data",
      fieldName: "file",
      filename: "a.txt",
      contentType: "text/plain",
      fields: {},
    };
    expect(() =>
      validateEntryTransforms([form, { type: "limit", maxBytes: 100 }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSFORM" }));
    expect(() => validateEntryTransforms([form], { allowMultipartFormData: false })).toThrowError(
      expect.objectContaining({ code: "INVALID_TRANSFORM" }),
    );
  });
});

describe("pipeline validation and metadata", () => {
  it("rejects too many transforms, byte-oversized searches, and text after gzip", () => {
    const limits = Array.from({ length: LIMITS.transforms + 1 }, () => ({
      type: "limit" as const,
      maxBytes: 1,
    }));
    expect(() => validateEntryTransforms(limits)).toThrowError(
      expect.objectContaining({ code: "INVALID_TRANSFORM" }),
    );
    expect(() =>
      validateEntryTransforms([
        { type: "replace", search: "가".repeat(22_000), replacement: "" },
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSFORM" }));
    expect(() =>
      validateEntryTransforms([
        { type: "gzip" },
        { type: "newline", mode: "lf", ensureFinalNewline: false },
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TRANSFORM" }));
  });

  it("applies final limit and gzip while dropping the known length", async () => {
    const transformed = await applyFinalTransforms(inputStream(["123"], { knownLength: 3 }), [
      { type: "limit", maxBytes: 3 },
      { type: "gzip" },
    ]);
    expect(transformed.knownLength).toBeUndefined();
    const compressed = await readBytes(transformed);
    const decompressed = await applyEntryTransforms(inputStream([compressed]), [
      { type: "decompress", format: "gzip" },
    ]);
    await expect(readText(decompressed)).resolves.toBe("123");
  });
});
