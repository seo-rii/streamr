import { McpServer } from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  type StatelessMcpHandler,
} from "agents/mcp/server";
import { registerGatewayTools, type GatewayOperations } from "./tools";

export type GatewayOperationsProvider = (
  request: Request | undefined,
) => GatewayOperations;

export function createServer(operations: GatewayOperations): McpServer {
  const server = new McpServer({
    name: "stateless-stream-gateway",
    version: "0.2.0",
  });
  registerGatewayTools(server, operations);
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
): StatelessMcpHandler {
  return createMcpHandler(
    (context) =>
      createServer(
        typeof operations === "function"
          ? operations(context.requestInfo)
          : operations,
      ),
    {
      route: "/mcp",
      legacy: "stateless",
      responseMode: "auto",
    },
  );
}
