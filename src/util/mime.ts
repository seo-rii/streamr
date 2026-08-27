import { LIMITS } from "../constants";
import { detectFormat } from "../archive/detect";
import type { ByteStream } from "../streams/byte-stream";
import { peekByteStream } from "../streams/peek";

const MIME_BY_EXTENSION: Record<string, string> = {
  ans: "text/plain; charset=utf-8",
  bz2: "application/x-bzip2",
  c: "text/plain; charset=utf-8",
  cc: "text/plain; charset=utf-8",
  cpp: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gz: "application/gzip",
  gzip: "application/gzip",
  h: "text/plain; charset=utf-8",
  hpp: "text/plain; charset=utf-8",
  in: "text/plain; charset=utf-8",
  java: "text/plain; charset=utf-8",
  js: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/plain; charset=utf-8",
  out: "text/plain; charset=utf-8",
  py: "text/plain; charset=utf-8",
  tar: "application/x-tar",
  ts: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  xz: "application/x-xz",
  zip: "application/zip",
  zst: "application/zstd",
  zstd: "application/zstd",
};

export function contentTypeForPath(path: string): string {
  const extension = path.toLowerCase().split(".").at(-1) ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function contentTypeForMagic(prefix: Uint8Array): string | undefined {
  const detected = detectFormat(prefix);
  if (detected.source !== "magic") return undefined;
  if (detected.format === "zip") return "application/zip";
  if (detected.format === "tar") return "application/x-tar";
  if (detected.format === "gzip") return "application/gzip";
  if (detected.format === "bzip2") return "application/x-bzip2";
  if (detected.format === "xz") return "application/x-xz";
  if (detected.format === "zstd") return "application/zstd";
  return undefined;
}

/** Peek and replay a bounded prefix so magic takes precedence over untrusted upstream metadata. */
export async function inferByteStreamContentType(input: ByteStream): Promise<ByteStream> {
  const peeked = await peekByteStream(input, LIMITS.prefixBytes);
  return {
    ...peeked.byteStream,
    contentType:
      contentTypeForMagic(peeked.prefix) ?? input.contentType ?? "application/octet-stream",
  };
}
