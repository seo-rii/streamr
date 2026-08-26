import type { ByteStream } from "../streams/byte-stream";

export type ArchiveEntryType =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "other";

export interface ArchiveEntryHandle {
  index: number;
  path: string;
  rawPath?: string;
  occurrence: number;
  unsafePath: boolean;
  type: ArchiveEntryType;
  size?: number;
  compressedSize?: number;
  compressionMethod?: string | number;
  contentType?: string;
  open(): Promise<ByteStream>;
  skip(): Promise<void>;
}

export interface ArchiveEntryStream extends AsyncIterable<ArchiveEntryHandle> {}

export interface ArchiveContext {
  listMode?: boolean;
  occurrencePaths?: ReadonlySet<string>;
}

export interface OpenedArchive {
  format: string;
  layers: string[];
  entries: ArchiveEntryStream;
  abort(reason?: unknown): void;
}

export interface ArchiveAdapter {
  entries(input: ByteStream, context: ArchiveContext): ArchiveEntryStream;
}
