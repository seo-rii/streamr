import { Unzip as WorkerUnzip } from "fflate";
import {
  Unzip,
  UnzipInflate,
  Zip,
  ZipDeflate,
  ZipPassThrough,
  zipSync,
  type UnzipFile,
  type Zippable,
} from "fflate/browser";
import { describe, expect, it } from "vitest";

const INPUT_CHUNK_BYTES = 4 * 1024;

interface FixtureEntry {
  name: string;
  bytes: Uint8Array;
  compression: "stored" | "deflate";
}

function payload(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed + 1;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function makeZip(entries: readonly FixtureEntry[], descriptors: boolean): Uint8Array {
  if (!descriptors) {
    const input: Zippable = {};
    for (const entry of entries) {
      input[entry.name] = [entry.bytes, { level: entry.compression === "stored" ? 0 : 6 }];
    }
    return zipSync(input);
  }

  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error !== null) throw error;
    chunks.push(chunk);
  });
  for (const entry of entries) {
    const file = entry.compression === "stored"
      ? new ZipPassThrough(entry.name)
      : new ZipDeflate(entry.name);
    zip.add(file);
    file.push(entry.bytes, true);
  }
  zip.end();
  return concat(chunks);
}

function verifyFile(file: UnzipFile, entry: FixtureEntry, completed: () => void): void {
  let offset = 0;
  let finished = false;
  file.ondata = (error, bytes, final) => {
    expect(error).toBeNull();
    expect(finished, `${file.name} emitted data after its final callback`).toBe(false);
    expect(bytes.byteLength).toBeLessThanOrEqual(entry.bytes.byteLength - offset);
    expect(
      bytes.every((byte, index) => byte === entry.bytes[offset + index]),
      `${file.name} payload at offset ${offset}`,
    ).toBe(true);
    offset += bytes.byteLength;
    if (final) {
      expect(offset, `${file.name} final payload length`).toBe(entry.bytes.byteLength);
      finished = true;
      completed();
    }
  };
}

function cacheSnapshot(unzip: Unzip): { slots: number; chunks: number; backingBytes: number } {
  // This diagnostic intentionally covers the private cache in the pinned,
  // patched browser build. It measures reachable references, not GC or RSS.
  const cache = (unzip as unknown as { k: Uint8Array[][] }).k;
  const buffers = new Set<ArrayBufferLike>();
  let chunks = 0;
  let backingBytes = 0;
  for (const slot of cache) {
    for (const chunk of slot) {
      chunks += 1;
      if (!buffers.has(chunk.buffer)) {
        buffers.add(chunk.buffer);
        backingBytes += chunk.buffer.byteLength;
      }
    }
  }
  return { slots: cache.length, chunks, backingBytes };
}

function pushChunks(
  unzip: Unzip,
  archive: Uint8Array,
  sizes: readonly number[],
  afterPush: () => void = () => {},
): void {
  let offset = 0;
  let index = 0;
  while (offset < archive.byteLength) {
    const size = sizes[index % sizes.length];
    if (size === undefined || size <= 0) throw new Error("expected positive chunk sizes");
    const end = Math.min(offset + size, archive.byteLength);
    // Independent network-sized buffers keep the diagnostic from counting a
    // tiny view as an artificial reference to the entire fixture archive.
    unzip.push(archive.slice(offset, end), false);
    afterPush();
    offset = end;
    index += 1;
  }
  unzip.push(new Uint8Array(), true);
  afterPush();
}

describe("streaming ZIP cache lifetime", () => {
  it("exercises the same browser Unzip export as the Worker", () => {
    expect(WorkerUnzip).toBe(Unzip);
  });

  it.each(["stored", "deflate"] as const)(
    "releases replayed %s prefixes and bounds cache slots across completed files",
    (compression) => {
      const entries: FixtureEntry[] = Array.from({ length: 384 }, (_value, index) => ({
        name: `entry-${index}.bin`,
        bytes: payload(index, 1_400 + (index % 5) * 101),
        compression,
      }));
      const expected = new Map(entries.map((entry) => [entry.name, entry]));
      const pending: UnzipFile[] = [];
      let completed = 0;
      let maxSlots = 0;
      let maxChunks = 0;
      let maxBackingBytes = 0;
      const unzip = new Unzip((file) => {
        const entry = expected.get(file.name);
        if (entry === undefined) throw new Error(`unexpected ZIP file ${file.name}`);
        verifyFile(file, entry, () => { completed += 1; });
        pending.push(file);
      });
      unzip.register(UnzipInflate);

      pushChunks(unzip, makeZip(entries, true), [INPUT_CHUNK_BYTES], () => {
        // Like the adapter, discover files inside push(), then start them
        // after that bounded input batch returns to its caller.
        for (const file of pending.splice(0)) file.start();
        const snapshot = cacheSnapshot(unzip);
        maxSlots = Math.max(maxSlots, snapshot.slots);
        maxChunks = Math.max(maxChunks, snapshot.chunks);
        maxBackingBytes = Math.max(maxBackingBytes, snapshot.backingBytes);
      });

      expect(completed).toBe(entries.length);
      expect.soft(maxSlots).toBeLessThanOrEqual(2);
      expect.soft(maxChunks).toBe(0);
      expect.soft(maxBackingBytes).toBe(0);
    },
  );

  it.each([false, true])(
    "preserves deferred files started out of order after EOF (descriptors: %s)",
    (descriptors) => {
      const entries: FixtureEntry[] = Array.from({ length: 12 }, (_value, index) => ({
        name: `deferred-${index}.bin`,
        bytes: payload(index + 50, index % 4 === 0 ? 0 : 5_000 + index * 97),
        compression: index % 2 === 0 ? "stored" : "deflate",
      }));
      const handles: UnzipFile[] = [];
      const unzip = new Unzip((file) => { handles.push(file); });
      unzip.register(UnzipInflate);
      pushChunks(unzip, makeZip(entries, descriptors), [1, 2, 3, 5, 7, 11, INPUT_CHUNK_BYTES]);

      expect(handles.map((file) => file.name)).toEqual(entries.map((entry) => entry.name));
      let completed = 0;
      for (const index of [11, 0, 6, 3, 9, 1, 10, 5, 2, 8, 4, 7]) {
        const file = handles[index];
        const entry = entries[index];
        if (file === undefined || entry === undefined) throw new Error("missing deferred file");
        verifyFile(file, entry, () => { completed += 1; });
        file.start();
      }
      expect(completed).toBe(entries.length);
      const snapshot = cacheSnapshot(unzip);
      expect(snapshot.slots).toBeLessThanOrEqual(2);
      expect(snapshot.chunks).toBe(0);
      expect(snapshot.backingBytes).toBe(0);
    },
  );

  it.each([false, true])(
    "rejects repeated starts without replaying output (descriptors: %s)",
    (descriptors) => {
      const entries: FixtureEntry[] = [
        { name: "stored", bytes: payload(200, 5_000), compression: "stored" },
        { name: "deflate", bytes: payload(201, 7_000), compression: "deflate" },
        { name: "empty", bytes: new Uint8Array(), compression: "stored" },
      ];
      const handles: UnzipFile[] = [];
      const unzip = new Unzip((file) => { handles.push(file); });
      unzip.register(UnzipInflate);
      pushChunks(unzip, makeZip(entries, descriptors), [INPUT_CHUNK_BYTES]);

      let completed = 0;
      for (let index = 0; index < entries.length; index += 1) {
        const file = handles[index];
        const entry = entries[index];
        if (file === undefined || entry === undefined) throw new Error("missing ZIP file");
        expect(() => file.start()).toThrowError(expect.objectContaining({ code: 5 }));
        verifyFile(file, entry, () => { completed += 1; });
        file.start();
        expect(() => file.start()).toThrowError(expect.objectContaining({
          code: 4,
          message: "file already started",
        }));
      }
      expect(completed).toBe(entries.length);
    },
  );

  it.each([false, true])(
    "supports immediate onfile starts with split headers and empty entries (descriptors: %s)",
    (descriptors) => {
      const entries: FixtureEntry[] = [
        { name: "empty-first", bytes: new Uint8Array(), compression: "stored" },
        { name: "stored", bytes: payload(100, 12_001), compression: "stored" },
        { name: "empty-deflate", bytes: new Uint8Array(), compression: "deflate" },
        { name: "deflate", bytes: payload(101, 9_013), compression: "deflate" },
        { name: "empty-last", bytes: new Uint8Array(), compression: "stored" },
      ];
      const expected = new Map(entries.map((entry) => [entry.name, entry]));
      const discovered: string[] = [];
      let completed = 0;
      const unzip = new Unzip((file) => {
        const entry = expected.get(file.name);
        if (entry === undefined) throw new Error(`unexpected ZIP file ${file.name}`);
        discovered.push(file.name);
        verifyFile(file, entry, () => { completed += 1; });
        file.start();
      });
      unzip.register(UnzipInflate);
      pushChunks(unzip, makeZip(entries, descriptors), [1, 2, 3, 5, 7, 11]);

      expect(discovered).toEqual(entries.map((entry) => entry.name));
      expect(completed).toBe(entries.length);
    },
  );

  it("accepts an empty archive without retaining input in the file cache", () => {
    let discovered = 0;
    const unzip = new Unzip(() => { discovered += 1; });
    pushChunks(unzip, zipSync({}), [1, 2, 3]);

    expect(discovered).toBe(0);
    expect(cacheSnapshot(unzip)).toEqual({ slots: 0, chunks: 0, backingBytes: 0 });
  });
});
