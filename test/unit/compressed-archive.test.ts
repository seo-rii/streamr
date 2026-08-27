import { describe, expect, it, vi } from "vitest";
import { openArchive } from "../../src/archive/open";
import { listOpenedArchive } from "../../src/archive/select";
import type { ArchiveEntryHandle, OpenedArchive } from "../../src/archive/types";
import type { ByteStream } from "../../src/streams/byte-stream";

const TAR_FIXTURES = {
  "tar.bz2":
    "QlpoOTFBWSZTWbSuVvYAAFvbgMkQQAH/gAEAdkReQAiIIAByEqnqZAGgaDQ08oFUinqaeUNMR6gaA1VP2CUKERm1ZKnJppvVLSQmi6brOMlEKJBdMVYqNiSzicGDPolg3LrFY8QeEo8IKhIc6poz3mgowrhhRjMxKD8XckU4UJC0rlb2",
  "tar.xz":
    "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Av/AGJdADIYSu6W1Oxx2msLtsHVV+nH1g+G1wsrnQel+pd26vJRBUPLhpoWiBrJCPQJlHhqgYXN3/KZn9+9+BdMYFJmPpuaqjKdoi5e9qDwG8zabzzD29WeVyNcDdKMG/YHhwZ352mAAAAAjcrcyRQ2UtcAAX6AGAAAAI53NtaxxGf7AgAAAAAEWVo=",
  "tar.zst":
    "KLUv/QRYRQMAYsQOF4DF6QDEwj2zqPgMrLo3LZEluITNxtgBaSikTLMr6JEg3ZTmAliwT+ntgyc8VyDC8P/v8N8ykENNsysNAP5zFcgXIKtjB9TbB8hpkYEKIBxDFQQoIN6QGnDAophpAHQr17YJeAEvBaQ2",
} as const;
const ZSTD_PAYLOAD_FIXTURE =
  "KLUv/WRoALUBANQCVGhlIHF1aWNrIGJyb3duIGZveCBqdW1wcyBvdmVyIHRoZSBsYXp5IGRvZy4KAQDFgaoqA6TB/IU=";

function inputFromBase64(value: string): ByteStream {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  let offset = 0;
  return {
    stream: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 3, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    }),
    abort() {},
  };
}

describe("compressed TAR archive resolution", () => {
  for (const [format, fixture] of Object.entries(TAR_FIXTURES)) {
    it(`lists ${format} entries through a bounded decoder`, async () => {
      const archive = await openArchive(inputFromBase64(fixture), {}, { listMode: true });
      const listed = await listOpenedArchive(archive, 10);

      expect(archive.format).toBe(format);
      expect(archive.layers.at(-1)).toBe("tar");
      expect(listed).toMatchObject({
        truncated: false,
        entries: [
          { path: "data/a.txt", type: "file", size: 6 },
          { path: "data/b.txt", type: "file", size: 5 },
        ],
      });
    });
  }

  it("lists standalone compression as an explicitly unknown-size @payload", async () => {
    const archive = await openArchive(
      inputFromBase64(ZSTD_PAYLOAD_FIXTURE),
      {},
      { listMode: true },
    );

    await expect(listOpenedArchive(archive, 10)).resolves.toMatchObject({
      truncated: false,
      entries: [{ path: "@payload", type: "file", size: null }],
    });
  });

  it("aborts immediately at the listing limit without draining the next entry", async () => {
    const firstSkip = vi.fn(async () => undefined);
    const secondSkip = vi.fn(async () => undefined);
    const abort = vi.fn();
    const handles: ArchiveEntryHandle[] = [
      {
        index: 1,
        path: "first.txt",
        occurrence: 1,
        unsafePath: false,
        type: "file",
        async open() {
          throw new Error("not opened while listing");
        },
        skip: firstSkip,
      },
      {
        index: 2,
        path: "very-large.bin",
        occurrence: 1,
        unsafePath: false,
        type: "file",
        async open() {
          throw new Error("not opened while listing");
        },
        skip: secondSkip,
      },
    ];
    const archive: OpenedArchive = {
      format: "test",
      layers: ["test"],
      entries: {
        async *[Symbol.asyncIterator]() {
          yield* handles;
        },
      },
      abort,
    };

    await expect(listOpenedArchive(archive, 1)).resolves.toMatchObject({
      truncated: true,
      entries: [{ path: "first.txt" }],
    });
    expect(firstSkip).toHaveBeenCalledOnce();
    expect(secondSkip).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith("archive listing truncated");
  });
});
