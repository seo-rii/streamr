import { LIMITS } from "../constants";
import { GatewayError, asGatewayError, type SerializedGatewayError } from "../errors";
import type { DistributionRoute } from "../schemas";
import { createDrainShield, type DrainShield } from "../streams/drain-shield";
import { applyEntryTransforms, limitEntryBytes, validateEntryTransforms } from "../transforms";
import { normalizeArchivePath } from "../util/path";
import { inferByteStreamContentType } from "../util/mime";
import type { OpenedArchive } from "../archive/types";
import {
  uploadByteStream,
  validateHttpTarget,
  type TargetResponseCapture,
} from "./transfer";

const DISTRIBUTION_METADATA_BUDGET = LIMITS.operationMetadataBytes;
const TARGET_RESPONSE_CAPTURE_BUDGET = 2 * 1024 * 1024;

export type FailurePolicy = "abort" | "continue";

interface DistributionResultBase {
  id?: string;
  path: string;
  occurrence: number;
  required: boolean;
}

export interface UploadedDistributionResult extends DistributionResultBase {
  status: "uploaded";
  targetStatus: number;
  bytesWritten: number;
  targetResponse: TargetResponseCapture;
}

export interface FailedDistributionResult extends DistributionResultBase {
  status: "failed";
  error: SerializedGatewayError;
}

export interface MissingDistributionResult extends DistributionResultBase {
  status: "missing";
  error: SerializedGatewayError;
}

export interface NotRunDistributionResult extends DistributionResultBase {
  status: "not-run";
  error: SerializedGatewayError;
}

export type DistributionEntryResult =
  | UploadedDistributionResult
  | FailedDistributionResult
  | MissingDistributionResult
  | NotRunDistributionResult;

export interface DistributionWarning {
  id?: string;
  path: string;
  occurrence: number;
  error: SerializedGatewayError;
}

export interface DistributionResult {
  ok: boolean;
  archiveFormat: string;
  entriesScanned: number;
  stoppedEarly: boolean;
  archiveFullyScanned: boolean;
  integrityScope: "full-archive" | "selected-entries" | "partial-archive";
  results: DistributionEntryResult[];
  warnings: DistributionWarning[];
  errors: SerializedGatewayError[];
  sourceGets?: number;
  bytesWritten: number;
}

interface PreparedRoute {
  key: string;
  normalizedPath: string;
  route: DistributionRoute;
}

function routeKey(path: string, occurrence: number): string {
  return `${normalizeArchivePath(path).path}\0${occurrence}`;
}

function resultBase(prepared: PreparedRoute): DistributionResultBase {
  return {
    ...(prepared.route.id === undefined ? {} : { id: prepared.route.id }),
    path: prepared.normalizedPath,
    occurrence: prepared.route.occurrence,
    required: prepared.route.required,
  };
}

function prepareRoutes(routes: readonly DistributionRoute[]): PreparedRoute[] {
  const keys = new Set<string>();
  const encoder = new TextEncoder();
  let metadataBytes = 0;

  return routes.map((route) => {
    validateEntryTransforms(route.transforms, { allowMultipartFormData: true });
    validateHttpTarget(route.target);
    const normalizedPath = normalizeArchivePath(route.path).path;
    const key = routeKey(normalizedPath, route.occurrence);
    if (keys.has(key)) {
      throw new GatewayError(
        "INVALID_REQUEST",
        "Multiple distribution routes cannot target the same archive entry.",
        {
          stage: "distribution-validate",
          status: 409,
          details: { path: normalizedPath, occurrence: route.occurrence },
        },
      );
    }
    keys.add(key);

    metadataBytes += encoder.encode(normalizedPath).byteLength;
    if (route.id !== undefined) metadataBytes += encoder.encode(route.id).byteLength;
    if (metadataBytes > DISTRIBUTION_METADATA_BUDGET) {
      throw new GatewayError(
        "ENTRY_LIMIT_REACHED",
        "Distribution route metadata exceeds the bounded-memory limit.",
        {
          stage: "distribution-validate",
          details: { maxBytes: DISTRIBUTION_METADATA_BUDGET },
        },
      );
    }

    return { key, normalizedPath, route };
  });
}

/** Run all distribution validation before a source subrequest is started. */
export function validateDistributionRoutes(routes: readonly DistributionRoute[]): void {
  void prepareRoutes(routes);
}

function pipelineAborted(reason?: unknown): GatewayError {
  return new GatewayError("PIPELINE_ABORTED", "The distribution pipeline was aborted.", {
    stage: "distribution",
    retryable: true,
    cause: reason,
  });
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function missingError(prepared: PreparedRoute): GatewayError {
  return new GatewayError("ENTRY_NOT_FOUND", "Archive entry was not found.", {
    stage: "archive-select",
    details: {
      path: prepared.normalizedPath,
      occurrence: prepared.route.occurrence,
    },
  });
}

function notRunError(prepared: PreparedRoute): GatewayError {
  return new GatewayError(
    "PIPELINE_ABORTED",
    "The route was not run because distribution stopped early.",
    {
      stage: "distribution",
      details: {
        path: prepared.normalizedPath,
        occurrence: prepared.route.occurrence,
      },
    },
  );
}

function warningFor(
  prepared: PreparedRoute,
  error: SerializedGatewayError,
): DistributionWarning {
  return {
    ...(prepared.route.id === undefined ? {} : { id: prepared.route.id }),
    path: prepared.normalizedPath,
    occurrence: prepared.route.occurrence,
    error,
  };
}

function retainedResponseBytes(value: unknown): number {
  if (typeof value !== "object" || value === null || !("body" in value)) return 0;
  const body = value.body;
  return typeof body === "string" ? new TextEncoder().encode(body).byteLength : 0;
}

export async function distributeArchive(
  archive: OpenedArchive,
  routes: readonly DistributionRoute[],
  failurePolicy: FailurePolicy = "abort",
  signal?: AbortSignal,
  sourceGets?: number,
  requestOutputLimit: number = LIMITS.requestOutputBytes,
): Promise<DistributionResult> {
  const preparedRoutes = prepareRoutes(routes);
  const routesByKey = new Map(preparedRoutes.map((prepared) => [prepared.key, prepared]));
  const completedKeys = new Set<string>();
  const results: DistributionEntryResult[] = [];
  const warnings: DistributionWarning[] = [];
  const errors: SerializedGatewayError[] = [];
  let entriesScanned = 0;
  let stoppedEarly = false;
  let responseCaptureRemaining = TARGET_RESPONSE_CAPTURE_BUDGET;
  let requestBytesWritten = 0;
  let remainingRoutesNotRun = false;

  const abortForSignal = () => archive.abort(signal?.reason ?? "distribution aborted");
  if (signalIsAborted(signal)) {
    archive.abort(signal?.reason);
    throw pipelineAborted(signal?.reason);
  }
  signal?.addEventListener("abort", abortForSignal, { once: true });

  try {
    try {
      for await (const entry of archive.entries) {
        if (signalIsAborted(signal)) throw pipelineAborted(signal?.reason);
        entriesScanned += 1;
        const prepared = routesByKey.get(routeKey(entry.path, entry.occurrence));
        if (prepared === undefined) {
          await entry.skip();
          continue;
        }

        completedKeys.add(prepared.key);
        let isolated: DrainShield | undefined;
        let uploadSucceeded = false;
        try {
          if (entry.type !== "file") {
            await entry.skip();
            throw new GatewayError(
              "ENTRY_TYPE_UNSUPPORTED",
              "Only regular files can be distributed.",
              {
                stage: "archive-entry",
                details: { path: entry.path, occurrence: entry.occurrence },
              },
            );
          }
          const opened = await entry.open();
          isolated = createDrainShield(opened);
          let transformed = await applyEntryTransforms(
            isolated.byteStream,
            prepared.route.transforms,
            { allowMultipartFormData: true },
          );
          transformed = limitEntryBytes(transformed);
          transformed = await inferByteStreamContentType(transformed);
          const aggregateInput = transformed;
          const remainingRequestBytes = requestOutputLimit - requestBytesWritten;
          if (
            aggregateInput.knownLength !== undefined &&
            aggregateInput.knownLength > remainingRequestBytes
          ) {
            aggregateInput.abort("request output limit exceeded");
            throw new GatewayError(
              "OUTPUT_LIMIT_EXCEEDED",
              "The distribution request exceeded its total output limit.",
              {
                stage: "request-limit",
                details: {
                  maxBytes: requestOutputLimit,
                  observedBytes: requestBytesWritten + aggregateInput.knownLength,
                },
              },
            );
          }
          transformed = {
            ...aggregateInput,
            stream: aggregateInput.stream.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  if (requestBytesWritten + chunk.byteLength > requestOutputLimit) {
                    throw new GatewayError(
                      "OUTPUT_LIMIT_EXCEEDED",
                      "The distribution request exceeded its total output limit.",
                      {
                        stage: "request-limit",
                        details: {
                          maxBytes: requestOutputLimit,
                          observedBytes: requestBytesWritten + chunk.byteLength,
                        },
                      },
                    );
                  }
                  requestBytesWritten += chunk.byteLength;
                  controller.enqueue(chunk);
                },
              }),
            ),
          };
          const upload = await uploadByteStream(
            transformed,
            {
              ...prepared.route.target,
              responseBodyLimit: Math.min(
                prepared.route.target.responseBodyLimit,
                responseCaptureRemaining,
              ),
            },
            signal,
            {
              cancellation:
                failurePolicy === "abort"
                  ? {
                      mode: "abort",
                      abort(reason?: unknown) {
                        archive.abort(reason);
                      },
                    }
                  : { mode: "drain" },
            },
          );
          const capturedBytes = retainedResponseBytes(upload.targetResponse);
          responseCaptureRemaining = Math.max(0, responseCaptureRemaining - capturedBytes);
          results.push({
            ...resultBase(prepared),
            status: "uploaded",
            targetStatus: upload.targetStatus,
            bytesWritten: upload.bytesWritten,
            targetResponse: upload.targetResponse,
          });
          uploadSucceeded = true;
        } catch (error) {
          if (signalIsAborted(signal)) throw pipelineAborted(signal?.reason);
          const serialized = asGatewayError(error).serialize();
          responseCaptureRemaining = Math.max(
            0,
            responseCaptureRemaining - retainedResponseBytes(serialized.details?.targetResponse),
          );
          results.push({
            ...resultBase(prepared),
            status: "failed",
            error: serialized,
          });
          if (!prepared.route.required) warnings.push(warningFor(prepared, serialized));

          if (
            serialized.code === "INTERNAL_ERROR" ||
            serialized.code === "PIPELINE_ABORTED" ||
            serialized.stage === "request-limit" ||
            serialized.stage === "archive-read" ||
            serialized.stage === "source-read" ||
            serialized.stage === "source-fetch"
          ) {
            errors.push(serialized);
            remainingRoutesNotRun = true;
            stoppedEarly = true;
            archive.abort(error);
            break;
          }

          if (failurePolicy === "abort") {
            remainingRoutesNotRun = true;
            stoppedEarly = true;
            archive.abort(error);
            break;
          }
        }

        if (isolated !== undefined) {
          try {
            await isolated.drain(
              uploadSucceeded ? "target upload completed" : "failed route discarded",
            );
          } catch (error) {
            stoppedEarly = true;
            remainingRoutesNotRun = true;
            archive.abort(error);
            errors.push(asGatewayError(error).serialize());
            break;
          }
        }

        if (completedKeys.size === preparedRoutes.length) {
          stoppedEarly = true;
          archive.abort("all distribution routes completed");
          break;
        }
      }
    } catch (error) {
      if (signalIsAborted(signal)) throw pipelineAborted(signal?.reason);
      stoppedEarly = true;
      remainingRoutesNotRun = true;
      archive.abort(error);
      errors.push(asGatewayError(error).serialize());
    }

    for (const prepared of preparedRoutes) {
      if (completedKeys.has(prepared.key)) continue;
      const error = remainingRoutesNotRun ? notRunError(prepared) : missingError(prepared);
      const serialized = error.serialize();
      const result: MissingDistributionResult | NotRunDistributionResult = remainingRoutesNotRun
        ? { ...resultBase(prepared), status: "not-run", error: serialized }
        : { ...resultBase(prepared), status: "missing", error: serialized };
      results.push(result);
      if (!prepared.route.required) warnings.push(warningFor(prepared, serialized));
    }

    const archiveFullyScanned = !stoppedEarly;
    const allSelectedEntriesCompleted =
      completedKeys.size === preparedRoutes.length &&
      errors.length === 0 &&
      results.every((result) => result.status === "uploaded");
    return {
      ok:
        errors.length === 0 &&
        results.every((result) => !result.required || result.status === "uploaded"),
      archiveFormat: archive.format,
      entriesScanned,
      stoppedEarly,
      archiveFullyScanned,
      integrityScope: archiveFullyScanned
        ? "full-archive"
        : allSelectedEntriesCompleted
          ? "selected-entries"
          : "partial-archive",
      results,
      warnings,
      errors,
      bytesWritten: requestBytesWritten,
      ...(sourceGets === undefined ? {} : { sourceGets }),
    };
  } finally {
    signal?.removeEventListener("abort", abortForSignal);
  }
}
