import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { EntrySelector } from "../schemas";
import type { ByteStream } from "../streams/byte-stream";
import { wrapCancellableStream } from "../streams/byte-stream";
import { normalizeArchivePath } from "../util/path";
import type { ArchiveEntryHandle, OpenedArchive } from "./types";

const LIST_METADATA_BUDGET = LIMITS.operationMetadataBytes;

export interface ListedEntry {
  index: number;
  path: string;
  rawPath?: string;
  occurrence: number;
  unsafePath: boolean;
  type: ArchiveEntryHandle["type"];
  size?: number | null;
  compressedSize?: number;
  compressionMethod?: string | number;
  contentType?: string;
}

export async function listOpenedArchive(
  archive: OpenedArchive,
  maxEntries: number,
): Promise<{ entries: ListedEntry[]; truncated: boolean }> {
  const entries: ListedEntry[] = [];
  let metadataBytes = 0;
  let truncated = false;

  try {
    for await (const entry of archive.entries) {
      const pathBytes = new TextEncoder().encode(entry.path).byteLength;
      if (
        entries.length >= Math.min(maxEntries, LIMITS.listEntries) ||
        metadataBytes + pathBytes > LIST_METADATA_BUDGET
      ) {
        truncated = true;
        archive.abort("archive listing truncated");
        break;
      }
      metadataBytes += pathBytes;
      entries.push({
        index: entry.index,
        path: entry.path,
        ...(entry.rawPath === undefined ? {} : { rawPath: entry.rawPath }),
        occurrence: entry.occurrence,
        unsafePath: entry.unsafePath,
        type: entry.type,
        ...(entry.size === undefined ? {} : { size: entry.size }),
        ...(entry.compressedSize === undefined
          ? {}
          : { compressedSize: entry.compressedSize }),
        ...(entry.compressionMethod === undefined
          ? {}
          : { compressionMethod: entry.compressionMethod }),
        ...(entry.contentType === undefined ? {} : { contentType: entry.contentType }),
      });
      await entry.skip();
    }
  } catch (error) {
    archive.abort(error);
    throw error;
  }

  return { entries, truncated };
}

export function selectorOccurrencePaths(selectors: readonly EntrySelector[]): Set<string> {
  return new Set(selectors.map((selector) => normalizeArchivePath(selector.path).path));
}

export function selectorKey(selector: Pick<EntrySelector, "path" | "occurrence">): string {
  return `${normalizeArchivePath(selector.path).path}\0${selector.occurrence}`;
}

export function assertUniqueSelectors(selectors: readonly EntrySelector[]): void {
  const keys = new Set<string>();
  for (const selector of selectors) {
    const key = selectorKey(selector);
    if (keys.has(key)) {
      throw new GatewayError("INVALID_REQUEST", "An archive selector is duplicated.", {
        stage: "archive-select",
        status: 409,
        details: { path: selector.path, occurrence: selector.occurrence },
      });
    }
    keys.add(key);
  }
}

export async function selectSingleEntry(
  archive: OpenedArchive,
  selector: EntrySelector,
): Promise<{ entry: ArchiveEntryHandle; byteStream: ByteStream }> {
  const selectedPath = normalizeArchivePath(selector.path).path;
  const iterator = archive.entries[Symbol.asyncIterator]();

  try {
    for (;;) {
      const result = await iterator.next();
      if (result.done) break;
      const entry = result.value;
      if (entry.path !== selectedPath || entry.occurrence !== selector.occurrence) {
        await entry.skip();
        continue;
      }

      const selected = await entry.open();
      let cleaned = false;
      const cleanup = (reason?: unknown) => {
        if (cleaned) return;
        cleaned = true;
        selected.abort(reason ?? "selected entry complete");
        archive.abort(reason ?? "selected entry complete");
        void iterator.return?.();
      };
      return {
        entry,
        byteStream: {
          ...selected,
          stream: wrapCancellableStream(selected.stream, cleanup, cleanup),
          abort: cleanup,
        },
      };
    }
  } catch (error) {
    archive.abort(error);
    await iterator.return?.();
    throw error;
  }

  archive.abort("entry not found");
  throw new GatewayError("ENTRY_NOT_FOUND", "Archive entry was not found.", {
    stage: "archive-select",
    details: { path: selectedPath, occurrence: selector.occurrence },
  });
}
