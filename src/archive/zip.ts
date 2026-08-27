import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  type AsyncFlateStreamHandler,
  type UnzipDecoder,
  type UnzipFile,
} from "fflate";
import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";
import { contentTypeForPath } from "../util/mime";
import { normalizeArchivePath } from "../util/path";
import type {
  ArchiveAdapter,
  ArchiveContext,
  ArchiveEntryHandle,
  ArchiveEntryStream,
} from "./types";

const ZIP_INPUT_BATCH = 4 * 1024;
const ZIP_CALLBACK_BURST = LIMITS.decoderBurstBytes;
const ZIP_TAIL_BYTES = 132 * 1024;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_CENTRAL_HEADER_TAIL = ZIP_CENTRAL_HEADER_BYTES - 1;
const ZIP_CENTRAL_CANDIDATE_LIMIT = LIMITS.listEntries * 2;
const EMPTY = new Uint8Array();
const CRC32_TABLE = new Uint32Array(256);
for (let value = 0; value < CRC32_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1;
  }
  CRC32_TABLE[value] = crc >>> 0;
}

function littleEndianUint64(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 8 > bytes.byteLength) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  const value = view.getBigUint64(0, true);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function hasCentralHeaderSignature(bytes: Uint8Array, offset: number): boolean {
  return (
    bytes[offset] === 0x50 &&
    bytes[offset + 1] === 0x4b &&
    bytes[offset + 2] === 0x01 &&
    bytes[offset + 3] === 0x02
  );
}

/**
 * Records only the absolute start/end offsets of plausible central-directory
 * file headers. Payload bytes are never retained. At EOF, the EOCD-selected
 * start is walked through exact adjacent records, so signatures inside entry
 * data cannot validate a contradictory directory range.
 */
class ZipCentralDirectoryScanner {
  private headerTail = EMPTY;
  private sourceBytes = 0;
  private candidateHead = 0;
  private candidateCount = 0;
  private readonly candidateStarts: number[] = [];
  private readonly candidateEnds: number[] = [];

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;

    if (this.headerTail.byteLength > 0) {
      const prefixLength = Math.min(chunk.byteLength, ZIP_CENTRAL_HEADER_TAIL);
      const bridge = new Uint8Array(this.headerTail.byteLength + prefixLength);
      bridge.set(this.headerTail);
      bridge.set(chunk.subarray(0, prefixLength), this.headerTail.byteLength);
      const bridgeAbsolute = this.sourceBytes - this.headerTail.byteLength;
      const lastStart = Math.min(
        this.headerTail.byteLength - 1,
        bridge.byteLength - ZIP_CENTRAL_HEADER_BYTES,
      );
      this.scanHeaders(bridge, bridgeAbsolute, lastStart);
    }

    this.scanHeaders(
      chunk,
      this.sourceBytes,
      chunk.byteLength - ZIP_CENTRAL_HEADER_BYTES,
    );
    this.sourceBytes += chunk.byteLength;

    if (chunk.byteLength >= ZIP_CENTRAL_HEADER_TAIL) {
      this.headerTail = chunk.slice(-ZIP_CENTRAL_HEADER_TAIL);
    } else {
      const keep = Math.min(
        this.headerTail.byteLength,
        ZIP_CENTRAL_HEADER_TAIL - chunk.byteLength,
      );
      const nextTail = new Uint8Array(keep + chunk.byteLength);
      nextTail.set(this.headerTail.subarray(this.headerTail.byteLength - keep));
      nextTail.set(chunk, keep);
      this.headerTail = nextTail;
    }
  }

  walkRecords(start: number, count: number): number | undefined {
    let position = start;
    let candidate = this.lowerBound(position);
    for (let record = 0; record < count; record += 1) {
      while (
        candidate < this.candidateCount &&
        this.candidateStartAt(candidate) < position
      ) {
        candidate += 1;
      }
      if (
        candidate >= this.candidateCount ||
        this.candidateStartAt(candidate) !== position
      ) {
        return undefined;
      }
      const end = this.candidateEnds[
        (this.candidateHead + candidate) % ZIP_CENTRAL_CANDIDATE_LIMIT
      ];
      if (end === undefined || end <= position || end > this.sourceBytes) return undefined;
      position = end;
      candidate += 1;
    }
    return position;
  }

  private scanHeaders(bytes: Uint8Array, absoluteOffset: number, lastStart: number): void {
    for (
      let offset = bytes.indexOf(0x50);
      offset >= 0 && offset <= lastStart;
      offset = bytes.indexOf(0x50, offset + 1)
    ) {
      if (!hasCentralHeaderSignature(bytes, offset)) continue;
      const header = new DataView(
        bytes.buffer,
        bytes.byteOffset + offset,
        ZIP_CENTRAL_HEADER_BYTES,
      );
      const method = header.getUint16(10, true);
      const diskStart = header.getUint16(34, true);
      const localHeaderOffset = header.getUint32(42, true);
      const start = absoluteOffset + offset;
      if (
        (method !== 0 && method !== 8) ||
        (diskStart !== 0 && diskStart !== 0xffff) ||
        (localHeaderOffset !== 0xffff_ffff && localHeaderOffset >= start)
      ) {
        continue;
      }
      const filenameLength = header.getUint16(28, true);
      const extraLength = header.getUint16(30, true);
      const commentLength = header.getUint16(32, true);
      const end =
        start + ZIP_CENTRAL_HEADER_BYTES + filenameLength + extraLength + commentLength;
      if (this.candidateCount < ZIP_CENTRAL_CANDIDATE_LIMIT) {
        const candidate =
          (this.candidateHead + this.candidateCount) % ZIP_CENTRAL_CANDIDATE_LIMIT;
        this.candidateStarts[candidate] = start;
        this.candidateEnds[candidate] = end;
        this.candidateCount += 1;
      } else {
        this.candidateStarts[this.candidateHead] = start;
        this.candidateEnds[this.candidateHead] = end;
        this.candidateHead = (this.candidateHead + 1) % ZIP_CENTRAL_CANDIDATE_LIMIT;
      }
    }
  }

  private lowerBound(target: number): number {
    let low = 0;
    let high = this.candidateCount;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.candidateStartAt(middle) < target) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  private candidateStartAt(logicalIndex: number): number {
    return (
      this.candidateStarts[
        (this.candidateHead + logicalIndex) % ZIP_CENTRAL_CANDIDATE_LIMIT
      ] ?? Number.POSITIVE_INFINITY
    );
  }
}

function isCentralDirectoryDigitalSignature(
  tail: Uint8Array,
  tailAbsolute: number,
  start: number,
  end: number,
): boolean {
  const relative = start - tailAbsolute;
  if (relative < 0 || relative + 6 > tail.byteLength) return false;
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  return (
    view.getUint32(relative, true) === 0x05054b50 &&
    start + 6 + view.getUint16(relative + 4, true) === end
  );
}

function validateZipTail(
  tail: Uint8Array,
  sourceBytes: number,
  localEntries: number,
  centralScanner: ZipCentralDirectoryScanner,
): void {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === tail.byteLength) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP end-of-central-directory record is missing.", {
      stage: "archive-read",
    });
  }

  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  let totalEntries = view.getUint16(eocd + 10, true);
  let centralSize = view.getUint32(eocd + 12, true);
  let centralOffset = view.getUint32(eocd + 16, true);
  const tailAbsolute = sourceBytes - tail.byteLength;
  const eocdAbsolute = tailAbsolute + eocd;
  let directoryTrailerStart = eocdAbsolute;
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new GatewayError("UNSUPPORTED_FORMAT", "Multi-disk ZIP archives are unsupported.", {
      stage: "archive-read",
      details: { format: "zip" },
    });
  }

  if (totalEntries === 0xffff || centralSize === 0xffff_ffff || centralOffset === 0xffff_ffff) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) {
      throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP64 locator is missing.", {
        stage: "archive-read",
      });
    }
    if (view.getUint32(locator + 4, true) !== 0 || view.getUint32(locator + 16, true) !== 1) {
      throw new GatewayError("UNSUPPORTED_FORMAT", "Multi-disk ZIP64 archives are unsupported.", {
        stage: "archive-read",
        details: { format: "zip64" },
      });
    }
    const zip64Absolute = littleEndianUint64(tail, locator + 8);
    if (zip64Absolute === undefined) {
      throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP64 record offset is invalid.", {
        stage: "archive-read",
      });
    }
    const zip64 = zip64Absolute - tailAbsolute;
    if (zip64 < 0 || zip64 + 56 > tail.byteLength || view.getUint32(zip64, true) !== 0x06064b50) {
      throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP64 end record is missing.", {
        stage: "archive-read",
      });
    }
    const zip64RecordSize = littleEndianUint64(tail, zip64 + 4);
    if (
      zip64RecordSize === undefined ||
      zip64RecordSize < 44 ||
      !Number.isSafeInteger(zip64Absolute + 12 + zip64RecordSize) ||
      zip64Absolute + 12 + zip64RecordSize !== tailAbsolute + locator
    ) {
      throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP64 end record is truncated or invalid.", {
        stage: "archive-read",
      });
    }
    const zip64Disk = view.getUint32(zip64 + 16, true);
    const zip64CentralDisk = view.getUint32(zip64 + 20, true);
    const zip64DiskEntries = littleEndianUint64(tail, zip64 + 24);
    const zip64TotalEntries = littleEndianUint64(tail, zip64 + 32);
    const zip64CentralSize = littleEndianUint64(tail, zip64 + 40);
    const zip64CentralOffset = littleEndianUint64(tail, zip64 + 48);
    if (
      zip64Disk !== 0 ||
      zip64CentralDisk !== 0 ||
      zip64DiskEntries === undefined ||
      zip64TotalEntries === undefined ||
      zip64DiskEntries !== zip64TotalEntries ||
      zip64CentralSize === undefined ||
      zip64CentralOffset === undefined
    ) {
      throw new GatewayError("UNSUPPORTED_FORMAT", "The ZIP64 layout is unsupported.", {
        stage: "archive-read",
        details: { format: "zip64" },
      });
    }
    totalEntries = zip64TotalEntries;
    centralSize = zip64CentralSize;
    centralOffset = zip64CentralOffset;
    directoryTrailerStart = zip64Absolute;
  }

  const declaredCentralEnd = centralOffset + centralSize;
  if (
    !Number.isSafeInteger(declaredCentralEnd) ||
    totalEntries !== localEntries ||
    declaredCentralEnd > directoryTrailerStart ||
    (totalEntries === 0 && centralSize !== 0)
  ) {
    throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP central directory is inconsistent.", {
      stage: "archive-read",
      details: { localEntries, centralEntries: totalEntries },
    });
  }

  const recordsEnd = centralScanner.walkRecords(centralOffset, totalEntries);
  if (recordsEnd === undefined || recordsEnd > declaredCentralEnd) {
    throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP central directory records are malformed.", {
      stage: "archive-read",
      details: { centralOffset, centralSize, centralEntries: totalEntries },
    });
  }

  const recordsEndAtDeclaredEnd = recordsEnd === declaredCentralEnd;
  const signatureIncludedInSize =
    recordsEnd < declaredCentralEnd &&
    isCentralDirectoryDigitalSignature(
      tail,
      tailAbsolute,
      recordsEnd,
      declaredCentralEnd,
    );
  if (!recordsEndAtDeclaredEnd && !signatureIncludedInSize) {
    throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP central directory size is inconsistent.", {
      stage: "archive-read",
      details: { centralOffset, centralSize, recordsEnd },
    });
  }

  if (
    declaredCentralEnd !== directoryTrailerStart &&
    !isCentralDirectoryDigitalSignature(
      tail,
      tailAbsolute,
      declaredCentralEnd,
      directoryTrailerStart,
    )
  ) {
    throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP central directory trailer is invalid.", {
      stage: "archive-read",
    });
  }
}

class DiscardStored implements UnzipDecoder {
  static compression = 0;
  ondata: AsyncFlateStreamHandler = () => undefined;
  push(_chunk: Uint8Array, final: boolean): void {
    if (final) this.ondata(null, EMPTY, true);
  }
}

class DiscardDeflate implements UnzipDecoder {
  static compression = 8;
  ondata: AsyncFlateStreamHandler = () => undefined;
  push(_chunk: Uint8Array, final: boolean): void {
    if (final) this.ondata(null, EMPTY, true);
  }
}

function archiveError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError("CORRUPT_ARCHIVE", "The ZIP archive is corrupt or truncated.", {
    stage: "archive-read",
    cause: error,
  });
}

export class ZipAdapter implements ArchiveAdapter {
  entries(input: ByteStream, context: ArchiveContext): ArchiveEntryStream {
    return this.iterate(input, context);
  }

  private async *iterate(
    input: ByteStream,
    context: ArchiveContext,
  ): AsyncGenerator<ArchiveEntryHandle> {
    const pendingFiles: UnzipFile[] = [];
    const unzip = new Unzip((file) => pendingFiles.push(file));
    unzip.register(UnzipInflate);
    const reader = input.stream.getReader();
    const occurrences = new Map<string, number>();
    const centralScanner = new ZipCentralDirectoryScanner();
    let sourceChunk: Uint8Array | undefined;
    let sourceOffset = 0;
    let sourceFinal = false;
    let sourceBytes = 0;
    let tail = EMPTY;
    let index = 0;
    let completed = false;

    const pushNextInput = async (): Promise<void> => {
      if (sourceFinal) return;
      while (sourceChunk === undefined || sourceOffset >= sourceChunk.byteLength) {
        const result = await reader.read();
        if (result.done) {
          sourceFinal = true;
          try {
            unzip.push(EMPTY, true);
          } catch (error) {
            throw archiveError(error);
          }
          return;
        }
        if (result.value.byteLength === 0) continue;
        centralScanner.push(result.value);
        sourceBytes += result.value.byteLength;
        if (result.value.byteLength >= ZIP_TAIL_BYTES) {
          tail = result.value.slice(-ZIP_TAIL_BYTES);
        } else {
          const keep = Math.min(tail.byteLength, ZIP_TAIL_BYTES - result.value.byteLength);
          const nextTail = new Uint8Array(keep + result.value.byteLength);
          nextTail.set(tail.subarray(tail.byteLength - keep));
          nextTail.set(result.value, keep);
          tail = nextTail;
        }
        sourceChunk = result.value;
        sourceOffset = 0;
      }

      const end = Math.min(sourceOffset + ZIP_INPUT_BATCH, sourceChunk.byteLength);
      const slice = sourceChunk.subarray(sourceOffset, end);
      sourceOffset = end;
      try {
        unzip.push(slice, false);
      } catch (error) {
        throw archiveError(error);
      }
    };

    try {
      for (;;) {
        while (pendingFiles.length === 0 && !sourceFinal) await pushNextInput();
        const file = pendingFiles.shift();
        if (file === undefined) break;
        index += 1;

        const normalized = normalizeArchivePath(file.name);
        if (new TextEncoder().encode(normalized.path).byteLength > LIMITS.pathBytes) {
          input.abort("archive path limit exceeded");
          throw new GatewayError("ENTRY_LIMIT_REACHED", "An archive path is too long.", {
            stage: "archive-read",
            details: { index, maxBytes: LIMITS.pathBytes },
          });
        }
        const trackOccurrence =
          context.listMode === true || context.occurrencePaths?.has(normalized.path) === true;
        const occurrence = trackOccurrence
          ? (occurrences.get(normalized.path) ?? 0) + 1
          : 1;
        if (trackOccurrence) occurrences.set(normalized.path, occurrence);

        let state: "discovered" | "opened" | "skipped" = "discovered";
        let processing: Promise<void> | undefined;
        let processingError: unknown;
        const type = file.name.endsWith("/") ? "directory" : "file";

        const processFile = (
          writable: WritableStream<Uint8Array> | undefined,
        ): Promise<void> => {
          const run = async () => {
            if (file.encrypted) {
              file.terminate();
              throw new GatewayError("ARCHIVE_ENCRYPTED", "Encrypted ZIP entries are unsupported.", {
                stage: "archive-read",
                details: { path: normalized.path },
              });
            }
            if (file.compression !== 0 && file.compression !== 8) {
              file.terminate();
              throw new GatewayError(
                "UNSUPPORTED_ZIP_METHOD",
                "The ZIP compression method is unsupported.",
                {
                  stage: "archive-read",
                  details: { path: normalized.path, method: file.compression },
                },
              );
            }

            if (writable === undefined) {
              unzip.register(file.compression === 0 ? DiscardStored : DiscardDeflate);
            } else {
              unzip.register(file.compression === 0 ? UnzipPassThrough : UnzipInflate);
            }

            const writer = writable?.getWriter();
            let callbackError: unknown;
            let final = false;
            let outputBytes = 0;
            let crcState = 0xffff_ffff;
            let burstBytes = 0;
            const burst: Uint8Array[] = [];

            file.ondata = (error, data, isFinal) => {
              if (error !== null) callbackError = error;
              if (data !== null && writable !== undefined) {
                for (const byte of data) {
                  crcState =
                    (CRC32_TABLE[(crcState ^ byte) & 0xff] ?? 0) ^ (crcState >>> 8);
                }
              }
              if (
                isFinal &&
                writable !== undefined &&
                file.crc !== undefined &&
                ((crcState ^ 0xffff_ffff) >>> 0) !== file.crc
              ) {
                callbackError = new GatewayError("CORRUPT_ARCHIVE", "A ZIP entry CRC is invalid.", {
                  stage: "archive-read",
                  details: { path: normalized.path },
                });
              }
              if (data !== null && data.byteLength > 0 && writer !== undefined) {
                outputBytes += data.byteLength;
                burstBytes += data.byteLength;
                if (outputBytes > LIMITS.entryOutputBytes) {
                  callbackError = new GatewayError(
                    "ENTRY_OUTPUT_LIMIT",
                    "The extracted entry exceeded its output limit.",
                    { stage: "archive-read", details: { path: normalized.path } },
                  );
                  file.terminate();
                } else if (burstBytes > ZIP_CALLBACK_BURST) {
                  callbackError = new GatewayError(
                    "OUTPUT_LIMIT_EXCEEDED",
                    "A decoder callback exceeded the bounded burst limit.",
                    {
                      stage: "archive-read",
                      details: { maxBytes: ZIP_CALLBACK_BURST },
                    },
                  );
                  file.terminate();
                } else {
                  burst.push(data);
                }
              }
              final = isFinal;
            };

            const drainBurst = async () => {
              if (callbackError !== undefined) throw archiveError(callbackError);
              for (const chunk of burst) await writer?.write(chunk);
              burst.length = 0;
              burstBytes = 0;
            };

            try {
              file.start();
              await drainBurst();
              while (!final) {
                if (sourceFinal) {
                  throw new GatewayError("CORRUPT_ARCHIVE", "A ZIP entry is truncated.", {
                    stage: "archive-read",
                    details: { path: normalized.path },
                  });
                }
                await pushNextInput();
                await drainBurst();
              }
              await writer?.close();
            } catch (error) {
              input.abort(error);
              await writer?.abort(error).catch(() => undefined);
              throw archiveError(error);
            } finally {
              writer?.releaseLock();
            }
          };

          const task = run().catch((error: unknown) => {
            processingError = error;
          });
          processing = task;
          return task;
        };

        const handle: ArchiveEntryHandle = {
          index,
          path: normalized.path,
          ...(normalized.rawPath === undefined ? {} : { rawPath: normalized.rawPath }),
          occurrence,
          unsafePath: normalized.unsafePath,
          type,
          ...(file.originalSize === undefined ? {} : { size: file.originalSize }),
          ...(file.size === undefined ? {} : { compressedSize: file.size }),
          compressionMethod: file.compression,
          contentType: contentTypeForPath(normalized.path),
          async open() {
            if (state !== "discovered") {
              throw new GatewayError("ENTRY_ALREADY_CONSUMED", "The entry was already consumed.", {
                stage: "archive-entry",
                details: { path: normalized.path, occurrence },
              });
            }
            state = "opened";
            if (type !== "file") {
              await processFile(undefined);
              throw new GatewayError("ENTRY_TYPE_UNSUPPORTED", "Only regular files can be opened.", {
                stage: "archive-entry",
                details: { path: normalized.path, type },
              });
            }

            const transform = new TransformStream<Uint8Array, Uint8Array>(
              undefined,
              new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
              new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
            );
            void processFile(transform.writable);
            return {
              stream: transform.readable,
              ...(file.originalSize === undefined
                ? {}
                : { knownLength: file.originalSize }),
              contentType: contentTypeForPath(normalized.path),
              filename: normalized.path.split("/").at(-1) || "entry",
              abort(reason?: unknown) {
                file.terminate();
                input.abort(reason);
              },
            };
          },
          async skip() {
            if (state !== "discovered") {
              throw new GatewayError("ENTRY_ALREADY_CONSUMED", "The entry was already consumed.", {
                stage: "archive-entry",
                details: { path: normalized.path, occurrence },
              });
            }
            state = "skipped";
            await processFile(undefined);
            if (processingError !== undefined) throw archiveError(processingError);
          },
        };

        yield handle;
        if (state === "discovered") {
          input.abort("entry was not consumed");
          throw new GatewayError(
            "ENTRY_ALREADY_CONSUMED",
            "Every archive entry must be opened or skipped before advancing.",
            { stage: "archive-entry", details: { path: normalized.path } },
          );
        }
        await processing;
        if (processingError !== undefined) throw archiveError(processingError);
      }
      validateZipTail(tail, sourceBytes, index, centralScanner);
      completed = true;
    } finally {
      if (!completed) input.abort("ZIP iteration stopped");
      await reader.cancel("ZIP iteration complete").catch(() => undefined);
      reader.releaseLock();
    }
  }
}
