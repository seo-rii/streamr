import { resolveResource } from "../archive/open";
import type { SourceSpec } from "../schemas";
import { openSource, sourceDetectionHints, type OpenedSource } from "./open";

export async function probeSource(
  spec: SourceSpec,
  signal?: AbortSignal,
  onSource?: (source: OpenedSource) => void,
) {
  const source = await openSource(spec, signal);
  onSource?.(source);
  const resolved = await resolveResource(source.byteStream, sourceDetectionHints(source));
  await resolved.byteStream.stream.cancel("probe complete");

  return {
    ok: true as const,
    ...(source.status === undefined ? {} : { status: source.status }),
    ...(source.finalUrl === undefined ? {} : { finalUrl: source.finalUrl }),
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
