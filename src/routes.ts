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
import { rawResponse } from "./outputs/raw-response";
import { uploadByteStream } from "./outputs/transfer";
import {
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
  limitBytes,
  validateEntryTransforms,
  validateFinalTransforms,
} from "./transforms";
import { readJsonRequest } from "./util/json";
import { logRequest, requestId, safeUrlParts } from "./util/logging";

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
  return limitBytes(transformed, LIMITS.entryOutputBytes);
}

async function handleProbe(request: Request): Promise<Response> {
  const value = await readJsonRequest(request);
  const input = parseSchema(probeRequestSchema, value);
  return Response.json(await probeSource(input.source, request.signal), {
    headers: { "Cache-Control": "no-store" },
  });
}

async function handleList(request: Request): Promise<Response> {
  const value = await readJsonRequest(request);
  const input = parseSchema(listRequestSchema, value);
  const source = await fetchSource(input.source, request.signal);
  try {
    const archive = await openArchive(
      source.byteStream,
      detectionHints(source),
      { listMode: true },
    );
    const listed = await listOpenedArchive(archive, input.options.maxEntries);
    return Response.json(
      {
        ok: true,
        format: archive.format,
        layers: archive.layers,
        entries: listed.entries,
        truncated: listed.truncated,
        sourceGets: source.stats.sourceGets,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    source.byteStream.abort(error);
    throw error;
  }
}

async function handleStream(request: Request): Promise<Response> {
  const value = await readJsonRequest(request);
  const input = parseSchema(streamRequestSchema, value);
  validateEntryTransforms(input.entryTransforms, { allowMultipartFormData: false });
  validateFinalTransforms(input.finalTransforms);
  if (input.archive === undefined) {
    if (input.output.mode !== "raw") {
      throw new GatewayError("INVALID_REQUEST", "A raw source requires raw output mode.", {
        stage: "pipeline-validate",
      });
    }
  } else {
    assertUniqueSelectors(input.archive.entries);
    if (input.output.mode !== "raw" || input.archive.entries.length !== 1) {
      throw new GatewayError("INVALID_REQUEST", "Raw output requires exactly one archive entry.", {
        stage: "pipeline-validate",
      });
    }
  }

  const source = await fetchSource(input.source, request.signal);
  if (input.archive === undefined) {
    const entryOutput = await transformEntry(source.byteStream, input.entryTransforms, false);
    const finalOutput = limitBytes(
      await applyFinalTransforms(entryOutput, input.finalTransforms),
      LIMITS.requestOutputBytes,
    );
    return rawResponse(finalOutput, input.output);
  }

  const archive = await openArchive(
    source.byteStream,
    detectionHints(source),
    { occurrencePaths: selectorOccurrencePaths(input.archive.entries) },
  );
  const selected = await selectSingleEntry(archive, input.archive.entries[0]!);
  const entryOutput = await transformEntry(selected.byteStream, input.entryTransforms, false);
  const finalOutput = limitBytes(
    await applyFinalTransforms(entryOutput, input.finalTransforms),
    LIMITS.requestOutputBytes,
  );
  return rawResponse(finalOutput, input.output);
}

async function handleTransfer(request: Request): Promise<Response> {
  const value = await readJsonRequest(request);
  const input = parseSchema(transferRequestSchema, value);
  validateEntryTransforms(input.entryTransforms, { allowMultipartFormData: true });
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
  const source = await fetchSource(input.source, request.signal);

  try {
    let byteStream = source.byteStream;
    if (input.archive !== undefined) {
      const archive = await openArchive(
        source.byteStream,
        detectionHints(source),
        { occurrencePaths: selectorOccurrencePaths(input.archive.entries) },
      );
      byteStream = (
        await selectSingleEntry(archive, input.archive.entries[0]!)
      ).byteStream;
    }
    byteStream = await transformEntry(byteStream, input.entryTransforms, true);
    const result = await uploadByteStream(byteStream, input.target, request.signal);
    return Response.json(
      {
        ok: true,
        sourceGets: source.stats.sourceGets,
        bytesRead: source.stats.bytesRead,
        ...result,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    source.byteStream.abort(error);
    throw error;
  }
}

export async function routeRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const id = requestId();
  const startedAt = performance.now();
  const url = new URL(request.url);
  const operation = `${request.method} ${url.pathname}`;

  try {
    if (request.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "streamr", version: "0.2.0" });
    }

    if (AUTHENTICATED_POST_ROUTES.has(url.pathname)) {
      if (request.method !== "POST") {
        throw new GatewayError("INVALID_REQUEST", "The HTTP method is not allowed.", {
          stage: "route",
          status: 405,
        });
      }
      await requireBearer(request, env.MCP_API_TOKEN);
    }

    let response: Response;
    if (url.pathname === "/v1/probe") response = await handleProbe(request);
    else if (url.pathname === "/v1/stream" && request.method === "POST") {
      response = await handleStream(request);
    } else if (url.pathname === "/v1/transfer") {
      response = await handleTransfer(request);
    } else if (url.pathname === "/v1/list") {
      response = await handleList(request);
    } else if (url.pathname === "/v1/distribute") {
      throw new GatewayError("NOT_AN_ARCHIVE", "Archive distribution requires an archive source.", {
        stage: "archive-detect",
      });
    } else if (url.pathname === "/mcp") {
      throw new GatewayError("INVALID_REQUEST", "The MCP handler is not initialized.", {
        stage: "mcp",
        status: 503,
      });
    } else if (url.pathname === "/v1/stream" && request.method === "GET") {
      throw new GatewayError("SIGNATURE_INVALID", "The signed URL is invalid.", {
        stage: "signature",
      });
    } else {
      throw new GatewayError("INVALID_REQUEST", "Route not found.", {
        stage: "route",
        status: 404,
      });
    }

    logRequest({
      requestId: id,
      operation,
      durationMs: Math.round(performance.now() - startedAt),
      result: "ok",
    });
    return response;
  } catch (error) {
    const gatewayError = asGatewayError(error);
    const source =
      typeof error === "object" && error !== null && "sourceUrl" in error
        ? safeUrlParts(String(error.sourceUrl))
        : undefined;
    console.error(
      JSON.stringify({
        requestId: id,
        operation,
        durationMs: Math.round(performance.now() - startedAt),
        result: "error",
        errorCode: gatewayError.code,
        ...(source === undefined ? {} : { source }),
      }),
    );
    return errorResponse(gatewayError, id);
  }
}
