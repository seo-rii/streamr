import {
  getOAuthProtectedResourceMetadataUrl,
  type AuthInfo,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";
import { requireBearer } from "./auth";
import { asGatewayError, errorResponse, GatewayError } from "./errors";
import { readEmbeddedAccessToken } from "./oauth-server";

const DEFAULT_READ_SCOPES = ["streamr.read"] as const;
const DEFAULT_WRITE_SCOPES = ["streamr.write"] as const;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 12 * 60 * 60;
const MAX_ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_SIGNING_SECRET_BYTES = 32;
const MIN_LOGIN_PASSWORD_BYTES = 16;

export interface McpAuthEnvironment {
  MCP_API_TOKEN?: string;
  MCP_AUTH_MODE?: string;
  MCP_OAUTH_RESOURCE?: string;
  MCP_OAUTH_SIGNING_SECRET?: string;
  MCP_OAUTH_LOGIN_USERNAME?: string;
  MCP_OAUTH_LOGIN_PASSWORD?: string;
  MCP_OAUTH_ALLOWED_REDIRECT_URIS?: string;
  MCP_OAUTH_READ_SCOPES?: string;
  MCP_OAUTH_WRITE_SCOPES?: string;
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS?: string;
}

export interface McpTokenAuthConfig {
  mode: "token";
  token: string;
}

export interface McpOAuthAuthConfig {
  mode: "oauth";
  issuer: string;
  resource: URL;
  signingSecret: string;
  loginUsername: string;
  loginPassword: string;
  subject: string;
  allowedRedirectUris: ReadonlySet<string>;
  readScopes: string[];
  writeScopes: string[];
  scopes: string[];
  accessTokenTtlSeconds: number;
  resourceMetadataUrl: string;
}

export type McpAuthConfig = McpTokenAuthConfig | McpOAuthAuthConfig;

function configurationError(message: string, field?: string): GatewayError {
  return new GatewayError("INTERNAL_ERROR", message, {
    stage: "auth-config",
    ...(field === undefined ? {} : { details: { field } }),
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function secureResourceUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(`${field} must be a valid HTTPS URL.`, field);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/mcp"
  ) {
    throw configurationError(
      `${field} must be the canonical HTTPS URL of the /mcp endpoint.`,
      field,
    );
  }
  return url;
}

function parseScopes(value: string | undefined, defaults: readonly string[]): string[] {
  const scopes = nonEmpty(value)?.split(/\s+/) ?? [...defaults];
  const unique = [...new Set(scopes)];
  if (
    unique.length === 0 ||
    unique.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))
  ) {
    throw configurationError("OAuth scopes must be valid space-delimited scope tokens.");
  }
  return unique;
}

function parseTtl(
  value: string | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const configured = nonEmpty(value);
  if (configured === undefined) return fallback;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw configurationError(
      `${field} must be an integer between ${minimum} and ${maximum}.`,
      field,
    );
  }
  return parsed;
}

function parseRedirectUris(value: string | undefined): ReadonlySet<string> {
  const configured = nonEmpty(value);
  if (configured === undefined) {
    throw configurationError(
      "MCP_OAUTH_ALLOWED_REDIRECT_URIS is required in OAuth mode.",
      "MCP_OAUTH_ALLOWED_REDIRECT_URIS",
    );
  }

  const uris = configured.split(",").map((entry) => entry.trim());
  const normalized = new Set<string>();
  for (const uri of uris) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw configurationError(
        "MCP_OAUTH_ALLOWED_REDIRECT_URIS contains an invalid URI.",
        "MCP_OAUTH_ALLOWED_REDIRECT_URIS",
      );
    }
    const isHttps = url.protocol === "https:";
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]");
    if (
      (!isHttps && !isLoopbackHttp) ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      throw configurationError(
        "OAuth redirect allowlist entries must be exact HTTPS URIs or explicit loopback HTTP URIs without fragments.",
        "MCP_OAUTH_ALLOWED_REDIRECT_URIS",
      );
    }
    normalized.add(uri);
  }
  if (normalized.size === 0) {
    throw configurationError(
      "At least one OAuth redirect URI is required.",
      "MCP_OAUTH_ALLOWED_REDIRECT_URIS",
    );
  }
  return normalized;
}

function requiredSecret(
  value: string | undefined,
  field: string,
  minimumBytes: number,
): string {
  const configured = nonEmpty(value);
  if (
    configured === undefined ||
    new TextEncoder().encode(configured).byteLength < minimumBytes
  ) {
    throw configurationError(
      `${field} must contain at least ${minimumBytes} UTF-8 bytes.`,
      field,
    );
  }
  return configured;
}

/** Resolve the request-local MCP authentication policy from Worker variables. */
export function resolveMcpAuthConfig(
  env: McpAuthEnvironment,
  requestUrl: string | URL,
): McpAuthConfig {
  const configuredMode = nonEmpty(env.MCP_AUTH_MODE) ?? "token";
  if (configuredMode === "token") {
    const token = nonEmpty(env.MCP_API_TOKEN);
    if (token === undefined) {
      throw configurationError("MCP_API_TOKEN is required in token mode.", "MCP_API_TOKEN");
    }
    return { mode: "token", token };
  }
  if (configuredMode !== "oauth") {
    throw configurationError(
      "MCP_AUTH_MODE must be either token or oauth.",
      "MCP_AUTH_MODE",
    );
  }

  const resourceValue = nonEmpty(env.MCP_OAUTH_RESOURCE);
  if (resourceValue === undefined) {
    throw configurationError(
      "MCP_OAUTH_RESOURCE is required in OAuth mode.",
      "MCP_OAUTH_RESOURCE",
    );
  }
  const resource = secureResourceUrl(resourceValue, "MCP_OAUTH_RESOURCE");
  const observed = new URL(requestUrl);
  if (observed.origin !== resource.origin) {
    throw configurationError(
      "The request origin does not match MCP_OAUTH_RESOURCE.",
      "MCP_OAUTH_RESOURCE",
    );
  }

  const signingSecret = requiredSecret(
    env.MCP_OAUTH_SIGNING_SECRET,
    "MCP_OAUTH_SIGNING_SECRET",
    MIN_SIGNING_SECRET_BYTES,
  );
  const loginUsername = nonEmpty(env.MCP_OAUTH_LOGIN_USERNAME);
  if (
    loginUsername === undefined ||
    loginUsername.length > 256 ||
    [...loginUsername].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw configurationError(
      "MCP_OAUTH_LOGIN_USERNAME must be a non-empty username without control characters.",
      "MCP_OAUTH_LOGIN_USERNAME",
    );
  }
  const loginPassword = requiredSecret(
    env.MCP_OAUTH_LOGIN_PASSWORD,
    "MCP_OAUTH_LOGIN_PASSWORD",
    MIN_LOGIN_PASSWORD_BYTES,
  );
  const readScopes = parseScopes(env.MCP_OAUTH_READ_SCOPES, DEFAULT_READ_SCOPES);
  const writeScopes = parseScopes(env.MCP_OAUTH_WRITE_SCOPES, DEFAULT_WRITE_SCOPES);
  const scopes = [...new Set([...readScopes, ...writeScopes])];

  return {
    mode: "oauth",
    issuer: resource.origin,
    resource,
    signingSecret,
    loginUsername,
    loginPassword,
    subject: `owner:${loginUsername}`,
    allowedRedirectUris: parseRedirectUris(
      env.MCP_OAUTH_ALLOWED_REDIRECT_URIS,
    ),
    readScopes,
    writeScopes,
    scopes,
    accessTokenTtlSeconds: parseTtl(
      env.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      "MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
      300,
      MAX_ACCESS_TOKEN_TTL_SECONDS,
    ),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
  };
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization");
  if (authorization === null) {
    throw new GatewayError("AUTH_REQUIRED", "Bearer authentication is required.", {
      stage: "auth",
    });
  }
  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/.exec(authorization);
  if (match?.[1] === undefined) {
    throw new GatewayError("AUTH_INVALID", "Bearer authentication is invalid.", {
      stage: "auth",
    });
  }
  return match[1];
}

function invalidToken(cause?: unknown): GatewayError {
  return new GatewayError("AUTH_INVALID", "Bearer authentication is invalid.", {
    stage: "auth",
    cause,
  });
}

/** Authenticate one MCP request without retaining cross-request state. */
export async function authenticateMcpRequest(
  request: Request,
  config: McpAuthConfig,
  requiredScopes: readonly string[] = [],
): Promise<AuthInfo> {
  if (config.mode === "token") {
    await requireBearer(request, config.token);
    return {
      token: bearerToken(request),
      clientId: "static-token",
      scopes: [],
    };
  }

  const token = bearerToken(request);
  const claims = await readEmbeddedAccessToken(token, config);
  if (claims === null) throw invalidToken();
  const scopes = [...new Set(claims.scope.split(/\s+/).filter(Boolean))];
  if (requiredScopes.some((scope) => !scopes.includes(scope))) {
    throw invalidToken();
  }
  return {
    token,
    clientId: claims.clientId,
    scopes,
    expiresAt: claims.exp,
    resource: config.resource,
    extra: { sub: claims.sub },
  };
}

/** Serve RFC 9728 metadata at the root and path-aware well-known locations. */
export function protectedResourceMetadataResponse(
  request: Request,
  config: McpAuthConfig,
): Response | undefined {
  if (config.mode !== "oauth") return undefined;

  const pathname = new URL(request.url).pathname;
  const configuredPath = new URL(config.resourceMetadataUrl).pathname;
  if (
    pathname !== "/.well-known/oauth-protected-resource" &&
    pathname !== "/.well-known/oauth-protected-resource/mcp" &&
    pathname !== configuredPath
  ) {
    return undefined;
  }

  const corsHeaders = {
    "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Origin": "*",
  };
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: { ...corsHeaders, Allow: "GET, OPTIONS" },
    });
  }

  const metadata: OAuthProtectedResourceMetadata = {
    resource: config.resource.href,
    authorization_servers: [config.issuer],
    scopes_supported: config.scopes,
    bearer_methods_supported: ["header"],
    resource_name: "Streamr",
  };
  return Response.json(metadata, {
    headers: {
      ...corsHeaders,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Convert MCP authentication failures into a discoverable OAuth challenge. */
export function oauthChallengeResponse(
  error: unknown,
  config: McpAuthConfig,
  requestId?: string,
): Response {
  const gatewayError = asGatewayError(error);
  const response = errorResponse(gatewayError, requestId);
  if (
    config.mode === "oauth" &&
    (gatewayError.code === "AUTH_REQUIRED" || gatewayError.code === "AUTH_INVALID")
  ) {
    const parameters = [
      `resource_metadata="${config.resourceMetadataUrl}"`,
      `scope="${config.readScopes.join(" ")}"`,
    ];
    if (gatewayError.code === "AUTH_INVALID") {
      parameters.push('error="invalid_token"');
      parameters.push('error_description="The bearer token is invalid or expired."');
    }
    response.headers.set("WWW-Authenticate", `Bearer ${parameters.join(", ")}`);
  }
  return response;
}
