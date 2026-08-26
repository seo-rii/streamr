import { GatewayError } from "../errors";

export type DetectedKind = "archive" | "compressed" | "file";

export type DetectedFormat =
  | "zip"
  | "tar"
  | "gzip"
  | "bzip2"
  | "xz"
  | "zstd"
  | "7z"
  | "rar"
  | "raw";

export interface DetectionResult {
  kind: DetectedKind;
  format: DetectedFormat;
  layers: string[];
  source: "magic" | "content-type" | "extension" | "fallback";
}

export interface DetectionHints {
  contentType?: string;
  url?: string;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function tarChecksumValid(prefix: Uint8Array): boolean {
  if (prefix.byteLength < 512) return false;
  const magic = new TextDecoder("ascii").decode(prefix.subarray(257, 263));
  if (magic !== "ustar\0" && magic !== "ustar ") return false;

  const checksumText = new TextDecoder("ascii")
    .decode(prefix.subarray(148, 156))
    .replaceAll("\0", "")
    .trim();
  if (!/^[0-7]+$/.test(checksumText)) return false;
  const expected = Number.parseInt(checksumText, 8);
  let actual = 0;
  for (let index = 0; index < 512; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : prefix[index] ?? 0;
  }
  return expected === actual;
}

function result(
  format: DetectedFormat,
  source: DetectionResult["source"],
): DetectionResult {
  if (format === "zip" || format === "tar") {
    return { kind: "archive", format, layers: [format], source };
  }
  if (format === "raw") return { kind: "file", format, layers: [], source };
  return { kind: "compressed", format, layers: [format], source };
}

function formatFromContentType(value: string | undefined): DetectedFormat | undefined {
  const contentType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/zip" || contentType === "application/x-zip-compressed") {
    return "zip";
  }
  if (contentType === "application/x-tar") return "tar";
  if (contentType === "application/gzip" || contentType === "application/x-gzip") {
    return "gzip";
  }
  if (contentType === "application/x-bzip2") return "bzip2";
  if (contentType === "application/x-xz") return "xz";
  if (contentType === "application/zstd") return "zstd";
  if (contentType === "application/x-7z-compressed") return "7z";
  if (contentType === "application/vnd.rar" || contentType === "application/x-rar-compressed") {
    return "rar";
  }
  return undefined;
}

function formatFromUrl(value: string | undefined): DetectedFormat | undefined {
  if (value === undefined) return undefined;
  let pathname: string;
  try {
    pathname = new URL(value).pathname.toLowerCase();
  } catch {
    pathname = value.toLowerCase().split(/[?#]/, 1)[0] ?? "";
  }
  if (pathname.endsWith(".zip")) return "zip";
  if (pathname.endsWith(".tar")) return "tar";
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz") || pathname.endsWith(".gz")) {
    return "gzip";
  }
  if (pathname.endsWith(".tar.bz2") || pathname.endsWith(".tbz2") || pathname.endsWith(".bz2")) {
    return "bzip2";
  }
  if (pathname.endsWith(".tar.xz") || pathname.endsWith(".txz") || pathname.endsWith(".xz")) {
    return "xz";
  }
  if (pathname.endsWith(".tar.zst") || pathname.endsWith(".tzst") || pathname.endsWith(".zst")) {
    return "zstd";
  }
  if (pathname.endsWith(".7z")) return "7z";
  if (pathname.endsWith(".rar")) return "rar";
  return undefined;
}

export function detectFormat(prefix: Uint8Array, hints: DetectionHints = {}): DetectionResult {
  if (
    startsWith(prefix, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(prefix, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(prefix, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return result("zip", "magic");
  }
  if (startsWith(prefix, [0x1f, 0x8b])) return result("gzip", "magic");
  if (startsWith(prefix, [0x42, 0x5a, 0x68])) return result("bzip2", "magic");
  if (startsWith(prefix, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return result("xz", "magic");
  if (startsWith(prefix, [0x28, 0xb5, 0x2f, 0xfd])) return result("zstd", "magic");
  if (startsWith(prefix, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return result("7z", "magic");
  if (startsWith(prefix, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return result("rar", "magic");
  if (tarChecksumValid(prefix)) return result("tar", "magic");

  const contentTypeFormat = formatFromContentType(hints.contentType);
  if (contentTypeFormat !== undefined) return result(contentTypeFormat, "content-type");
  const extensionFormat = formatFromUrl(hints.url);
  if (extensionFormat !== undefined) return result(extensionFormat, "extension");
  return result("raw", "fallback");
}

export function rejectUnsupportedArchiveFormat(format: DetectedFormat): never {
  const message = format === "7z" ? "7z archives are unsupported." : "RAR archives are unsupported.";
  throw new GatewayError("UNSUPPORTED_FORMAT", message, {
    stage: "archive-detect",
    details: { format },
  });
}

export function zipIsEncrypted(prefix: Uint8Array): boolean {
  if (!startsWith(prefix, [0x50, 0x4b, 0x03, 0x04]) || prefix.byteLength < 8) return false;
  const flags = (prefix[6] ?? 0) | ((prefix[7] ?? 0) << 8);
  return (flags & 1) !== 0;
}
