import type { AuthInfo, CallToolResult, McpServer } from "@modelcontextprotocol/server";
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

export type GatewayToolAuthPolicy =
  | { mode: "token" }
  | {
      mode: "oauth";
      readScopes: readonly string[];
      writeScopes: readonly string[];
      resourceMetadataUrl: string;
    };

type OAuthSecurityScheme = {
  type: "oauth2";
  scopes: string[];
};

/**
 * Advertise OAuth only when the MCP endpoint is actually running in OAuth
 * mode. The `_meta` copy keeps compatibility with OpenAI clients that used
 * the pre-standard mirror; the canonical top-level field is emitted as well.
 */
function toolSecurity(
  policy: GatewayToolAuthPolicy,
  access: "read" | "write",
):
  | {
      securitySchemes: OAuthSecurityScheme[];
      _meta: { securitySchemes: OAuthSecurityScheme[] };
    }
  | Record<string, never> {
  if (policy.mode !== "oauth") return {};

  const securitySchemes: OAuthSecurityScheme[] = [
    {
      type: "oauth2",
      scopes: [
        ...(access === "read" ? policy.readScopes : policy.writeScopes),
      ],
    },
  ];
  return {
    securitySchemes,
    _meta: { securitySchemes },
  };
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

function insufficientScopeResult(
  requiredScopes: readonly string[],
  grantedScopes: readonly string[],
  supportedScopes: readonly string[],
  resourceMetadataUrl: string,
): CallToolResult {
  const requestedScopes = [
    ...new Set([
      ...grantedScopes.filter((scope) => supportedScopes.includes(scope)),
      ...requiredScopes,
    ]),
  ];
  const challenge =
    `Bearer error="insufficient_scope", ` +
    `error_description="The bearer token does not grant the required scope.", ` +
    `scope="${requestedScopes.join(" ")}", ` +
    `resource_metadata="${resourceMetadataUrl}"`;
  const value = {
    ok: false,
    error: {
      code: "AUTH_INVALID",
      message: "The OAuth access token does not grant the required scope.",
      stage: "auth",
      retryable: false,
      details: { requiredScopes: [...requiredScopes] },
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    _meta: { "mcp/www_authenticate": [challenge] },
  };
}

function runAuthorizedOperation(
  authPolicy: GatewayToolAuthPolicy,
  access: "read" | "write",
  authInfo: AuthInfo | undefined,
  operation: () => Promise<GatewayOperationResult>,
): Promise<CallToolResult> | CallToolResult {
  if (authPolicy.mode === "oauth") {
    const requiredScopes =
      access === "read" ? authPolicy.readScopes : authPolicy.writeScopes;
    if (
      authInfo === undefined ||
      requiredScopes.some((scope) => !authInfo.scopes.includes(scope))
    ) {
      return insufficientScopeResult(
        requiredScopes,
        authInfo?.scopes ?? [],
        [...authPolicy.readScopes, ...authPolicy.writeScopes],
        authPolicy.resourceMetadataUrl,
      );
    }
  }
  return runOperation(operation);
}

export function registerGatewayTools(
  server: McpServer,
  operations: GatewayOperations,
  authPolicy: GatewayToolAuthPolicy = { mode: "token" },
): void {
  server.registerTool(
    "probe_url",
    {
      ...toolSecurity(authPolicy, "read"),
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
    (input, ctx) =>
      runAuthorizedOperation(authPolicy, "read", ctx.http?.authInfo, () =>
        operations.probeUrl(input, ctx.mcpReq.signal),
      ),
  );

  server.registerTool(
    "list_archive",
    {
      ...toolSecurity(authPolicy, "read"),
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
    (input, ctx) =>
      runAuthorizedOperation(authPolicy, "read", ctx.http?.authInfo, () =>
        operations.listArchive(input, ctx.mcpReq.signal),
      ),
  );

  server.registerTool(
    "create_stream_url",
    {
      ...toolSecurity(authPolicy, "read"),
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
    (input, ctx) =>
      runAuthorizedOperation(authPolicy, "read", ctx.http?.authInfo, () =>
        operations.createStreamUrl(input, ctx.mcpReq.signal),
      ),
  );

  server.registerTool(
    "transfer",
    {
      ...toolSecurity(authPolicy, "write"),
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
    (input, ctx) =>
      runAuthorizedOperation(authPolicy, "write", ctx.http?.authInfo, () =>
        operations.transfer(input, ctx.mcpReq.signal),
      ),
  );

  server.registerTool(
    "distribute_archive",
    {
      ...toolSecurity(authPolicy, "write"),
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
      runAuthorizedOperation(authPolicy, "write", ctx.http?.authInfo, () =>
        operations.distributeArchive(input, ctx.mcpReq.signal),
      ),
  );
}
