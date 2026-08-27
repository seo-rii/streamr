import { describe, expect, it, vi } from "vitest";
import { decompressBzip2 } from "../../src/archive/bzip2";
import { decompressZstd } from "../../src/archive/zstd";
import type { ByteStream } from "../../src/streams/byte-stream";

const BZIP2_FIXTURE =
  "QlpoOTFBWSZTWTG7HUIAACvTgAAQQAEEAD////AgAJAoAAAAAFVU8SBoyZNDam2omMRA9iB5FRIVGQ7j4PA0EhoFhMajYZiwuH0SExA1FBiKjYUGY/iwoIED0OW43HAu5IpwoSBjdjqE";
const ZSTD_FIXTURE =
  "KLUv/WRoALUBANQCVGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZy4KAQDFgaoqA6TB/IU=";
const EXPECTED = "The quick brown fox jumps over the lazy dog.\n".repeat(8);

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function inputStream(
  bytes: Uint8Array,
  options: {
    chunkSize?: number;
    abort?: (reason?: unknown) => void;
    onPull?: () => void;
  } = {},
): ByteStream {
  const chunkSize = options.chunkSize ?? bytes.byteLength;
  let offset = 0;
  return {
    stream: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          options.onPull?.();
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(offset + chunkSize, bytes.byteLength);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      },
      { highWaterMark: 0 },
    ),
    knownLength: bytes.byteLength,
    abort: options.abort ?? vi.fn(),
  };
}

async function readBytes(stream: ByteStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream.stream) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readText(stream: ByteStream): Promise<string> {
  return new TextDecoder().decode(await readBytes(stream));
}

describe("BZIP2 decompression", () => {
  it("streams a valid fixture split at every byte and drops the known length", async () => {
    const decompressed = decompressBzip2(inputStream(fromBase64(BZIP2_FIXTURE), { chunkSize: 1 }));

    expect(decompressed.knownLength).toBeUndefined();
    await expect(readText(decompressed)).resolves.toBe(EXPECTED);
  });

  it("maps invalid and truncated streams to CORRUPT_ARCHIVE", async () => {
    const fixture = fromBase64(BZIP2_FIXTURE);
    await expect(
      readText(decompressBzip2(inputStream(new Uint8Array([0x42, 0x5a, 0x68, 0x39])))),
    ).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE", stage: "decompress" });
    await expect(
      readText(decompressBzip2(inputStream(fixture.subarray(0, fixture.byteLength - 5), {
        chunkSize: 2,
      }))),
    ).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE", stage: "decompress" });
  });

  it("enforces its output limit before emitting an oversized block", async () => {
    const abort = vi.fn();
    const decompressed = decompressBzip2(inputStream(fromBase64(BZIP2_FIXTURE), { abort }), {
      maxOutputBytes: EXPECTED.length - 1,
    });

    await expect(readText(decompressed)).rejects.toMatchObject({
      code: "OUTPUT_LIMIT_EXCEEDED",
      details: { format: "bzip2", maxBytes: EXPECTED.length - 1 },
    });
    expect(abort).toHaveBeenCalled();
  });

  it("cancels through the dependency's reader.abort compatibility bridge", async () => {
    const abort = vi.fn();
    const fixture = fromBase64(BZIP2_FIXTURE);
    const decompressed = decompressBzip2(
      inputStream(concatenate([fixture, fixture]), { chunkSize: 3, abort }),
    );
    const reader = decompressed.stream.getReader();

    expect((await reader.read()).done).toBe(false);
    await reader.cancel("consumer stopped");
    expect(abort).toHaveBeenCalledWith("consumer stopped");
  });
});

describe("ZSTD decompression", () => {
  it("streams a valid fixture split at every byte and drops the known length", async () => {
    const decompressed = decompressZstd(inputStream(fromBase64(ZSTD_FIXTURE), { chunkSize: 1 }));

    expect(decompressed.knownLength).toBeUndefined();
    await expect(readText(decompressed)).resolves.toBe(EXPECTED);
  });

  it("maps invalid and truncated frames to CORRUPT_ARCHIVE", async () => {
    const fixture = fromBase64(ZSTD_FIXTURE);
    await expect(
      readText(decompressZstd(inputStream(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd])))),
    ).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE", stage: "decompress" });
    await expect(
      readText(decompressZstd(inputStream(fixture.subarray(0, fixture.byteLength - 2), {
        chunkSize: 3,
      }))),
    ).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE", stage: "decompress" });
  });

  it("verifies the optional frame checksum across one-byte input chunks", async () => {
    const corrupted = fromBase64(ZSTD_FIXTURE);
    const checksumOffset = corrupted.byteLength - 1;
    corrupted[checksumOffset] = corrupted[checksumOffset]! ^ 1;

    await expect(
      readText(decompressZstd(inputStream(corrupted, { chunkSize: 1 }))),
    ).rejects.toMatchObject({ code: "CORRUPT_ARCHIVE", stage: "decompress" });
  });

  it("rejects frames whose advertised decoder window exceeds 32 MiB", async () => {
    const oversizedWindowHeader = new Uint8Array([
      0x28, 0xb5, 0x2f, 0xfd,
      0x00,
      0x90,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);

    await expect(
      readText(decompressZstd(inputStream(oversizedWindowHeader))),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_COMPRESSION",
      stage: "decompress",
      details: { format: "zstd", maxWindowBytes: 32 * 1024 * 1024 },
    });
  });

  it("checks the output limit synchronously in the decoder callback", async () => {
    const abort = vi.fn();
    const decompressed = decompressZstd(inputStream(fromBase64(ZSTD_FIXTURE), { abort }), {
      maxOutputBytes: EXPECTED.length - 1,
    });

    await expect(readText(decompressed)).rejects.toMatchObject({
      code: "OUTPUT_LIMIT_EXCEEDED",
      details: { format: "zstd", maxBytes: EXPECTED.length - 1 },
    });
    expect(abort).toHaveBeenCalled();
  });

  it("drains callback output under demand before feeding another 4 KiB batch", async () => {
    const fixture = fromBase64(ZSTD_FIXTURE);
    const frames = concatenate(Array.from({ length: 100 }, () => fixture));
    let pulls = 0;
    const abort = vi.fn();
    const decompressed = decompressZstd(
      inputStream(frames, { chunkSize: frames.byteLength, abort, onPull: () => pulls += 1 }),
    );
    const reader = decompressed.stream.getReader();

    expect((await reader.read()).done).toBe(false);
    expect(pulls).toBe(1);
    expect((await reader.read()).done).toBe(false);
    expect(pulls).toBe(1);
    await reader.cancel("stop after queued output");
    expect(abort).toHaveBeenCalledWith("stop after queued output");
  });
});
