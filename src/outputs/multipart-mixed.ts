import { LIMITS } from "../constants";
import { asGatewayError, GatewayError, type GatewayErrorCode } from "../errors";
import type { EntrySelector, EntryTransformSpec, FinalTransformSpec } from "../schemas";
import type { ByteStream } from "../streams/byte-stream";
import { createDrainShield } from "../streams/drain-shield";
import {
  applyEntryTransforms,
  applyFinalTransforms,
  limitEntryBytes,
  limitBytes,
  validateCombinedTransforms,
  validateEntryTransforms,
  validateFinalTransforms,
} from "../transforms";
import { inputChunks } from "../transforms/stream";
import { normalizeArchivePath } from "../util/path";
import { inferByteStreamContentType } from "../util/mime";
import type { ArchiveEntryHandle, OpenedArchive } from "../archive/types";

const encoder = new TextEncoder();
const MULTIPART_METADATA_BUDGET = LIMITS.operationMetadataBytes;

interface NormalizedSelector {
  id?: string;
  path: string;
  occurrence: number;
  required: boolean;
  matched: boolean;
  completed: boolean;
  archiveIndex?: number;
}

export interface MultipartManifestError {
  code: GatewayErrorCode;
  stage: string;
  path?: string;
  occurrence?: number;
  index?: number;
}

export interface MultipartMixedManifest {
  ok: boolean;
  requested: number;
  emitted: number;
  missing: string[];
  errors: MultipartManifestError[];
  selectors: MultipartSelectorResult[];
  archive: MultipartArchiveIntegrity;
}

export interface MultipartSelectorResult {
  id?: string;
  path: string;
  occurrence: number;
  required: boolean;
  status: "emitted" | "failed" | "missing" | "unresolved";
  archiveIndex?: number;
}

export interface MultipartArchiveIntegrity {
  fullyScanned: boolean;
  stoppedEarly: boolean;
  integrityScope: "full-archive" | "selected-entries" | "partial-archive";
}

export interface MultipartMixedStreamResult {
  byteStream: ByteStream;
  boundary: string;
}

export interface MultipartMixedStats {
  entriesScanned: number;
}

/** A byte limit could truncate the mandatory manifest, so only gzip is safe here. */
export function validateMultipartFinalTransforms(
  transforms: readonly FinalTransformSpec[],
): void {
  validateFinalTransforms(transforms);
  if (transforms.some((transform) => transform.type !== "gzip")) {
    throw new GatewayError(
      "INVALID_TRANSFORM",
      "A multipart/mixed final transform must preserve the mandatory manifest; only gzip is allowed.",
      { stage: "transform-validate" },
    );
  }
}

/**
 * Encodes selected archive entries as one bounded-memory multipart/mixed stream.
 * Entry bodies are opened and completely consumed in archive order, one at a time.
 */
export async function createMultipartMixedStream(
  archive: OpenedArchive,
  selectors: readonly EntrySelector[],
  entryTransforms: readonly EntryTransformSpec[] = [],
  finalTransforms: readonly FinalTransformSpec[] = [],
  signal?: AbortSignal,
  onManifest?: (manifest: MultipartMixedManifest, stats: MultipartMixedStats) => void,
): Promise<MultipartMixedStreamResult> {
  const normalizedSelectors = normalizeSelectors(selectors);
  validateEntryTransforms(entryTransforms, { allowMultipartFormData: false });
  validateMultipartFinalTransforms(finalTransforms);
  validateCombinedTransforms(entryTransforms, finalTransforms);

  if (signal?.aborted === true) {
    archive.abort(signal.reason);
    throw new GatewayError("PIPELINE_ABORTED", "The multipart stream was aborted.", {
      stage: "multipart-mixed",
      cause: signal.reason,
    });
  }

  const boundary = `sgw_${crypto.randomUUID().replaceAll("-", "")}`;
  const iterator = encodeMultipartArchive(
    archive,
    normalizedSelectors,
    entryTransforms,
    boundary,
    onManifest,
    signal,
  );
  const base = iteratorByteStream(iterator, archive, signal, {
    contentType: `multipart/mixed; boundary=${boundary}`,
  });
  const transformed = await applyFinalTransforms(base, finalTransforms);
  const byteStream = limitBytes(transformed, LIMITS.requestOutputBytes);

  return { byteStream, boundary };
}

function normalizeSelectors(selectors: readonly EntrySelector[]): NormalizedSelector[] {
  if (selectors.length > LIMITS.selectedEntries) {
    throw new GatewayError("INVALID_REQUEST", "Too many archive entries were selected.", {
      stage: "archive-select",
      details: { maxEntries: LIMITS.selectedEntries },
    });
  }

  const keys = new Set<string>();
  let metadataBytes = 0;
  return selectors.map((selector) => {
    const path = normalizeArchivePath(selector.path).path;
    const occurrence = selector.occurrence ?? 1;
    const key = selectorKey(path, occurrence);
    if (keys.has(key)) {
      throw new GatewayError("INVALID_REQUEST", "An archive selector is duplicated.", {
        stage: "archive-select",
        status: 409,
        details: { path, occurrence },
      });
    }
    keys.add(key);
    metadataBytes += encoder.encode(path).byteLength;
    if (selector.id !== undefined) metadataBytes += encoder.encode(selector.id).byteLength;
    if (metadataBytes > MULTIPART_METADATA_BUDGET) {
      throw new GatewayError(
        "ENTRY_LIMIT_REACHED",
        "Multipart selector metadata exceeds the bounded-memory limit.",
        {
          stage: "archive-select",
          details: { maxBytes: MULTIPART_METADATA_BUDGET },
        },
      );
    }
    return {
      ...(selector.id === undefined ? {} : { id: selector.id }),
      path,
      occurrence,
      required: selector.required ?? true,
      matched: false,
      completed: false,
    };
  });
}

async function* encodeMultipartArchive(
  archive: OpenedArchive,
  selectors: NormalizedSelector[],
  transforms: readonly EntryTransformSpec[],
  boundary: string,
  onManifest?: (manifest: MultipartMixedManifest, stats: MultipartMixedStats) => void,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const selected = new Map(
    selectors.map((selector) => [selectorKey(selector.path, selector.occurrence), selector]),
  );
  const errors: MultipartManifestError[] = [];
  const errorKeys = new Set<string>();
  let emitted = 0;
  let entriesScanned = 0;
  let unresolved = selectors.length;
  let archiveCompleted = false;
  let archiveFailed = false;
  let stoppedEarly = false;
  let iterator: AsyncIterator<ArchiveEntryHandle> | undefined;

  try {
    iterator = archive.entries[Symbol.asyncIterator]();
    while (unresolved > 0) {
      let result: IteratorResult<ArchiveEntryHandle>;
      try {
        result = await iterator.next();
      } catch (error) {
        archiveFailed = true;
        addManifestError(errors, errorKeys, error);
        break;
      }
      if (result.done) {
        archiveCompleted = true;
        break;
      }

      const entry = result.value;
      entriesScanned += 1;
      const selector = selected.get(selectorKey(entry.path, entry.occurrence));
      if (selector === undefined) {
        try {
          await entry.skip();
        } catch (error) {
          archiveFailed = true;
          addManifestError(errors, errorKeys, error, entry);
          break;
        }
        continue;
      }

      selector.matched = true;
      selector.archiveIndex = entry.index;
      unresolved -= 1;
      if (entry.type !== "file") {
        try {
          await entry.skip();
        } catch (error) {
          archiveFailed = true;
          addManifestError(errors, errorKeys, error, entry);
          break;
        }
        addManifestError(
          errors,
          errorKeys,
          new GatewayError("ENTRY_TYPE_UNSUPPORTED", "Only regular files can be extracted.", {
            stage: "archive-entry",
          }),
          entry,
        );
        continue;
      }

      let opened: ByteStream;
      try {
        opened = await entry.open();
      } catch (error) {
        addManifestError(errors, errorKeys, error, entry);
        if (isArchiveFailure(error)) archiveFailed = true;
        if (archiveFailed) break;
        continue;
      }

      const shield = createDrainShield(opened);
      let partStarted = false;
      let entrySucceeded = false;
      try {
        let transformed = await applyEntryTransforms(shield.byteStream, transforms, {
          allowMultipartFormData: false,
          ...(signal === undefined ? {} : { signal }),
        });
        transformed = limitEntryBytes(transformed);
        transformed = await inferByteStreamContentType(transformed);

        yield encodePartHeaders(boundary, entry, selector, transformed);
        partStarted = true;
        for await (const chunk of inputChunks(transformed)) yield chunk;
        await shield.waitForCompletion();
        entrySucceeded = true;
        selector.completed = true;
        emitted += 1;
      } catch (error) {
        addManifestError(errors, errorKeys, error, entry);
        if (isArchiveFailure(error)) archiveFailed = true;
        try {
          await shield.drain();
        } catch (drainError) {
          archiveFailed = true;
          addManifestError(errors, errorKeys, drainError, entry);
        }
      }
      if (partStarted) yield encoder.encode("\r\n");

      if (!entrySucceeded && archiveFailed) break;
    }

    if (unresolved === 0 && !archiveCompleted && !archiveFailed) {
      stoppedEarly = true;
      archive.abort("all selected archive entries were processed");
      try {
        await iterator.return?.();
      } catch (error) {
        archiveFailed = true;
        addManifestError(errors, errorKeys, error);
      }
    } else if (!archiveFailed && !archiveCompleted) {
      try {
        for (;;) {
          const result = await iterator.next();
          if (result.done) {
            archiveCompleted = true;
            break;
          }
          await result.value.skip();
        }
      } catch (error) {
        archiveFailed = true;
        addManifestError(errors, errorKeys, error);
      }
    }

    const missing = archiveCompleted
      ? selectors.filter((selector) => !selector.matched).map((selector) => selector.path)
      : [];
    const requiredSucceeded = selectors.every(
      (selector) => !selector.required || selector.completed,
    );
    const manifest: MultipartMixedManifest = {
      ok: !archiveFailed && requiredSucceeded,
      requested: selectors.length,
      emitted,
      missing,
      errors,
      selectors: selectors.map((selector) => selectorResult(selector, archiveCompleted)),
      archive: {
        fullyScanned: archiveCompleted,
        stoppedEarly,
        integrityScope: archiveCompleted
          ? "full-archive"
          : archiveFailed
            ? "partial-archive"
            : "selected-entries",
      },
    };
    onManifest?.(manifest, { entriesScanned });
    yield encodeManifest(boundary, manifest);
  } finally {
    if (!archiveCompleted) {
      archive.abort("multipart archive stream finished");
      await iterator?.return?.().catch(() => undefined);
    }
  }
}

function encodePartHeaders(
  boundary: string,
  entry: ArchiveEntryHandle,
  selector: NormalizedSelector,
  transformed: ByteStream,
): Uint8Array {
  const filename = transformed.filename ?? entry.path.split("/").at(-1) ?? "entry";
  const contentType = transformed.contentType ?? entry.contentType ?? "application/octet-stream";
  if (/\r|\n/.test(contentType)) {
    throw new GatewayError("INVALID_CONTENT_TYPE", "The entry content type is invalid.", {
      stage: "multipart-mixed",
      details: { path: entry.path },
    });
  }
  return encoder.encode(
    `--${boundary}\r\n` +
      `Content-Type: ${contentType}\r\n` +
      `Content-Disposition: attachment; filename*=UTF-8''${encodeRfc5987(filename)}\r\n` +
      `X-Archive-Path: ${encodeRfc5987(entry.path)}\r\n` +
      `X-Archive-Index: ${entry.index}\r\n` +
      (selector.id === undefined
        ? ""
        : `X-Stream-Gateway-Selector-Id: ${encodeRfc5987(selector.id)}\r\n`) +
      `X-Stream-Gateway-Selector-Path: ${encodeRfc5987(selector.path)}\r\n` +
      `X-Stream-Gateway-Selector-Occurrence: ${selector.occurrence}\r\n` +
      `X-Stream-Gateway-Selector-Required: ${selector.required}\r\n\r\n`,
  );
}

function selectorResult(
  selector: NormalizedSelector,
  archiveCompleted: boolean,
): MultipartSelectorResult {
  const status = selector.completed
    ? "emitted"
    : selector.matched
      ? "failed"
      : archiveCompleted
        ? "missing"
        : "unresolved";
  return {
    ...(selector.id === undefined ? {} : { id: selector.id }),
    path: selector.path,
    occurrence: selector.occurrence,
    required: selector.required,
    status,
    ...(selector.archiveIndex === undefined
      ? {}
      : { archiveIndex: selector.archiveIndex }),
  };
}

function encodeManifest(boundary: string, manifest: MultipartMixedManifest): Uint8Array {
  return encoder.encode(
    `--${boundary}\r\n` +
      "Content-Type: application/json\r\n" +
      'Content-Disposition: inline; filename="__stream_gateway_manifest__.json"\r\n' +
      "X-Stream-Gateway-Control: manifest\r\n\r\n" +
      `${JSON.stringify(manifest)}\r\n` +
      `--${boundary}--\r\n`,
  );
}

function selectorKey(path: string, occurrence: number): string {
  return `${path}\0${occurrence}`;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function addManifestError(
  errors: MultipartManifestError[],
  keys: Set<string>,
  error: unknown,
  entry?: ArchiveEntryHandle,
): void {
  const gatewayError = asGatewayError(error);
  const key = `${gatewayError.code}\0${gatewayError.stage}\0${entry?.index ?? ""}`;
  if (keys.has(key)) return;
  keys.add(key);
  errors.push({
    code: gatewayError.code,
    stage: gatewayError.stage,
    ...(entry === undefined
      ? {}
      : { path: entry.path, occurrence: entry.occurrence, index: entry.index }),
  });
}

function isArchiveFailure(error: unknown): boolean {
  const code = asGatewayError(error).code;
  return (
    code === "CORRUPT_ARCHIVE" ||
    code === "ARCHIVE_ENCRYPTED" ||
    code === "UNSUPPORTED_COMPRESSION" ||
    code === "UNSUPPORTED_ZIP_METHOD" ||
    code === "ENTRY_OUTPUT_LIMIT" ||
    code === "OUTPUT_LIMIT_EXCEEDED"
  );
}

function iteratorByteStream(
  iterator: AsyncIterator<Uint8Array>,
  archive: OpenedArchive,
  signal: AbortSignal | undefined,
  metadata: { contentType: string },
): ByteStream {
  let state: "open" | "closed" | "cancelled" | "errored" = "open";
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let returnPromise: Promise<void> | undefined;

  const removeAbortListener = () =>
    signal?.removeEventListener("abort", abortFromSignal);
  const returnIterator = (): Promise<void> => {
    returnPromise ??= (async () => {
      try {
        await iterator.return?.();
      } catch {
        // The archive abort is authoritative; iterator cleanup is best effort.
      }
    })();
    return returnPromise;
  };
  const pipelineAborted = (reason?: unknown) =>
    new GatewayError("PIPELINE_ABORTED", "The multipart stream was aborted.", {
      stage: "multipart-mixed",
      cause: reason,
    });
  const abortFromSignal = () => {
    if (state !== "open") return;
    state = "errored";
    removeAbortListener();
    const error = pipelineAborted(signal?.reason);
    archive.abort(error);
    void returnIterator();
    controller?.error(error);
  };
  const abortByteStream = (reason?: unknown) => {
    if (state !== "open") return;
    state = "errored";
    removeAbortListener();
    const error = pipelineAborted(reason);
    archive.abort(error);
    void returnIterator();
    controller?.error(error);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      signal?.addEventListener("abort", abortFromSignal, { once: true });
    },
    async pull(streamController) {
      if (state !== "open") return;
      try {
        const result = await iterator.next();
        // cancel(), AbortSignal, or ByteStream.abort() can win while next() is pending.
        if (state !== "open") return;
        if (result.done) {
          state = "closed";
          removeAbortListener();
          streamController.close();
        } else {
          streamController.enqueue(result.value);
        }
      } catch (error) {
        if (state !== "open") return;
        state = "errored";
        removeAbortListener();
        archive.abort(error);
        await returnIterator();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      if (state !== "open") return;
      state = "cancelled";
      removeAbortListener();
      archive.abort(reason);
      await returnIterator();
    },
  });

  return {
    stream,
    contentType: metadata.contentType,
    abort(reason) {
      abortByteStream(reason);
    },
  };
}
