import { requireBearer } from "./auth";
import { openArchive } from "./archive/open";
import {
  assertUniqueSelectors,
  listOpenedArchive,
  selectSingleEntry,
  selectorOccurrencePaths,
} from "./archive/select";
import { LIMITS } from "./constants";
import { GatewayError, asGatewayError, errorResponse } from "./errors";
import type { GatewayOperations } from "./mcp/tools";
import {
  distributeArchive,
  validateDistributionRoutes,
} from "./outputs/distribute";
import { createMultipartMixedStream } from "./outputs/multipart-mixed";
import { rawResponse } from "./outputs/raw-response";
import { uploadByteStream, validateHttpTarget } from "./outputs/transfer";
import {
  type DistributeRequest,
  type ListRequest,
  type ProbeRequest,
  type StreamRequest,
  type TransferRequest,
  distributeRequestSchema,
  parseSchema,
  listRequestSchema,
  probeRequestSchema,
  streamRequestSchema,
  transferRequestSchema,
} from "./schemas";
import { fetchSource } from "./source/fetch";
import type { FetchedSource } from "./source/fetch";
import { probeSource } from "./source/probe";
import type { ByteStream } from "./streams/byte-stream";
import {
  applyEntryTransforms,
  applyFinalTransforms,
  limitEntryBytes,
  limitBytes,
  validateCombinedTransforms,
  validateEntryTransforms,
  validateFinalTransforms,
} from "./transforms";
import { readJsonRequest } from "./util/json";
import {
  createRequestLogContext,
  observeByteStream,
  observeResponseCompletion,
  type RequestLogContext,
} from "./util/logging";
import { inferByteStreamContentType } from "./util/mime";
import { createSignedStreamUrl, verifySignedStreamUrl } from "./util/signed-url";

const AUTHENTICATED_POST_ROUTES = new Set([
  "/mcp",
  "/v1/probe",
  "/v1/list",
  "/v1/stream",
  "/v1/transfer",
  "/v1/distribute",
]);

function detectionHints(source: FetchedSource) {
  return {
    url: source.finalUrl,
    ...(source.contentType === undefined ? {} : { contentType: source.contentType }),
  };
}

async function transformEntry(
  byteStream: ByteStream,
  transforms: Parameters<typeof applyEntryTransforms>[1],
  allowMultipartFormData: boolean,
): Promise<ByteStream> {
  const transformed = await applyEntryTransforms(byteStream, transforms, {
    allowMultipartFormData,
  });
  return limitEntryBytes(transformed);
}

function validateOutputHeaders(output: StreamRequest["output"]): void {
  if (output.contentType !== undefined && /[\r\n]/.test(output.contentType)) {
    throw new GatewayError("INVALID_CONTENT_TYPE", "The output content type is invalid.", {
      stage: "output-validate",
    });
  }
  if (output.filename !== undefined && /[\r\n]/.test(output.filename)) {
    throw new GatewayError("INVALID_HEADER", "The output filename is invalid.", {
      stage: "output-validate",
    });
  }
}

function validateStreamPipeline(input: StreamRequest): void {
  validateEntryTransforms(input.entryTransforms, { allowMultipartFormData: false });
  validateFinalTransforms(input.finalTransforms);
  validateCombinedTransforms(input.entryTransforms, input.finalTransforms);
  validateOutputHeaders(input.output);

  if (input.archive === undefined) {
    if (input.output.mode !== "raw") {
      throw new GatewayError("INVALID_REQUEST", "A raw source requires raw output mode.", {
        stage: "pipeline-validate",
      });
    }
    return;
  }

  assertUniqueSelectors(input.archive.entries);
  if (input.output.mode === "raw" && input.archive.entries.length !== 1) {
    throw new GatewayError("INVALID_REQUEST", "Raw output requires exactly one archive entry.", {
      stage: "pipeline-validate",
    });
  }
  if (
    input.output.mode === "multipart-mixed" &&
    input.output.contentType !== undefined &&
    !input.finalTransforms.some((transform) => transform.type === "gzip")
  ) {
    const segments = input.output.contentType.split(";").map((segment) => segment.trim());
    if (
      segments[0]?.toLowerCase() !== "multipart/mixed" ||
      segments.slice(1).some((segment) => /^boundary\s*=/i.test(segment))
    ) {
      throw new GatewayError(
        "INVALID_CONTENT_TYPE",
        "Multipart output must use multipart/mixed without a caller-supplied boundary.",
        { stage: "output-validate" },
      );
    }
  }
}

function multipartOutputOptions(
  input: StreamRequest,
  boundary: string,
): Pick<StreamRequest["output"], "contentType" | "filename"> {
  const gzipFinal = input.finalTransforms.some((transform) => transform.type === "gzip");
  if (gzipFinal || input.output.contentType === undefined) {
    return input.output;
  }
  return {
    ...input.output,
    contentType: `${input.output.contentType}; boundary=${boundary}`,
  };
}

async function executeProbe(
  input: ProbeRequest,
  signal: AbortSignal,
  log?: RequestLogContext,
) {
  log?.setSource(input.source.url);
  const result = await probeSource(input.source, signal, (source) => log?.observeSource(source));
  log?.patch({ archiveFormat: result.detected.format });
  log?.markResult("ok");
  return result;
}

async function executeList(
  input: ListRequest,
  signal: AbortSignal,
  log?: RequestLogContext,
) {
  log?.setSource(input.source.url);
  const source = await fetchSource(input.source, signal);
  log?.observeSource(source);
  try {
    const archive = await openArchive(
      source.byteStream,
      detectionHints(source),
      { listMode: true },
    );
    const listed = await listOpenedArchive(archive, input.options.maxEntries);
    log?.patch({ archiveFormat: archive.format, entriesScanned: listed.entries.length });
    log?.markResult("ok");
    return {
      ok: true,
      format: archive.format,
      layers: archive.layers,
      entries: listed.entries,
      truncated: listed.truncated,
      sourceGets: source.stats.sourceGets,
    };
  } catch (error) {
    source.byteStream.abort(error);
    throw error;
  }
}

async function executeStream(
  input: StreamRequest,
  signal: AbortSignal,
  log?: RequestLogContext,
): Promise<Response> {
  validateStreamPipeline(input);
  log?.setSource(input.source.url);
  const source = await fetchSource(input.source, signal);
  log?.observeSource(source);
  try {
    if (input.archive === undefined) {
      const entryOutput = await transformEntry(source.byteStream, input.entryTransforms, false);
      const finalOutput = await inferByteStreamContentType(
        limitBytes(
          await applyFinalTransforms(entryOutput, input.finalTransforms),
          LIMITS.requestOutputBytes,
        ),
      );
      return rawResponse(log === undefined ? finalOutput : observeByteStream(finalOutput, log), input.output);
    }

    const archive = await openArchive(
      source.byteStream,
      detectionHints(source),
      { occurrencePaths: selectorOccurrencePaths(input.archive.entries) },
    );
    log?.patch({ archiveFormat: archive.format });

    if (input.output.mode === "multipart-mixed") {
      const multipart = await createMultipartMixedStream(
        archive,
        input.archive.entries,
        input.entryTransforms,
        input.finalTransforms,
        signal,
        (manifest, stats) => {
          log?.patch({ entriesScanned: stats.entriesScanned });
          log?.markResult(
            manifest.ok ? "ok" : manifest.emitted > 0 ? "partial" : "error",
            manifest.errors[0],
          );
        },
      );
      return rawResponse(
        log === undefined
          ? multipart.byteStream
          : observeByteStream(multipart.byteStream, log),
        multipartOutputOptions(input, multipart.boundary),
      );
    }

    const selected = await selectSingleEntry(archive, input.archive.entries[0]!);
    const entryOutput = await transformEntry(selected.byteStream, input.entryTransforms, false);
    const finalOutput = await inferByteStreamContentType(
      limitBytes(
        await applyFinalTransforms(entryOutput, input.finalTransforms),
        LIMITS.requestOutputBytes,
      ),
    );
    return rawResponse(log === undefined ? finalOutput : observeByteStream(finalOutput, log), input.output);
  } catch (error) {
    source.byteStream.abort(error);
    throw error;
  }
}

async function executeTransfer(
  input: TransferRequest,
  signal: AbortSignal,
  log?: RequestLogContext,
) {
  validateEntryTransforms(input.entryTransforms, { allowMultipartFormData: true });
  validateHttpTarget(input.target);
  if (input.archive !== undefined) {
    assertUniqueSelectors(input.archive.entries);
    if (input.archive.entries.length !== 1) {
      throw new GatewayError(
        "INVALID_REQUEST",
        "A transfer requires exactly one archive entry.",
        { stage: "pipeline-validate" },
      );
    }
  }
  log?.setSource(input.source.url);
  const source = await fetchSource(input.source, signal);
  log?.observeSource(source);

  try {
    let byteStream = source.byteStream;
    if (input.archive !== undefined) {
      const archive = await openArchive(
        source.byteStream,
        detectionHints(source),
        { occurrencePaths: selectorOccurrencePaths(input.archive.entries) },
      );
      log?.patch({ archiveFormat: archive.format });
      byteStream = (
        await selectSingleEntry(archive, input.archive.entries[0]!)
      ).byteStream;
    }
    byteStream = await transformEntry(byteStream, input.entryTransforms, true);
    byteStream = await inferByteStreamContentType(byteStream);
    const result = await uploadByteStream(byteStream, input.target, signal);
    log?.patch({ bytesWritten: result.bytesWritten });
    log?.markResult("ok");
    return {
      ok: true,
      sourceGets: source.stats.sourceGets,
      bytesRead: source.stats.bytesRead,
      ...result,
    };
  } catch (error) {
    source.byteStream.abort(error);
    throw error;
  }
}

async function executeDistribute(
  input: DistributeRequest,
  signal: AbortSignal,
  log?: RequestLogContext,
) {
  validateDistributionRoutes(input.routes);
  log?.setSource(input.source.url);
  const source = await fetchSource(input.source, signal);
  log?.observeSource(source);
  try {
    const archive = await openArchive(
      source.byteStream,
      detectionHints(source),
      { occurrencePaths: selectorOccurrencePaths(input.routes) },
    );
    const result = await distributeArchive(
      archive,
      input.routes,
      input.failurePolicy,
      signal,
      source.stats.sourceGets,
    );
    const routesCompleted = result.results.filter(({ status }) => status === "uploaded").length;
    const routesMissing = result.results.filter(({ status }) => status === "missing").length;
    const routesFailed = result.results.filter(
      ({ status }) => status === "failed" || status === "not-run",
    ).length;
    log?.patch({
      archiveFormat: result.archiveFormat,
      routesRequested: input.routes.length,
      routesCompleted,
      routesFailed,
      routesMissing,
      entriesScanned: result.entriesScanned,
      bytesWritten: result.bytesWritten,
    });
    log?.markResult(result.ok ? "ok" : routesCompleted > 0 ? "partial" : "error");
    return result;
  } catch (error) {
    source.byteStream.abort(error);
    throw error;
  }
}

export function createGatewayOperations(
  env: Env,
  origin: string | URL,
  log?: RequestLogContext,
): GatewayOperations {
  return {
    probeUrl: (input, signal) =>
      runGatewayOperation(log, "probe_url", input.source.url, () =>
        executeProbe(input, signal, log),
      ),
    listArchive: (input, signal) =>
      runGatewayOperation(log, "list_archive", input.source.url, () =>
        executeList(input, signal, log),
      ),
    createStreamUrl: (input) =>
      runGatewayOperation(log, "create_stream_url", input.source.url, async () => {
        validateStreamPipeline(input);
        const signed = await createSignedStreamUrl(origin, input, env.URL_SIGNING_SECRET);
        return { ok: true, ...signed };
      }),
    transfer: (input, signal) =>
      runGatewayOperation(log, "transfer", input.source.url, () =>
        executeTransfer(input, signal, log),
      ),
    distributeArchive: (input, signal) =>
      runGatewayOperation(log, "distribute_archive", input.source.url, () =>
        executeDistribute(input, signal, log),
      ),
  };
}

async function runGatewayOperation<T extends object>(
  log: RequestLogContext | undefined,
  operation: string,
  sourceUrl: string,
  run: () => Promise<T>,
): Promise<T> {
  log?.setOperation(operation);
  log?.setSource(sourceUrl);
  try {
    const result = await run();
    log?.markResult("ok");
    return result;
  } catch (error) {
    log?.markResult("error", error);
    throw error;
  }
}

async function handleProbe(request: Request, log: RequestLogContext): Promise<Response> {
  log.setOperation("probe_url");
  const input = parseSchema(probeRequestSchema, await readJsonRequest(request));
  return Response.json(await executeProbe(input, request.signal, log), {
    headers: { "Cache-Control": "no-store" },
  });
}

async function handleList(request: Request, log: RequestLogContext): Promise<Response> {
  log.setOperation("list_archive");
  const input = parseSchema(listRequestSchema, await readJsonRequest(request));
  return Response.json(await executeList(input, request.signal, log), {
    headers: { "Cache-Control": "no-store" },
  });
}

async function handleStream(
  request: Request,
  env: Env,
  log: RequestLogContext,
): Promise<Response> {
  log.setOperation("stream");
  const value =
    request.method === "GET"
      ? await verifySignedStreamUrl(new URL(request.url).searchParams, env.URL_SIGNING_SECRET)
      : await readJsonRequest(request);
  return executeStream(parseSchema(streamRequestSchema, value), request.signal, log);
}

async function handleTransfer(request: Request, log: RequestLogContext): Promise<Response> {
  log.setOperation("transfer");
  const input = parseSchema(transferRequestSchema, await readJsonRequest(request));
  return Response.json(await executeTransfer(input, request.signal, log), {
    headers: { "Cache-Control": "no-store" },
  });
}

async function handleDistribute(request: Request, log: RequestLogContext): Promise<Response> {
  log.setOperation("distribute_archive");
  const input = parseSchema(distributeRequestSchema, await readJsonRequest(request));
  return Response.json(await executeDistribute(input, request.signal, log), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function routeRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const operation = `${request.method} ${url.pathname}`;
  const log = createRequestLogContext(operation);

  try {
    if (request.method === "GET" && url.pathname === "/healthz") {
      log.setOperation("healthz");
      const response = Response.json({ ok: true, service: "streamr", version: "0.2.0" });
      return observeResponseCompletion(response, log);
    }

    if (
      AUTHENTICATED_POST_ROUTES.has(url.pathname) &&
      !(url.pathname === "/v1/stream" && request.method === "GET")
    ) {
      if (request.method !== "POST") {
        throw new GatewayError("INVALID_REQUEST", "The HTTP method is not allowed.", {
          stage: "route",
          status: 405,
        });
      }
      await requireBearer(request, env.MCP_API_TOKEN);
    }

    let response: Response;
    if (url.pathname === "/v1/probe") response = await handleProbe(request, log);
    else if (
      url.pathname === "/v1/stream" &&
      (request.method === "POST" || request.method === "GET")
    ) {
      response = await handleStream(request, env, log);
    } else if (url.pathname === "/v1/transfer") {
      response = await handleTransfer(request, log);
    } else if (url.pathname === "/v1/list") {
      response = await handleList(request, log);
    } else if (url.pathname === "/v1/distribute") {
      response = await handleDistribute(request, log);
    } else if (url.pathname === "/mcp") {
      throw new GatewayError("INVALID_REQUEST", "The MCP handler is not initialized.", {
        stage: "mcp",
        status: 503,
      });
    } else {
      throw new GatewayError("INVALID_REQUEST", "Route not found.", {
        stage: "route",
        status: 404,
      });
    }

    return url.pathname === "/v1/stream"
      ? response
      : observeResponseCompletion(response, log);
  } catch (error) {
    const gatewayError = asGatewayError(error);
    log.markResult("error", gatewayError);
    log.finish();
    return errorResponse(gatewayError, log.requestId);
  }
}
