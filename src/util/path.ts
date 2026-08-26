export interface NormalizedArchivePath {
  path: string;
  rawPath?: string;
  unsafePath: boolean;
}

export function normalizeArchivePath(rawPath: string): NormalizedArchivePath {
  const hadBackslash = rawPath.includes("\\");
  const unsafePath =
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(rawPath) ||
    rawPath.replaceAll("\\", "/").split("/").includes("..");

  const slashPath = rawPath.replaceAll("\\", "/");
  const normalized = slashPath
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");

  return {
    path: normalized,
    ...(normalized === rawPath && !hadBackslash ? {} : { rawPath }),
    unsafePath,
  };
}

export function archiveBasename(path: string): string {
  const segments = path.split("/");
  return segments.at(-1) || "entry";
}
