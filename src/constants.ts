export const LIMITS = {
  sourceRedirects: 5,
  sourceTimeoutMs: 300_000,
  targetTimeoutMs: 300_000,
  archiveDepth: 2,
  listEntries: 50_000,
  selectedEntries: 10_000,
  distributionRoutes: 10_000,
  pathBytes: 4_096,
  transforms: 16,
  affixBytes: 64 * 1024,
  replaceSearchBytes: 64 * 1024,
  targetResponseBytes: 64 * 1024,
  entryOutputBytes: 4 * 1024 * 1024 * 1024,
  requestOutputBytes: 16 * 1024 * 1024 * 1024,
  signedPayloadBytes: 8 * 1024,
  signedUrlTtlSeconds: 10 * 60,
  controlRequestBytes: 8 * 1024 * 1024,
  prefixBytes: 512,
  headerCount: 128,
  headerValueBytes: 16 * 1024,
  decoderBurstBytes: 8 * 1024 * 1024,
  xzDecoderMemoryBytes: 32 * 1024 * 1024,
  zstdWindowBytes: 16 * 1024 * 1024,
  operationMetadataBytes: 16 * 1024 * 1024,
} as const;

export const DEFAULT_TARGET_SUCCESS_STATUS = [
  200, 201, 202, 203, 204, 205, 206, 207, 208,
] as const;

export const SENSITIVE_REDIRECT_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);
