import {
  Zip,
  ZipDeflate,
  ZipPassThrough,
} from "fflate";
import { packTar, type TarEntry } from "modern-tar";
import { describe, expect, it, vi } from "vitest";
import { TarAdapter } from "../../src/archive/tar";
import type {
  ArchiveAdapter,
  ArchiveEntryHandle,
} from "../../src/archive/types";
import { ZipAdapter } from "../../src/archive/zip";
import type { ByteStream } from "../../src/streams/byte-stream";
import { normalizeArchivePath } from "../../src/util/path";

const encoder = new TextEncoder();

interface TestByteStream {
  byteStream: ByteStream;
  abort: ReturnType<typeof vi.fn>;
  pulls: () => number;
}

function testByteStream(bytes: Uint8Array, chunkSize = bytes.byteLength): TestByteStream {
  const abort = vi.fn();
  let offset = 0;
  let pullCount = 0;

  return {
    byteStream: {
      stream: new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount += 1;
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(offset + Math.max(1, chunkSize), bytes.byteLength);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      }),
      knownLength: bytes.byteLength,
      abort,
    },
    abort,
    pulls: () => pullCount,
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function makeZip(
  entries: readonly {
    path: string;
    data?: string | Uint8Array;
    compression?: "stored" | "deflate";
  }[],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let zipError: unknown;
  const zip = new Zip((error, data) => {
    if (error !== null) {
      zipError = error;
      return;
    }
    chunks.push(data);
  });

  for (const entry of entries) {
    const file =
      entry.compression === "deflate"
        ? new ZipDeflate(entry.path)
        : new ZipPassThrough(entry.path);
    zip.add(file);
    const data =
      typeof entry.data === "string"
        ? encoder.encode(entry.data)
        : (entry.data ?? new Uint8Array());
    file.push(data, true);
  }
  zip.end();
  if (zipError !== undefined) throw zipError;
  return concat(chunks);
}

async function listEntries(
  adapter: ArchiveAdapter,
  bytes: Uint8Array,
): Promise<ArchiveEntryHandle[]> {
  const input = testByteStream(bytes, 37);
  const entries: ArchiveEntryHandle[] = [];
  for await (const entry of adapter.entries(input.byteStream, { listMode: true })) {
    entries.push(entry);
    await entry.skip();
  }
  return entries;
}

async function readText(stream: ByteStream): Promise<string> {
  return new Response(stream.stream).text();
}

async function extractAllFiles(
  adapter: ArchiveAdapter,
  bytes: Uint8Array,
): Promise<Array<{ path: string; body: string }>> {
  const input = testByteStream(bytes, 29);
  const files: Array<{ path: string; body: string }> = [];
  for await (const entry of adapter.entries(input.byteStream, { listMode: true })) {
    if (entry.type !== "file") {
      await entry.skip();
      continue;
    }
    const body = await readText(await entry.open());
    files.push({ path: entry.path, body });
  }
  return files;
}

async function drainArchive(adapter: ArchiveAdapter, bytes: Uint8Array): Promise<void> {
  const input = testByteStream(bytes, 31);
  for await (const entry of adapter.entries(input.byteStream, { listMode: true })) {
    await entry.skip();
  }
}

async function extractOnlyFile(adapter: ArchiveAdapter, bytes: Uint8Array): Promise<string> {
  const input = testByteStream(bytes, 23);
  const iterator = adapter.entries(input.byteStream, { listMode: true })[Symbol.asyncIterator]();
  const entry = await iterator.next();
  if (entry.done) throw new Error("expected an archive entry");
  const text = await readText(await entry.value.open());
  const done = await iterator.next();
  if (!done.done) throw new Error("expected exactly one archive entry");
  return text;
}

function firstZipDataOffset(archive: Uint8Array): number {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const filenameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  return 30 + filenameLength + extraLength;
}

function zipLocalHeaderOffsets(archive: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let offset = 0; offset + 4 <= archive.byteLength; offset += 1) {
    if (
      archive[offset] === 0x50 &&
      archive[offset + 1] === 0x4b &&
      archive[offset + 2] === 0x03 &&
      archive[offset + 3] === 0x04
    ) {
      offsets.push(offset);
    }
  }
  return offsets;
}

describe("archive path normalization", () => {
  it.each([
    ["./a", { path: "a", unsafePath: false }],
    ["a//b", { path: "a/b", unsafePath: false }],
    ["a\\b", { path: "a/b", unsafePath: false }],
    ["../file", { path: "../file", unsafePath: true }],
    ["/a/b", { path: "a/b", unsafePath: true }],
    ["C:\\file", { path: "C:/file", unsafePath: true }],
    ["\\\\server\\share", { path: "server/share", unsafePath: true }],
  ])("normalizes %s without hiding whether it was unsafe", (input, expected) => {
    expect(normalizeArchivePath(input)).toMatchObject(expected);
  });
});

describe("ZIP archive adapter", () => {
  it("extracts stored, deflated, and zero-byte files in archive order", async () => {
    const archive = makeZip([
      { path: "z-stored.txt", data: "stored" },
      { path: "a-deflated.txt", data: "deflated", compression: "deflate" },
      { path: "empty.txt" },
    ]);

    await expect(extractAllFiles(new ZipAdapter(), archive)).resolves.toEqual([
      { path: "z-stored.txt", body: "stored" },
      { path: "a-deflated.txt", body: "deflated" },
      { path: "empty.txt", body: "" },
    ]);
  });

  it("counts duplicate normalized paths by occurrence", async () => {
    const archive = makeZip([
      { path: "same.txt", data: "first" },
      { path: "other.txt", data: "middle", compression: "deflate" },
      { path: "same.txt", data: "second" },
    ]);

    const entries = await listEntries(new ZipAdapter(), archive);
    expect(entries.map(({ path, occurrence }) => ({ path, occurrence }))).toEqual([
      { path: "same.txt", occurrence: 1 },
      { path: "other.txt", occurrence: 1 },
      { path: "same.txt", occurrence: 2 },
    ]);
  });

  it("classifies a trailing-slash entry as a directory", async () => {
    const entries = await listEntries(
      new ZipAdapter(),
      makeZip([{ path: "folder/" }, { path: "folder/file.txt", data: "x" }]),
    );

    expect(entries[0]).toMatchObject({ path: "folder", type: "directory" });
  });

  it("requires every yielded entry to be opened or skipped", async () => {
    const input = testByteStream(makeZip([{ path: "one.txt", data: "one" }]));
    const iterator = new ZipAdapter()
      .entries(input.byteStream, { listMode: true })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).rejects.toMatchObject({ code: "ENTRY_ALREADY_CONSUMED" });
    expect(input.abort).toHaveBeenCalled();
  });

  it("rejects a second open or skip on the same entry", async () => {
    const input = testByteStream(makeZip([{ path: "one.txt", data: "one" }]));
    const iterator = new ZipAdapter()
      .entries(input.byteStream, { listMode: true })
      [Symbol.asyncIterator]();
    const result = await iterator.next();
    if (result.done) throw new Error("expected a ZIP entry");

    await result.value.skip();
    await expect(result.value.open()).rejects.toMatchObject({
      code: "ENTRY_ALREADY_CONSUMED",
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("does not advance to the next entry while a large open body is backpressured", async () => {
    const firstBody = new Uint8Array(256 * 1024).fill(97);
    const input = testByteStream(
      makeZip([
        { path: "large.bin", data: firstBody },
        { path: "next.txt", data: "next" },
      ]),
      8 * 1024,
    );
    const iterator = new ZipAdapter()
      .entries(input.byteStream, { listMode: true })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error("expected first ZIP entry");
    const body = await first.value.open();

    let nextSettled = false;
    const nextPromise = iterator.next().then((value) => {
      nextSettled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(nextSettled).toBe(false);

    expect((await new Response(body.stream).arrayBuffer()).byteLength).toBe(firstBody.byteLength);
    const next = await nextPromise;
    if (next.done) throw new Error("expected second ZIP entry");
    await next.value.skip();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("rejects an archive truncated after its last file data", async () => {
    const archive = makeZip([{ path: "one.txt", data: "one", compression: "deflate" }]);
    const withoutCentralDirectory = archive.subarray(0, Math.max(0, archive.byteLength - 22));

    await expect(drainArchive(new ZipAdapter(), withoutCentralDirectory)).rejects.toMatchObject({
      code: "CORRUPT_ARCHIVE",
    });
  });

  it("rejects stored entry data that does not match its CRC", async () => {
    const archive = makeZip([{ path: "crc.txt", data: "original" }]);
    const corrupt = archive.slice();
    const dataOffset = firstZipDataOffset(corrupt);
    corrupt[dataOffset] = (corrupt[dataOffset] ?? 0) ^ 1;

    await expect(extractOnlyFile(new ZipAdapter(), corrupt)).rejects.toMatchObject({
      code: "CORRUPT_ARCHIVE",
    });
  });

  it("reports an unsupported local-entry compression method", async () => {
    const archive = makeZip([{ path: "method.txt", data: "data" }]);
    const unsupported = archive.slice();
    unsupported[8] = 99;
    unsupported[9] = 0;

    await expect(drainArchive(new ZipAdapter(), unsupported)).rejects.toMatchObject({
      code: "UNSUPPORTED_ZIP_METHOD",
      details: { method: 99 },
    });
  });

  it("rejects an encrypted flag on an entry after the first local header", async () => {
    const archive = makeZip([
      { path: "clear.txt", data: "clear" },
      { path: "encrypted.txt", data: "ciphertext" },
    ]);
    const encrypted = archive.slice();
    const secondHeader = zipLocalHeaderOffsets(encrypted)[1];
    if (secondHeader === undefined) throw new Error("expected two ZIP local headers");
    encrypted[secondHeader + 6] = (encrypted[secondHeader + 6] ?? 0) | 1;

    await expect(drainArchive(new ZipAdapter(), encrypted)).rejects.toMatchObject({
      code: "ARCHIVE_ENCRYPTED",
    });
  });
});

describe("TAR archive adapter", () => {
  it("extracts files in archive order and reports duplicate occurrences", async () => {
    const archive = await packTar([
      { header: { name: "same.txt", size: 5 }, body: "first" },
      { header: { name: "empty.txt", size: 0 }, body: "" },
      { header: { name: "same.txt", size: 6 }, body: "second" },
    ]);

    const entries = await listEntries(new TarAdapter(), archive);
    expect(entries.map(({ path, occurrence, size }) => ({ path, occurrence, size }))).toEqual([
      { path: "same.txt", occurrence: 1, size: 5 },
      { path: "empty.txt", occurrence: 1, size: 0 },
      { path: "same.txt", occurrence: 2, size: 6 },
    ]);
    await expect(extractAllFiles(new TarAdapter(), archive)).resolves.toEqual([
      { path: "same.txt", body: "first" },
      { path: "empty.txt", body: "" },
      { path: "same.txt", body: "second" },
    ]);
  });

  it("preserves long PAX paths and classifies directory, symlink, and hardlink metadata", async () => {
    const longPath = `${"long/".repeat(30)}file.txt`;
    const entries: TarEntry[] = [
      { header: { name: longPath, size: 1 }, body: "x" },
      { header: { name: "folder/", size: 0, type: "directory" } },
      {
        header: { name: "shortcut", size: 0, type: "symlink", linkname: "target" },
      },
      { header: { name: "hard", size: 0, type: "link", linkname: "target" } },
      { header: { name: "../unsafe.txt", size: 1 }, body: "u" },
    ];

    const listed = await listEntries(new TarAdapter(), await packTar(entries));
    expect(listed.map(({ path, type, unsafePath }) => ({ path, type, unsafePath }))).toEqual([
      { path: longPath, type: "file", unsafePath: false },
      { path: "folder", type: "directory", unsafePath: false },
      { path: "shortcut", type: "symlink", unsafePath: false },
      { path: "hard", type: "hardlink", unsafePath: false },
      { path: "../unsafe.txt", type: "file", unsafePath: true },
    ]);
  });

  it("requires every yielded entry to be opened or skipped", async () => {
    const archive = await packTar([{ header: { name: "one.txt", size: 3 }, body: "one" }]);
    const input = testByteStream(archive);
    const iterator = new TarAdapter()
      .entries(input.byteStream, { listMode: true })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).rejects.toMatchObject({ code: "ENTRY_ALREADY_CONSUMED" });
    expect(input.abort).toHaveBeenCalled();
  });

  it("does not advance until an opened body is fully consumed", async () => {
    const archive = await packTar([
      { header: { name: "one.txt", size: 3 }, body: "one" },
      { header: { name: "two.txt", size: 3 }, body: "two" },
    ]);
    const input = testByteStream(archive, 71);
    const iterator = new TarAdapter()
      .entries(input.byteStream, { listMode: true })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error("expected first TAR entry");
    const body = await first.value.open();

    let nextSettled = false;
    const nextPromise = iterator.next().then((value) => {
      nextSettled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(nextSettled).toBe(false);

    await expect(readText(body)).resolves.toBe("one");
    const second = await nextPromise;
    if (second.done) throw new Error("expected second TAR entry");
    await second.value.skip();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("rejects a header with an invalid checksum", async () => {
    const archive = await packTar([
      { header: { name: "checksum.txt", size: 4 }, body: "data" },
    ]);
    const corrupt = archive.slice();
    corrupt[0] = (corrupt[0] ?? 0) ^ 1;

    await expect(drainArchive(new TarAdapter(), corrupt)).rejects.toMatchObject({
      code: "CORRUPT_ARCHIVE",
    });
  });

  it("rejects a file body truncated before its declared size", async () => {
    const archive = await packTar([
      { header: { name: "truncated.txt", size: 600 }, body: new Uint8Array(600) },
    ]);
    const truncated = archive.subarray(0, 512 + 100);

    await expect(drainArchive(new TarAdapter(), truncated)).rejects.toMatchObject({
      code: "CORRUPT_ARCHIVE",
    });
  });
});
