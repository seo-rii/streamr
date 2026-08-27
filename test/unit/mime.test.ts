import { describe, expect, it, vi } from "vitest";
import type { ByteStream } from "../../src/streams/byte-stream";
import { inferByteStreamContentType } from "../../src/util/mime";

describe("stream MIME inference", () => {
  it("lets bounded magic detection override an incorrect upstream content type", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const input: ByteStream = {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 2));
          controller.enqueue(bytes.subarray(2));
          controller.close();
        },
      }),
      knownLength: bytes.byteLength,
      contentType: "text/plain",
      abort: vi.fn(),
    };

    const inferred = await inferByteStreamContentType(input);
    expect(inferred.contentType).toBe("application/zip");
    await expect(new Response(inferred.stream).bytes()).resolves.toEqual(bytes);
  });

  it("retains upstream metadata when no supported magic is present", async () => {
    const bytes = new TextEncoder().encode("hello");
    const input: ByteStream = {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      contentType: "text/custom",
      abort: vi.fn(),
    };

    const inferred = await inferByteStreamContentType(input);
    expect(inferred.contentType).toBe("text/custom");
    await expect(new Response(inferred.stream).text()).resolves.toBe("hello");
  });
});
