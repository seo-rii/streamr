import { LIMITS } from "../constants";
import type { SourceSpec } from "../schemas";
import { peekByteStream } from "../streams/peek";
import { fetchSource } from "./fetch";

export async function probeSource(spec: SourceSpec, signal?: AbortSignal) {
  const source = await fetchSource(spec, signal);
  const { prefix, byteStream } = await peekByteStream(
    source.byteStream,
    LIMITS.prefixBytes,
  );
  await byteStream.stream.cancel("probe complete");

  return {
    ok: true as const,
    status: source.status,
    finalUrl: source.finalUrl,
    ...(source.contentType === undefined ? {} : { contentType: source.contentType }),
    ...(source.contentLength === undefined
      ? {}
      : { contentLength: source.contentLength }),
    detected: {
      kind: "file" as const,
      format: "raw" as const,
      layers: [] as string[],
    },
    prefixBytesRead: prefix.byteLength,
  };
}
