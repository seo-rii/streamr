import { asGatewayError, errorResponse, GatewayError } from "./errors";
import { createGatewayMcpHandler } from "./mcp/server";
import {
  authenticateMcpRequest,
  oauthChallengeResponse,
  protectedResourceMetadataResponse,
  resolveMcpAuthConfig,
  type McpAuthConfig,
} from "./oauth";
import {
  handleEmbeddedOAuthServerRequest,
  isEmbeddedOAuthServerPath,
} from "./oauth-server";
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
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      const log = createRequestLogContext("oauth_metadata");
      try {
        const authConfig = resolveMcpAuthConfig(env, request.url);
        const metadataResponse = protectedResourceMetadataResponse(request, authConfig);
        if (metadataResponse !== undefined) {
          log.markResult("ok");
          return observeResponseCompletion(metadataResponse, log);
        }
        throw new GatewayError("INVALID_REQUEST", "Route not found.", {
          stage: "route",
          status: 404,
        });
      } catch (error) {
        const gatewayError = asGatewayError(error);
        log.markResult("error", gatewayError);
        log.finish();
        return errorResponse(gatewayError, log.requestId);
      }
    }

    if (isEmbeddedOAuthServerPath(url.pathname)) {
      const log = createRequestLogContext("oauth_server");
      try {
        const authConfig = resolveMcpAuthConfig(env, request.url);
        if (authConfig.mode === "oauth") {
          const response = await handleEmbeddedOAuthServerRequest(
            request,
            authConfig,
          );
          return observeResponseCompletion(response, log);
        }
        throw new GatewayError("INVALID_REQUEST", "Route not found.", {
          stage: "route",
          status: 404,
        });
      } catch (error) {
        const gatewayError = asGatewayError(error);
        log.markResult("error", gatewayError);
        log.finish();
        return errorResponse(gatewayError, log.requestId);
      }
    }

    if (url.pathname === "/mcp") {
      const log = createRequestLogContext("mcp");
      let authConfig: McpAuthConfig | undefined;
      try {
        if (request.method !== "POST") {
          throw new GatewayError("INVALID_REQUEST", "The HTTP method is not allowed.", {
            stage: "route",
            status: 405,
          });
        }
        authConfig = resolveMcpAuthConfig(env, request.url);
        const authInfo = await authenticateMcpRequest(request, authConfig);
        const authPolicy =
          authConfig.mode === "oauth"
            ? {
                mode: "oauth" as const,
                readScopes: authConfig.readScopes,
                writeScopes: authConfig.writeScopes,
                resourceMetadataUrl: authConfig.resourceMetadataUrl,
              }
            : { mode: "token" as const };
        const handler = createGatewayMcpHandler(
          (mcpRequest) =>
            createGatewayOperations(
              env,
              new URL(mcpRequest?.url ?? request.url).origin,
              log,
            ),
          authPolicy,
        );
        const response = await handler.fetch(request, { authInfo });
        return observeResponseCompletion(response, log);
      } catch (error) {
        const gatewayError = asGatewayError(error);
        log.markResult("error", gatewayError);
        log.finish();
        if (authConfig?.mode === "oauth") {
          return oauthChallengeResponse(gatewayError, authConfig, log.requestId);
        }
        return errorResponse(gatewayError, log.requestId);
      }
    }
    return routeRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
