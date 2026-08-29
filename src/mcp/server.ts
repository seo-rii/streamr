import {
  McpServer,
  type McpHandlerRequestOptions,
} from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  type StatelessMcpHandler,
} from "agents/mcp/server";
import { GatewayError } from "../errors";
import { readJsonRequest } from "../util/json";
import {
  registerGatewayTools,
  type GatewayOperations,
  type GatewayToolAuthPolicy,
} from "./tools";

export type GatewayOperationsProvider = (
  request: Request | undefined,
) => GatewayOperations;

export function createServer(
  operations: GatewayOperations,
  authPolicy: GatewayToolAuthPolicy = { mode: "token" },
): McpServer {
  const server = new McpServer({
    name: "stateless-stream-gateway",
    version: "0.2.0",
  });
  registerGatewayTools(server, operations, authPolicy);
  return server;
}

/**
 * Create the stateless Streamable HTTP endpoint.
 *
 * Passing a provider allows the caller to derive request-local operations
 * from the original URL (for signed-URL origin handling). The SDK factory
 * still constructs a distinct McpServer for every HTTP request.
 */
export function createGatewayMcpHandler(
  operations: GatewayOperations | GatewayOperationsProvider,
  authPolicy: GatewayToolAuthPolicy = { mode: "token" },
): StatelessMcpHandler {
  const sdkHandler = createMcpHandler(
    (context) =>
      createServer(
        typeof operations === "function"
          ? operations(context.requestInfo)
          : operations,
        authPolicy,
      ),
    {
      route: "/mcp",
      legacy: "stateless",
      responseMode: "auto",
    },
  );

  const fetch = async (
    request: Request,
    options?: McpHandlerRequestOptions,
  ): Promise<Response> => {
    if (request.method !== "POST") return sdkHandler.fetch(request, options);

    let parsedBody = options?.parsedBody;
    if (parsedBody === undefined) {
      try {
        parsedBody = await readJsonRequest(request);
      } catch (error) {
        const status = error instanceof GatewayError ? error.status : 400;
        return Response.json(
          {
            jsonrpc: "2.0",
            error: {
              code: status === 413 ? -32600 : -32700,
              message:
                status === 413
                  ? "Invalid Request: request body is too large"
                  : "Parse error: invalid JSON request body",
            },
            id: null,
          },
          { status },
        );
      }
    }

    // The gateway deliberately permits at most one operation per inbound
    // request, including for 2025-era clients whose protocol otherwise permits
    // JSON-RPC batches. This prevents concurrent mutating pipelines from
    // sharing one invocation's control-plane lifecycle and log context.
    if (Array.isArray(parsedBody)) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message: "Invalid Request: JSON-RPC batches are not supported",
          },
          id: null,
        },
        { status: 400 },
      );
    }

    return sdkHandler.fetch(request, { ...options, parsedBody });
  };

  const handler = (
    request: Request,
    _env: unknown,
    _ctx: ExecutionContext,
  ): Promise<Response> => fetch(request);

  return Object.assign(handler, {
    fetch,
    notify: sdkHandler.notify,
  });
}
