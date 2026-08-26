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
const ZIP_CALLBACK_BURST = 16 * 1024 * 1024;
const ZIP_TAIL_BYTES = 128 * 1024;
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

function validateZipTail(tail: Uint8Array, sourceBytes: number, localEntries: number): void {
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
    const tailAbsolute = sourceBytes - tail.byteLength;
    const zip64 = zip64Absolute - tailAbsolute;
    if (zip64 < 0 || zip64 + 56 > tail.byteLength || view.getUint32(zip64, true) !== 0x06064b50) {
      throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP64 end record is missing.", {
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
  }

  const eocdAbsolute = sourceBytes - tail.byteLength + eocd;
  if (
    totalEntries !== localEntries ||
    centralOffset + centralSize > eocdAbsolute ||
    (totalEntries === 0 && centralSize !== 0)
  ) {
    throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP central directory is inconsistent.", {
      stage: "archive-read",
      details: { localEntries, centralEntries: totalEntries },
    });
  }
  const centralInTail = centralOffset - (sourceBytes - tail.byteLength);
  if (
    totalEntries > 0 &&
    centralInTail >= 0 &&
    centralInTail + 4 <= tail.byteLength &&
    view.getUint32(centralInTail, true) !== 0x02014b50
  ) {
    throw new GatewayError("CORRUPT_ARCHIVE", "The ZIP central directory is missing.", {
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
      validateZipTail(tail, sourceBytes, index);
      completed = true;
    } finally {
      if (!completed) input.abort("ZIP iteration stopped");
      await reader.cancel("ZIP iteration complete").catch(() => undefined);
      reader.releaseLock();
    }
  }
}
