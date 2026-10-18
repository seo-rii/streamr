import type { DetectionHints } from "../archive/detect";
import type { SourceSpec } from "../schemas";
import type { ByteStream } from "../streams/byte-stream";
import { fetchSource, type SourceStats } from "./fetch";
import { createInlineByteStream } from "./inline";

export interface OpenedSource {
  status?: number;
  finalUrl?: string;
  contentType?: string;
  contentLength?: number;
  byteStream: ByteStream;
  stats: SourceStats;
}

/** Every pipeline consumes the same byte stream, independent of its origin. */
export async function openSource(
  spec: SourceSpec,
  signal?: AbortSignal,
): Promise<OpenedSource> {
  if (spec.type !== "inline") return fetchSource(spec, signal);

  const byteStream = createInlineByteStream(spec, signal);
  return {
    contentType: byteStream.contentType,
    contentLength: byteStream.knownLength,
    byteStream,
    // Inline input is completely decoded and validated before opening it.
    stats: { bytesRead: byteStream.knownLength, sourceGets: 0 },
  };
}

export function sourceDetectionHints(source: OpenedSource): DetectionHints {
  const path = source.finalUrl ?? source.byteStream.filename;
  return {
    ...(path === undefined ? {} : { url: path }),
    ...(source.contentType === undefined ? {} : { contentType: source.contentType }),
  };
}
