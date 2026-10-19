import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../src/constants";
import type { ByteStream } from "../../src/streams/byte-stream";
import { replaceLiteral } from "../../src/transforms/replace";

const encoder = new TextEncoder();
const OUTPUT_CHUNK_BYTES = 64 * 1024;

function source(chunks: Array<string | Uint8Array>) {
  let index = 0;
  const abort = vi.fn();
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const chunk = chunks[index++];
    if (chunk === undefined) controller.close();
    else controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
  });
  const byteStream: ByteStream = {
    stream: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
    contentType: "text/plain; charset=utf-8",
    abort,
  };
  return { byteStream, pull, abort, cancel };
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      expect(result.value.byteLength).toBeGreaterThan(0);
      expect(result.value.byteLength).toBeLessThanOrEqual(OUTPUT_CHUNK_BYTES);
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { chunks, bytes, text: new TextDecoder().decode(bytes) };
}

describe("bounded literal replacement output", () => {
  it("coalesces dense replacements into four 64 KiB chunks", async () => {
    const fixture = source(Array.from({ length: 4 }, () => "a".repeat(OUTPUT_CHUNK_BYTES)));
    const output = replaceLiteral(fixture.byteStream, "a", "b");
    const result = await collect(output.stream);

    expect(result.chunks.map((chunk) => chunk.byteLength)).toEqual(Array(4).fill(OUTPUT_CHUNK_BYTES));
    expect(result.bytes.byteLength).toBe(256 * 1024);
    expect(result.bytes.every((byte) => byte === 98)).toBe(true);
    expect(output.knownLength).toBeUndefined();
    expect(output.contentType).toBe("text/plain; charset=utf-8");
  });

  it("bounds large unmatched literals as well as replacement bytes", async () => {
    const text = "unchanged🙂".repeat(30_000);
    const result = await collect(replaceLiteral(source([text]).byteStream, "missing", "x").stream);

    expect(result.text).toBe(text);
    expect(result.chunks.length).toBeGreaterThan(4);
  });

  it("streams replacements larger than the output chunk limit without sharing chunks", async () => {
    const replacement = "🙂한".repeat(50_000);
    const result = await collect(replaceLiteral(source(["aa"]).byteStream, "a", replacement).stream);

    expect(result.text).toBe(replacement.repeat(2));
    expect(result.chunks.length).toBeGreaterThan(2);
    expect(new Set(result.chunks.map((chunk) => chunk.buffer)).size).toBe(result.chunks.length);
  });

  it("preserves multibyte literals and replacements at the output buffer boundary", async () => {
    const prefix = "x".repeat(OUTPUT_CHUNK_BYTES - 1);
    const result = await collect(replaceLiteral(source([`${prefix}a🙂end`]).byteStream, "a", "🙂").stream);

    expect(result.bytes.subarray(0, prefix.length).every((byte) => byte === 120)).toBe(true);
    expect(result.text.slice(prefix.length)).toBe("🙂🙂end");
    for (const chunk of result.chunks) {
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(chunk)).not.toThrow();
    }
  });

  it("handles search matches and UTF-8 code points split across source chunks", async () => {
    const bytes = encoder.encode("🙂aba한aba🙂");
    const chunks = Array.from(bytes, (_byte, index) => bytes.subarray(index, index + 1));
    const result = await collect(replaceLiteral(source(chunks).byteStream, "aba", "끝").stream);

    expect(result.text).toBe("🙂끝한끝🙂");
  });

  it("preserves non-overlapping matches and permits empty replacements", async () => {
    const replaced = await collect(replaceLiteral(source(["a", "aa", "aa"]).byteStream, "aa", "🙂").stream);
    const removed = await collect(replaceLiteral(source(["ab", "a🙂ab", "a"]).byteStream, "aba", "").stream);

    expect(replaced.text).toBe("🙂🙂a");
    expect(removed.text).toBe("🙂");
  });

  it("retains a maximum-length search across bounded source chunks", async () => {
    const search = `${"x".repeat(LIMITS.replaceSearchBytes - 1)}y`;
    const text = `before:${search}:after`;
    const chunks = Array.from({ length: Math.ceil(text.length / 1024) }, (_value, index) =>
      text.slice(index * 1024, (index + 1) * 1024));
    const result = await collect(replaceLiteral(source(chunks).byteStream, search, "found").stream);

    expect(result.text).toBe("before:found:after");
  });

  it("preserves the decoder's initial BOM handling and interior BOMs", async () => {
    const fixture = source([
      new Uint8Array([0xef]),
      new Uint8Array([0xbb]),
      new Uint8Array([0xbf]),
      "a\ufeffa",
    ]);
    const result = await collect(replaceLiteral(fixture.byteStream, "a", "한").stream);

    expect(result.text).toBe("한\ufeff한");
  });

  it.each([
    [new Uint8Array([0xc3, 0x28])],
    [new Uint8Array([0xf0]), new Uint8Array([0x9f])],
  ])("still rejects malformed or truncated UTF-8 (%j)", async (...chunks) => {
    const fixture = source(chunks);
    const output = replaceLiteral(fixture.byteStream, "a", "b");

    await expect(new Response(output.stream).arrayBuffer()).rejects.toMatchObject({ code: "INVALID_UTF8" });
    expect(fixture.abort).toHaveBeenCalled();
  });

  it("flushes available output before waiting for another source chunk", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const input: ByteStream = {
      stream: new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(encoder.encode("a"));
        },
      }, { highWaterMark: 0 }),
      abort: vi.fn(),
    };
    const reader = replaceLiteral(input, "a", "b").stream.getReader();
    let delivered = false;
    const first = reader.read().then((result) => {
      delivered = true;
      return result;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const deliveredBeforeNextInput = delivered;
    controller?.enqueue(encoder.encode("c"));
    controller?.close();

    expect(new TextDecoder().decode((await first).value)).toBe("b");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("c");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();
    expect(deliveredBeforeNextInput).toBe(true);
  });

  it("keeps returned full and partial chunks independent of later output", async () => {
    const output = replaceLiteral(source(["a".repeat(OUTPUT_CHUNK_BYTES), "a", "a"]).byteStream, "a", "b");
    const reader = output.stream.getReader();
    const first = (await reader.read()).value;
    if (first === undefined) throw new Error("missing full replacement chunk");
    first.fill(0);
    const second = (await reader.read()).value;
    if (second === undefined) throw new Error("missing partial replacement chunk");
    second.fill(0);

    expect(new TextDecoder().decode((await reader.read()).value)).toBe("b");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();
  });

  it("cancels a large expansion before consuming another source chunk", async () => {
    const fixture = source(["a", "unread"]);
    const reader = replaceLiteral(fixture.byteStream, "a", "x".repeat(1024 * 1024)).stream.getReader();

    expect((await reader.read()).value?.byteLength).toBe(OUTPUT_CHUNK_BYTES);
    expect(fixture.pull).toHaveBeenCalledTimes(1);
    await reader.cancel("downstream stopped");
    reader.releaseLock();
    expect(fixture.pull).toHaveBeenCalledTimes(1);
    expect(fixture.abort).toHaveBeenCalledWith("downstream stopped");
    expect(fixture.cancel).toHaveBeenCalled();
  });
});
