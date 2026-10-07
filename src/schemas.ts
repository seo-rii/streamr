import { z } from "zod";
import { DEFAULT_TARGET_SUCCESS_STATUS, LIMITS } from "./constants";
import { GatewayError } from "./errors";

const headersSchema = z.record(z.string().min(1).max(256), z.string().max(65_536));
const statusSchema = z.number().int().min(100).max(599);
const pathSchema = z
  .string()
  .min(1)
  .max(LIMITS.pathBytes)
  .refine((path) => new TextEncoder().encode(path).byteLength <= LIMITS.pathBytes, {
    message: `Archive paths must be at most ${LIMITS.pathBytes} UTF-8 bytes.`,
  });

export const sourceSchema = z
  .object({
    url: z.string().min(1).max(16_384),
    headers: headersSchema.optional(),
    redirect: z
      .object({
        max: z.number().int().min(0).max(20).default(LIMITS.sourceRedirects),
        forwardSensitiveHeadersAcrossHosts: z.boolean().default(false),
      })
      .strict()
      .default({ max: LIMITS.sourceRedirects, forwardSensitiveHeadersAcrossHosts: false }),
    acceptStatus: z.array(statusSchema).min(1).max(100).default([200, 206]),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.sourceTimeoutMs)
      .default(LIMITS.sourceTimeoutMs),
  })
  .strict();

export const entrySelectorSchema = z
  .object({
    id: z.string().min(1).max(256).optional(),
    path: pathSchema,
    occurrence: z.number().int().min(1).default(1),
    required: z.boolean().default(true),
  })
  .strict();

export const archiveSelectionSchema = z
  .object({
    entries: z.array(entrySelectorSchema).min(1).max(LIMITS.selectedEntries),
    order: z.literal("archive").default("archive"),
  })
  .strict();

const decompressTransformSchema = z
  .object({
    type: z.literal("decompress"),
    format: z.enum(["auto", "gzip", "bzip2", "xz", "zstd"]).default("auto"),
  })
  .strict();

const newlineTransformSchema = z
  .object({
    type: z.literal("newline"),
    mode: z.enum(["lf", "crlf"]),
    ensureFinalNewline: z.boolean().default(false),
  })
  .strict();

const replaceTransformSchema = z
  .object({
    type: z.literal("replace"),
    search: z.string().min(1).max(LIMITS.replaceSearchBytes),
    replacement: z.string(),
  })
  .strict();

const encodedDataSchema = {
  encoding: z.enum(["utf8", "base64"]),
  data: z.string(),
};

const prependTransformSchema = z
  .object({ type: z.literal("prepend"), ...encodedDataSchema })
  .strict();
const appendTransformSchema = z
  .object({ type: z.literal("append"), ...encodedDataSchema })
  .strict();

const sliceTransformSchema = z
  .object({
    type: z.literal("slice"),
    start: z.number().int().min(0),
    length: z.number().int().min(0).optional(),
  })
  .strict();

export const limitTransformSchema = z
  .object({
    type: z.literal("limit"),
    maxBytes: z.number().int().min(1).max(LIMITS.requestOutputBytes),
  })
  .strict();

export const gzipTransformSchema = z.object({ type: z.literal("gzip") }).strict();

const multipartFormTransformSchema = z
  .object({
    type: z.literal("multipart-form-data"),
    fieldName: z.string().min(1).max(256),
    filename: z.string().min(1).max(1_024),
    contentType: z.string().min(1).max(1_024),
    fields: z.record(z.string().min(1).max(256), z.string()).default({}),
  })
  .strict();

export const imageTransformSchema = z
  .object({
    type: z.literal("image"),
    format: z.enum(["jpeg", "png", "webp"]),
    quality: z.number().int().min(1).max(100).optional(),
    resize: z.object({
      width: z.number().int().min(1).max(4096).optional(),
      height: z.number().int().min(1).max(4096).optional(),
      fit: z.enum(["scale-down", "contain", "cover"]).default("scale-down"),
    }).strict().optional(),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.format === "png" && value.quality !== undefined) {
      context.addIssue({ code: "custom", message: "PNG output is lossless and does not accept quality.", path: ["quality"] });
    }
    if (value.background !== undefined && value.format !== "jpeg") {
      context.addIssue({ code: "custom", message: "A background is only used for JPEG output.", path: ["background"] });
    }
    if (value.resize !== undefined) {
      if (value.resize.width === undefined && value.resize.height === undefined) {
        context.addIssue({ code: "custom", message: "Image resize requires width or height.", path: ["resize"] });
      }
      if (value.resize.fit === "cover" && (value.resize.width === undefined || value.resize.height === undefined)) {
        context.addIssue({ code: "custom", message: "Cover resize requires both width and height.", path: ["resize"] });
      }
      if (value.resize.width !== undefined && value.resize.height !== undefined &&
        value.resize.width * value.resize.height > 1_000_000) {
        context.addIssue({ code: "custom", message: "The image resize box must not exceed 1,000,000 pixels.", path: ["resize"] });
      }
    }
  });

export const entryTransformSchema = z.discriminatedUnion("type", [
  decompressTransformSchema,
  newlineTransformSchema,
  replaceTransformSchema,
  prependTransformSchema,
  appendTransformSchema,
  sliceTransformSchema,
  limitTransformSchema,
  gzipTransformSchema,
  multipartFormTransformSchema,
  imageTransformSchema,
]);

export const finalTransformSchema = z.discriminatedUnion("type", [
  limitTransformSchema,
  gzipTransformSchema,
]);

export const outputSchema = z
  .object({
    mode: z.enum(["raw", "multipart-mixed"]).default("raw"),
    contentType: z.string().min(1).max(1_024).optional(),
    filename: z.string().min(1).max(1_024).optional(),
  })
  .strict()
  .default({ mode: "raw" });

export const targetSchema = z
  .object({
    url: z.string().min(1).max(16_384),
    method: z.enum(["POST", "PUT", "PATCH"]),
    headers: headersSchema.optional(),
    contentType: z.string().min(1).max(1_024).optional(),
    successStatus: z
      .array(statusSchema)
      .min(1)
      .max(100)
      .default([...DEFAULT_TARGET_SUCCESS_STATUS]),
    responseBodyLimit: z
      .number()
      .int()
      .min(0)
      .max(1024 * 1024)
      .default(LIMITS.targetResponseBytes),
    requireContentLength: z.boolean().default(false),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.targetTimeoutMs)
      .default(LIMITS.targetTimeoutMs),
  })
  .strict();

export const probeRequestSchema = z.object({ source: sourceSchema }).strict();

export const listRequestSchema = z
  .object({
    source: sourceSchema,
    options: z
      .object({
        maxEntries: z.number().int().min(1).max(LIMITS.listEntries).default(LIMITS.listEntries),
      })
      .strict()
      .default({ maxEntries: LIMITS.listEntries }),
  })
  .strict();

export const streamRequestSchema = z
  .object({
    source: sourceSchema,
    archive: archiveSelectionSchema.optional(),
    entryTransforms: z.array(entryTransformSchema).max(LIMITS.transforms).default([]),
    finalTransforms: z.array(finalTransformSchema).max(LIMITS.transforms).default([]),
    output: outputSchema,
  })
  .strict();

export const transferRequestSchema = z
  .object({
    source: sourceSchema,
    archive: archiveSelectionSchema.optional(),
    entryTransforms: z.array(entryTransformSchema).max(LIMITS.transforms).default([]),
    target: targetSchema,
  })
  .strict();

export const distributionRouteSchema = z
  .object({
    id: z.string().min(1).max(256).optional(),
    path: pathSchema,
    occurrence: z.number().int().min(1).default(1),
    required: z.boolean().default(true),
    transforms: z.array(entryTransformSchema).max(LIMITS.transforms).default([]),
    target: targetSchema,
  })
  .strict();

export const distributeRequestSchema = z
  .object({
    source: sourceSchema,
    routes: z.array(distributionRouteSchema).min(1).max(LIMITS.distributionRoutes),
    failurePolicy: z.enum(["abort", "continue"]).default("abort"),
  })
  .strict();

export type SourceSpec = z.infer<typeof sourceSchema>;
export type ProbeRequest = z.infer<typeof probeRequestSchema>;
export type ListRequest = z.infer<typeof listRequestSchema>;
export type EntrySelector = z.infer<typeof entrySelectorSchema>;
export type ArchiveSelectionSpec = z.infer<typeof archiveSelectionSchema>;
export type EntryTransformSpec = z.infer<typeof entryTransformSchema>;
export type ImageTransformSpec = z.infer<typeof imageTransformSchema>;
export type FinalTransformSpec = z.infer<typeof finalTransformSchema>;
export type HttpTargetSpec = z.infer<typeof targetSchema>;
export type StreamRequest = z.infer<typeof streamRequestSchema>;
export type TransferRequest = z.infer<typeof transferRequestSchema>;
export type DistributionRoute = z.infer<typeof distributionRouteSchema>;
export type DistributeRequest = z.infer<typeof distributeRequestSchema>;

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  throw new GatewayError("INVALID_REQUEST", issue?.message ?? "Invalid input.", {
    stage: "request-validate",
    details: { path: issue?.path.join(".") ?? "" },
  });
}
