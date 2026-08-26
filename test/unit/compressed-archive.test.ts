import { describe, expect, it } from "vitest";
import { openArchive } from "../../src/archive/open";
import { listOpenedArchive } from "../../src/archive/select";
import type { ByteStream } from "../../src/streams/byte-stream";

const TAR_FIXTURES = {
  "tar.bz2":
    "QlpoOTFBWSZTWbSuVvYAAFvbgMkQQAH/gAEAdkReQAiIIAByEqnqZAGgaDQ08oFUinqaeUNMR6gaA1VP2CUKERm1ZKnJppvVLSQmi6brOMlEKJBdMVYqNiSzicGDPolg3LrFY8QeEo8IKhIc6poz3mgowrhhRjMxKD8XckU4UJC0rlb2",
  "tar.xz":
    "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Av/AGJdADIYSu6W1Oxx2msLtsHVV+nH1g+G1wsrnQel+pd26vJRBUPLhpoWiBrJCPQJlHhqgYXN3/KZn9+9+BdMYFJmPpuaqjKdoi5e9qDwG8zabzzD29WeVyNcDdKMG/YHhwZ352mAAAAAjcrcyRQ2UtcAAX6AGAAAAI53NtaxxGf7AgAAAAAEWVo=",
  "tar.zst":
    "KLUv/QRYRQMAYsQOF4DF6QDEwj2zqPgMrLo3LZEluITNxtgBaSikTLMr6JEg3ZTmAliwT+ntgyc8VyDC8P/v8N8ykENNsysNAP5zFcgXIKtjB9TbB8hpkYEKIBxDFQQoIN6QGnDAophpAHQr17YJeAEvBaQ2",
} as const;

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
});
