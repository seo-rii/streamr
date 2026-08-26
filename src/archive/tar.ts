import {
  createTarDecoder,
  type ParsedTarEntry,
  type TarHeader,
} from "modern-tar";
import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";
import { wrapCancellableStream } from "../streams/byte-stream";
import { contentTypeForPath } from "../util/mime";
import { normalizeArchivePath } from "../util/path";
import type {
  ArchiveAdapter,
  ArchiveContext,
  ArchiveEntryHandle,
  ArchiveEntryStream,
  ArchiveEntryType,
} from "./types";

function tarEntryType(header: TarHeader): ArchiveEntryType {
  if (header.type === undefined || header.type === "file") return "file";
  if (header.type === "directory") return "directory";
  if (header.type === "symlink") return "symlink";
  if (header.type === "link") return "hardlink";
  return "other";
}

function archiveError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError("CORRUPT_ARCHIVE", "The TAR archive is corrupt or truncated.", {
    stage: "archive-read",
    cause: error,
  });
}

export class TarAdapter implements ArchiveAdapter {
  entries(input: ByteStream, context: ArchiveContext): ArchiveEntryStream {
    return this.iterate(input, context);
  }

  private async *iterate(
    input: ByteStream,
    context: ArchiveContext,
  ): AsyncGenerator<ArchiveEntryHandle> {
    const decoder = createTarDecoder({ strict: true });
    let pumpError: unknown;
    const pumpPromise = input.stream.pipeTo(decoder.writable).catch((error: unknown) => {
      pumpError = error;
    });
    const reader = decoder.readable.getReader();
    const occurrences = new Map<string, number>();
    let index = 0;
    let completed = false;

    try {
      for (;;) {
        let result: ReadableStreamReadResult<ParsedTarEntry>;
        try {
          result = await reader.read();
        } catch (error) {
          throw archiveError(error);
        }
        if (result.done) break;
        const entry = result.value;
        index += 1;

        const normalized = normalizeArchivePath(entry.header.name);
        if (new TextEncoder().encode(normalized.path).byteLength > LIMITS.pathBytes) {
          await entry.body.cancel("archive path limit exceeded");
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
        let resolveCompletion: () => void = () => undefined;
        const completion = new Promise<void>((resolve) => {
          resolveCompletion = resolve;
        });
        const type = tarEntryType(entry.header);

        const handle: ArchiveEntryHandle = {
          index,
          path: normalized.path,
          ...(normalized.rawPath === undefined ? {} : { rawPath: normalized.rawPath }),
          occurrence,
          unsafePath: normalized.unsafePath,
          type,
          size: entry.header.size,
          compressionMethod: "stored",
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
              await entry.body.cancel("unsupported TAR entry type");
              resolveCompletion();
              throw new GatewayError("ENTRY_TYPE_UNSUPPORTED", "Only regular files can be opened.", {
                stage: "archive-entry",
                details: { path: normalized.path, type },
              });
            }

            return {
              stream: wrapCancellableStream(
                entry.body,
                (reason) => input.abort(reason),
                resolveCompletion,
              ),
              knownLength: entry.header.size,
              contentType: contentTypeForPath(normalized.path),
              filename: normalized.path.split("/").at(-1) || "entry",
              abort(reason?: unknown) {
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
            await entry.body.cancel("entry skipped");
            resolveCompletion();
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
        await completion;
      }

      await pumpPromise;
      if (pumpError !== undefined) throw archiveError(pumpError);
      completed = true;
    } finally {
      if (!completed) {
        input.abort("TAR iteration stopped");
        await reader.cancel("TAR iteration stopped").catch(() => undefined);
      }
      reader.releaseLock();
      await pumpPromise;
    }
  }
}

