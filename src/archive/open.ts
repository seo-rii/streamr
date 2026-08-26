import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";
import { wrapCancellableStream } from "../streams/byte-stream";
import { peekByteStream } from "../streams/peek";
import {
  detectFormat,
  rejectUnsupportedArchiveFormat,
  type DetectionHints,
  type DetectionResult,
  zipIsEncrypted,
} from "./detect";
import { decompressBzip2 } from "./bzip2";
import { decompressGzip } from "./gzip";
import { TarAdapter } from "./tar";
import type {
  ArchiveAdapter,
  ArchiveContext,
  ArchiveEntryHandle,
  ArchiveEntryStream,
  OpenedArchive,
} from "./types";
import { ZipAdapter } from "./zip";
import { decompressXz } from "./xz";
import { decompressZstd } from "./zstd";

export interface ResolvedResource {
  detection: Omit<DetectionResult, "format"> & { format: string };
  byteStream: ByteStream;
  adapter?: ArchiveAdapter;
  virtualPayload?: boolean;
  prefixBytesRead: number;
}

function virtualPayloadEntries(input: ByteStream): ArchiveEntryStream {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<ArchiveEntryHandle> {
      let state: "discovered" | "opened" | "skipped" = "discovered";
      let resolveCompletion: () => void = () => undefined;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const handle: ArchiveEntryHandle = {
        index: 1,
        path: "@payload",
        occurrence: 1,
        unsafePath: false,
        type: "file",
        contentType: "application/octet-stream",
        compressionMethod: "decompressed",
        async open() {
          if (state !== "discovered") {
            throw new GatewayError("ENTRY_ALREADY_CONSUMED", "The entry was already consumed.", {
              stage: "archive-entry",
              details: { path: "@payload", occurrence: 1 },
            });
          }
          state = "opened";
          return {
            stream: wrapCancellableStream(input.stream, input.abort, resolveCompletion),
            contentType: "application/octet-stream",
            filename: "payload",
            abort: input.abort,
          };
        },
        async skip() {
          if (state !== "discovered") {
            throw new GatewayError("ENTRY_ALREADY_CONSUMED", "The entry was already consumed.", {
              stage: "archive-entry",
              details: { path: "@payload", occurrence: 1 },
            });
          }
          state = "skipped";
          await input.stream.cancel("payload skipped");
          resolveCompletion();
        },
      };

      yield handle;
      if (state === "discovered") {
        input.abort("entry was not consumed");
        throw new GatewayError(
          "ENTRY_ALREADY_CONSUMED",
          "Every archive entry must be opened or skipped before advancing.",
          { stage: "archive-entry", details: { path: "@payload" } },
        );
      }
      await completion;
    },
  };
}

function unsupportedCompression(format: string): never {
  throw new GatewayError("UNSUPPORTED_COMPRESSION", "The compression format is unsupported.", {
    stage: "decompress",
    details: { format },
  });
}

export async function resolveResource(
  input: ByteStream,
  hints: DetectionHints = {},
): Promise<ResolvedResource> {
  const outerPeek = await peekByteStream(input, LIMITS.prefixBytes);
  const outer = detectFormat(outerPeek.prefix, hints);

  if (outer.format === "7z" || outer.format === "rar") {
    outerPeek.byteStream.abort("unsupported archive format");
    rejectUnsupportedArchiveFormat(outer.format);
  }
  if (outer.format === "zip" && zipIsEncrypted(outerPeek.prefix)) {
    outerPeek.byteStream.abort("encrypted ZIP archive");
    throw new GatewayError("ARCHIVE_ENCRYPTED", "Encrypted ZIP archives are unsupported.", {
      stage: "archive-detect",
      details: { format: "zip" },
    });
  }
  if (outer.format === "zip") {
    return {
      detection: outer,
      byteStream: outerPeek.byteStream,
      adapter: new ZipAdapter(),
      prefixBytesRead: outerPeek.prefix.byteLength,
    };
  }
  if (outer.format === "tar") {
    return {
      detection: outer,
      byteStream: outerPeek.byteStream,
      adapter: new TarAdapter(),
      prefixBytesRead: outerPeek.prefix.byteLength,
    };
  }
  if (outer.format === "raw") {
    return {
      detection: outer,
      byteStream: outerPeek.byteStream,
      prefixBytesRead: outerPeek.prefix.byteLength,
    };
  }

  let decompressed: ByteStream;
  if (outer.format === "gzip") decompressed = decompressGzip(outerPeek.byteStream);
  else if (outer.format === "bzip2") decompressed = decompressBzip2(outerPeek.byteStream);
  else if (outer.format === "xz") decompressed = decompressXz(outerPeek.byteStream);
  else if (outer.format === "zstd") decompressed = decompressZstd(outerPeek.byteStream);
  else unsupportedCompression(outer.format);

  let innerPeek: Awaited<ReturnType<typeof peekByteStream>>;
  try {
    innerPeek = await peekByteStream(decompressed, LIMITS.prefixBytes);
  } catch (error) {
    decompressed.abort(error);
    throw new GatewayError("CORRUPT_ARCHIVE", "The compressed stream is corrupt or truncated.", {
      stage: "decompress",
      cause: error,
      details: { format: outer.format },
    });
  }
  const inner = detectFormat(innerPeek.prefix);
  if (inner.format === "tar") {
    return {
      detection: {
        kind: "archive",
        format: `tar.${
          outer.format === "gzip"
            ? "gz"
            : outer.format === "bzip2"
              ? "bz2"
              : outer.format === "zstd"
                ? "zst"
                : outer.format
        }`,
        layers: [outer.format, "tar"],
        source: inner.source,
      },
      byteStream: innerPeek.byteStream,
      adapter: new TarAdapter(),
      prefixBytesRead: outerPeek.prefix.byteLength,
    };
  }

  return {
    detection: outer,
    byteStream: innerPeek.byteStream,
    virtualPayload: true,
    prefixBytesRead: outerPeek.prefix.byteLength,
  };
}

export async function openArchive(
  input: ByteStream,
  hints: DetectionHints,
  context: ArchiveContext,
): Promise<OpenedArchive> {
  const resolved = await resolveResource(input, hints);
  if (resolved.adapter === undefined && resolved.virtualPayload !== true) {
    resolved.byteStream.abort("not an archive");
    throw new GatewayError("NOT_AN_ARCHIVE", "The source is not an archive.", {
      stage: "archive-detect",
    });
  }

  return {
    format: resolved.detection.format,
    layers: resolved.detection.layers,
    entries:
      resolved.adapter?.entries(resolved.byteStream, context) ??
      virtualPayloadEntries(resolved.byteStream),
    abort(reason?: unknown) {
      resolved.byteStream.abort(reason);
    },
  };
}
