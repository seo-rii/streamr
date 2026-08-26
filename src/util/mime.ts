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

