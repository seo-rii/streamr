import { describe, expect, it, vi } from "vitest";
import { decompressXz } from "../../src/archive/xz";
import type { ByteStream } from "../../src/streams/byte-stream";

const XZ_HELLO = Uint8Array.from(
  atob(
    "/Td6WFoAAATm1rRGAgAhARYAAAB0L+WjAQAIaGVsbG8geHoKAAAAAMFJOvpjUhRaAAEhCWwYxdUftvN9AQAAAAAEWVo=",
  ),
  (character) => character.charCodeAt(0),
);

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function chunkedInput(bytes: Uint8Array, chunkBytes: number, abort = vi.fn()): ByteStream {
  let offset = 0;
  return {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkBytes, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    }),
    abort,
  };
}

describe("XZ bounded decompression", () => {
  it("decompresses input split across single-byte chunks", async () => {
    const output = decompressXz(chunkedInput(XZ_HELLO, 1));
    await expect(new Response(output.stream).text()).resolves.toBe("hello xz\n");
  });

  it("rejects a truncated stream", async () => {
    const output = decompressXz(chunkedInput(XZ_HELLO.subarray(0, 32), 3));
    await expect(new Response(output.stream).arrayBuffer()).rejects.toMatchObject({
      code: "CORRUPT_ARCHIVE",
    });
  });

  it("decompresses concatenated streams and accepts aligned zero padding", async () => {
    const concatenated = concatenate([XZ_HELLO, new Uint8Array(4), XZ_HELLO]);
    const output = decompressXz(chunkedInput(concatenated, 7));
    await expect(new Response(output.stream).text()).resolves.toBe("hello xz\nhello xz\n");
  });

  it("rejects trailing garbage and misaligned stream padding", async () => {
    const garbage = decompressXz(
      chunkedInput(concatenate([XZ_HELLO, new Uint8Array([0x01])]), 5),
    );
    await expect(new Response(garbage.stream).arrayBuffer()).rejects.toMatchObject({
      code: "CORRUPT_ARCHIVE",
    });

    const padding = decompressXz(
      chunkedInput(concatenate([XZ_HELLO, new Uint8Array([0x00])]), 5),
    );
    await expect(new Response(padding.stream).arrayBuffer()).rejects.toMatchObject({
      code: "CORRUPT_ARCHIVE",
    });
  });

  it("aborts upstream when the output limit is exceeded", async () => {
    const abort = vi.fn();
    const output = decompressXz(chunkedInput(XZ_HELLO, 2, abort), 4);
    await expect(new Response(output.stream).arrayBuffer()).rejects.toMatchObject({
      code: "OUTPUT_LIMIT_EXCEEDED",
    });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("propagates downstream cancellation", async () => {
    const abort = vi.fn();
    const output = decompressXz(chunkedInput(XZ_HELLO, 1, abort));
    await output.stream.cancel("client disconnected");
    expect(abort).toHaveBeenCalledWith("client disconnected");
  });
});
