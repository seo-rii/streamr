import { requireBearer } from "./auth";
import { GatewayError, asGatewayError, errorResponse } from "./errors";
import { rawResponse } from "./outputs/raw-response";
import { uploadByteStream } from "./outputs/transfer";
import {
  parseSchema,
  probeRequestSchema,
  streamRequestSchema,
  transferRequestSchema,
} from "./schemas";
import { fetchSource } from "./source/fetch";
import { probeSource } from "./source/probe";
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

function requireRawPipeline(input: {
  archive?: unknown;
  entryTransforms: readonly unknown[];
  finalTransforms?: readonly unknown[];
  output?: { mode: "raw" | "multipart-mixed" };
}): void {
  if (
    input.archive !== undefined ||
    input.entryTransforms.length !== 0 ||
    (input.finalTransforms?.length ?? 0) !== 0 ||
    input.output?.mode === "multipart-mixed"
  ) {
    throw new GatewayError(
      "INVALID_REQUEST",
      "This pipeline requires archive or transform processing.",
      { stage: "pipeline-validate" },
    );
  }
}

async function handleProbe(request: Request): Promise<Response> {
  const value = await readJsonRequest(request);
  const input = parseSchema(probeRequestSchema, value);
  return Response.json(await probeSource(input.source, request.signal), {
    headers: { "Cache-Control": "no-store" },
  });
}

async function handleRawStream(request: Request): Promise<Response> {
  const value = await readJsonRequest(request);
  const input = parseSchema(streamRequestSchema, value);
  requireRawPipeline(input);
  const source = await fetchSource(input.source, request.signal);
  return rawResponse(source.byteStream, input.output);
}

async function handleRawTransfer(request: Request): Promise<Response> {
  const value = await readJsonRequest(request);
  const input = parseSchema(transferRequestSchema, value);
  requireRawPipeline(input);
  const source = await fetchSource(input.source, request.signal);

  try {
    const result = await uploadByteStream(source.byteStream, input.target, request.signal);
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
      response = await handleRawStream(request);
    } else if (url.pathname === "/v1/transfer") {
      response = await handleRawTransfer(request);
    } else if (url.pathname === "/v1/list") {
      throw new GatewayError("NOT_AN_ARCHIVE", "Archive listing is not available for a raw stream.", {
        stage: "archive-detect",
      });
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

