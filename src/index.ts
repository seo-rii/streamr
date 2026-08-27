import { requireBearer } from "./auth";
import { asGatewayError, errorResponse, GatewayError } from "./errors";
import { createGatewayMcpHandler } from "./mcp/server";
import { createGatewayOperations, routeRequest } from "./routes";
import {
  createRequestLogContext,
  observeResponseCompletion,
} from "./util/logging";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      const log = createRequestLogContext("mcp");
      try {
        if (request.method !== "POST") {
          throw new GatewayError("INVALID_REQUEST", "The HTTP method is not allowed.", {
            stage: "route",
            status: 405,
          });
        }
        await requireBearer(request, env.MCP_API_TOKEN);
        const handler = createGatewayMcpHandler((mcpRequest) =>
          createGatewayOperations(
            env,
            new URL(mcpRequest?.url ?? request.url).origin,
            log,
          ),
        );
        const response = await handler.fetch(request);
        return observeResponseCompletion(response, log);
      } catch (error) {
        const gatewayError = asGatewayError(error);
        log.markResult("error", gatewayError);
        log.finish();
        return errorResponse(gatewayError, log.requestId);
      }
    }
    return routeRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
