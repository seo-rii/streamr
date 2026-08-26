import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { asGatewayError } from "../errors";
import {
  distributeRequestSchema,
  listRequestSchema,
  probeRequestSchema,
  streamRequestSchema,
  transferRequestSchema,
} from "../schemas";

type ProbeRequest = z.infer<typeof probeRequestSchema>;
type ListRequest = z.infer<typeof listRequestSchema>;
type CreateStreamUrlRequest = z.infer<typeof streamRequestSchema>;
type TransferRequest = z.infer<typeof transferRequestSchema>;
type DistributeRequest = z.infer<typeof distributeRequestSchema>;

export type GatewayOperationResult = object;

/**
 * Request-scoped gateway capabilities injected by the HTTP routing layer.
 *
 * The MCP adapter deliberately invokes these operations directly instead of
 * making a subrequest back to its own Worker. Implementations can therefore
 * close over the current Env and public request origin without introducing a
 * second authentication or buffering boundary.
 */
export interface GatewayOperations {
  probeUrl(input: ProbeRequest, signal: AbortSignal): Promise<GatewayOperationResult>;
  listArchive(input: ListRequest, signal: AbortSignal): Promise<GatewayOperationResult>;
  createStreamUrl(
    input: CreateStreamUrlRequest,
    signal: AbortSignal,
  ): Promise<GatewayOperationResult>;
  transfer(input: TransferRequest, signal: AbortSignal): Promise<GatewayOperationResult>;
  distributeArchive(
    input: DistributeRequest,
    signal: AbortSignal,
  ): Promise<GatewayOperationResult>;
}

function operationResult(value: GatewayOperationResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function operationError(error: unknown): CallToolResult {
  const gatewayError = asGatewayError(error);
  const value = {
    ok: false,
    error: gatewayError.serialize(),
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function runOperation(
  operation: () => Promise<GatewayOperationResult>,
): Promise<CallToolResult> {
  try {
    return operationResult(await operation());
  } catch (error) {
    return operationError(error);
  }
}

export function registerGatewayTools(server: McpServer, operations: GatewayOperations): void {
  server.registerTool(
    "probe_url",
    {
      title: "Probe URL",
      description: "Inspect an HTTP or HTTPS source and detect its stream or archive format.",
      inputSchema: probeRequestSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, ctx) => runOperation(() => operations.probeUrl(input, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "list_archive",
    {
      title: "List Archive",
      description: "Stream an archive once and return entries in archive order.",
      inputSchema: listRequestSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, ctx) => runOperation(() => operations.listArchive(input, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "create_stream_url",
    {
      title: "Create Stream URL",
      description: "Create a short-lived signed URL for a validated streaming pipeline.",
      inputSchema: streamRequestSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input, ctx) => runOperation(() => operations.createStreamUrl(input, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "transfer",
    {
      title: "Transfer Stream",
      description: "Stream one source or archive entry to an external HTTP target.",
      inputSchema: transferRequestSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input, ctx) => runOperation(() => operations.transfer(input, ctx.mcpReq.signal)),
  );

  server.registerTool(
    "distribute_archive",
    {
      title: "Distribute Archive",
      description:
        "Stream selected archive entries sequentially to independent external HTTP targets.",
      inputSchema: distributeRequestSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input, ctx) =>
      runOperation(() => operations.distributeArchive(input, ctx.mcpReq.signal)),
  );
}
