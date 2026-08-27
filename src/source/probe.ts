import { resolveResource } from "../archive/open";
import type { SourceSpec } from "../schemas";
import { fetchSource, type FetchedSource } from "./fetch";

export async function probeSource(
  spec: SourceSpec,
  signal?: AbortSignal,
  onSource?: (source: FetchedSource) => void,
) {
  const source = await fetchSource(spec, signal);
  onSource?.(source);
  const resolved = await resolveResource(source.byteStream, {
    url: source.finalUrl,
    ...(source.contentType === undefined ? {} : { contentType: source.contentType }),
  });
  await resolved.byteStream.stream.cancel("probe complete");

  return {
    ok: true as const,
    status: source.status,
    finalUrl: source.finalUrl,
    ...(source.contentType === undefined ? {} : { contentType: source.contentType }),
    ...(source.contentLength === undefined
      ? {}
      : { contentLength: source.contentLength }),
    detected: {
      kind: resolved.detection.kind,
      format: resolved.detection.format,
      layers: resolved.detection.layers,
    },
    prefixBytesRead: resolved.prefixBytesRead,
  };
}
