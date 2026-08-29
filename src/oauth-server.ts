import { EncryptJWT, SignJWT, jwtDecrypt, jwtVerify } from "jose";
import { secureStringEqual } from "./auth";
import type { McpOAuthAuthConfig } from "./oauth";

const OAUTH_BODY_LIMIT = 64 * 1024;
const AUTHORIZATION_REQUEST_TTL_SECONDS = 10 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 60;
const CLIENT_REGISTRATION_TTL_SECONDS = 5 * 365 * 24 * 60 * 60;
const JWE_ALGORITHM = "dir";
const JWE_ENCRYPTION = "A256GCM";
const KEY_SALT = "streamr:oauth:v1";
const encoder = new TextEncoder();

const artifactTypes = {
  authorizationCode: "streamr-oauth-code+jwt",
  accessToken: "streamr-access-token+jwt",
} as const;

type EncryptedArtifactType = keyof typeof artifactTypes;

interface RegisteredClientClaims {
  type: "registered_client";
  clientName: string;
  redirectUris: string[];
  applicationType: "web" | "native";
  iat: number;
  exp: number;
}

interface AuthorizationRequestClaims {
  type: "authorization_request";
  clientId: string;
  clientName: string;
  redirectUri: string;
  scope: string;
  state?: string;
  codeChallenge: string;
  resource: string;
  iat: number;
  exp: number;
}

interface AuthorizationCodeClaims {
  type: "authorization_code";
  sub: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  resource: string;
  iat: number;
  exp: number;
}

export interface EmbeddedAccessTokenClaims {
  type: "access_token";
  sub: string;
  clientId: string;
  scope: string;
  resource: string;
  iat: number;
  exp: number;
}

class OAuthProtocolError extends Error {
  constructor(
    readonly oauthCode: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function oauthHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function oauthJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: oauthHeaders({ "Access-Control-Allow-Origin": "*" }),
  });
}

function protocolErrorResponse(error: unknown): Response {
  if (error instanceof OAuthProtocolError) {
    return oauthJson(
      { error: error.oauthCode, error_description: error.message },
      error.status,
    );
  }
  return oauthJson(
    { error: "server_error", error_description: "The OAuth request failed." },
    500,
  );
}

async function readBodyText(request: Request): Promise<string> {
  if (request.body === null) {
    throw new OAuthProtocolError("invalid_request", "A request body is required.");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > OAUTH_BODY_LIMIT) {
      await reader.cancel("OAuth request body limit exceeded");
      throw new OAuthProtocolError(
        "invalid_request",
        "The OAuth request body is too large.",
        413,
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OAuthProtocolError(
      "invalid_request",
      "The OAuth request body is not valid UTF-8.",
    );
  }
}

async function readOAuthParameters(
  request: Request,
  expected: "json" | "form-or-json",
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
  const text = await readBodyText(request);
  if (contentType === "application/json") {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new OAuthProtocolError("invalid_request", "The JSON body is invalid.");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new OAuthProtocolError("invalid_request", "A JSON object is required.");
    }
    return value as Record<string, unknown>;
  }

  if (
    expected === "form-or-json" &&
    contentType === "application/x-www-form-urlencoded"
  ) {
    const result: Record<string, string> = {};
    for (const [name, value] of new URLSearchParams(text)) {
      if (Object.hasOwn(result, name)) {
        throw new OAuthProtocolError(
          "invalid_request",
          `The ${name} parameter must not be repeated.`,
        );
      }
      result[name] = value;
    }
    return result;
  }

  throw new OAuthProtocolError(
    "invalid_request",
    expected === "json"
      ? "Content-Type must be application/json."
      : "Content-Type must be application/json or application/x-www-form-urlencoded.",
    415,
  );
}

async function deriveEncryptionKey(
  secret: string,
  type: EncryptedArtifactType,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(KEY_SALT),
      info: encoder.encode(type),
    },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

async function encryptArtifact(
  config: McpOAuthAuthConfig,
  type: EncryptedArtifactType,
  payload: Record<string, unknown>,
  expiresAt: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new EncryptJWT(payload)
    .setProtectedHeader({
      alg: JWE_ALGORITHM,
      enc: JWE_ENCRYPTION,
      typ: artifactTypes[type],
    })
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .setIssuer(config.issuer)
    .setAudience(config.resource.href)
    .encrypt(await deriveEncryptionKey(config.signingSecret, type));
}

async function decryptArtifact(
  config: McpOAuthAuthConfig,
  type: EncryptedArtifactType,
  token: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { payload, protectedHeader } = await jwtDecrypt(
      token,
      await deriveEncryptionKey(config.signingSecret, type),
      {
        issuer: config.issuer,
        audience: config.resource.href,
        typ: artifactTypes[type],
        clockTolerance: 5,
        keyManagementAlgorithms: [JWE_ALGORITHM],
        contentEncryptionAlgorithms: [JWE_ENCRYPTION],
        requiredClaims: ["iat", "exp", "iss", "aud"],
        maxDecompressedLength: 0,
      },
    );
    if (protectedHeader.typ !== artifactTypes[type]) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function issueRegisteredClient(
  config: McpOAuthAuthConfig,
  claims: Omit<RegisteredClientClaims, "type" | "iat" | "exp">,
): Promise<{ clientId: string; issuedAt: number; expiresAt: number }> {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const expiresAt = issuedAt + CLIENT_REGISTRATION_TTL_SECONDS;
  const clientId = await new SignJWT({ type: "registered_client", ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "streamr-oauth-client+jwt" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setIssuer(config.issuer)
    .setAudience(config.issuer)
    .sign(encoder.encode(config.signingSecret));
  return { clientId, issuedAt, expiresAt };
}

async function readRegisteredClient(
  config: McpOAuthAuthConfig,
  clientId: string,
): Promise<RegisteredClientClaims | null> {
  try {
    const { payload } = await jwtVerify(
      clientId,
      encoder.encode(config.signingSecret),
      {
        algorithms: ["HS256"],
        issuer: config.issuer,
        audience: config.issuer,
        typ: "streamr-oauth-client+jwt",
        clockTolerance: 5,
        requiredClaims: ["iat", "exp", "iss", "aud"],
      },
    );
    const value = payload as unknown as RegisteredClientClaims;
    if (
      value.type !== "registered_client" ||
      typeof value.clientName !== "string" ||
      !Array.isArray(value.redirectUris) ||
      value.redirectUris.some((uri) => typeof uri !== "string") ||
      (value.applicationType !== "web" && value.applicationType !== "native")
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function issueAuthorizationRequest(
  config: McpOAuthAuthConfig,
  claims: Omit<AuthorizationRequestClaims, "type" | "iat" | "exp">,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ type: "authorization_request", ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "streamr-oauth-request+jwt" })
    .setIssuedAt(now)
    .setExpirationTime(now + AUTHORIZATION_REQUEST_TTL_SECONDS)
    .setIssuer(config.issuer)
    .setAudience(config.issuer)
    .sign(encoder.encode(config.signingSecret));
}

async function readAuthorizationRequest(
  config: McpOAuthAuthConfig,
  token: string,
): Promise<AuthorizationRequestClaims | null> {
  try {
    const { payload } = await jwtVerify(
      token,
      encoder.encode(config.signingSecret),
      {
        algorithms: ["HS256"],
        issuer: config.issuer,
        audience: config.issuer,
        typ: "streamr-oauth-request+jwt",
        clockTolerance: 5,
        requiredClaims: ["iat", "exp", "iss", "aud"],
      },
    );
    const value = payload as unknown as AuthorizationRequestClaims;
    return value.type === "authorization_request" ? value : null;
  } catch {
    return null;
  }
}

function normalizeScopes(
  rawScope: string | undefined,
  supportedScopes: readonly string[],
  fallbackScopes: readonly string[],
): string[] | null {
  const scopes = rawScope === undefined || rawScope.trim() === ""
    ? [...fallbackScopes]
    : [...new Set(rawScope.trim().split(/\s+/))];
  if (
    scopes.length === 0 ||
    scopes.some(
      (scope) =>
        !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope) ||
        !supportedScopes.includes(scope),
    )
  ) {
    return null;
  }
  return scopes;
}

function validRedirectUri(uri: string, config: McpOAuthAuthConfig): boolean {
  if (uri.length > 2_048) return false;
  try {
    const url = new URL(uri);
    return (
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      config.allowedRedirectUris.has(uri)
    );
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function loginPage(input: {
  requestToken: string;
  clientName: string;
  scopes: readonly string[];
  error?: string;
}): Response {
  const scopeItems = input.scopes
    .map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
    .join("");
  const error = input.error === undefined
    ? ""
    : `<p class="error" role="alert">${escapeHtml(input.error)}</p>`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize Streamr</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111827; color: #f9fafb; }
    main { width: min(28rem, calc(100% - 2rem)); padding: 2rem; border: 1px solid #374151; border-radius: 1rem; background: #1f2937; box-sizing: border-box; }
    h1 { margin-top: 0; }
    label { display: grid; gap: .4rem; margin: 1rem 0; }
    input { font: inherit; padding: .75rem; border: 1px solid #6b7280; border-radius: .5rem; background: #111827; color: inherit; }
    button { width: 100%; margin-top: 1rem; padding: .8rem; border: 0; border-radius: .5rem; font: inherit; font-weight: 700; cursor: pointer; background: #60a5fa; color: #0b1120; }
    .error { padding: .75rem; border-radius: .5rem; background: #7f1d1d; }
    .muted { color: #d1d5db; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize Streamr</h1>
    <p><strong>${escapeHtml(input.clientName)}</strong> is requesting access to this private Streamr deployment.</p>
    <p class="muted">Requested scopes:</p>
    <ul>${scopeItems}</ul>
    ${error}
    <form method="post" action="/authorize" autocomplete="on">
      <input type="hidden" name="request" value="${escapeHtml(input.requestToken)}">
      <label>Username<input name="username" type="text" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Authorize Streamr</button>
    </form>
  </main>
</body>
</html>`;
  return new Response(html, {
    headers: oauthHeaders({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    }),
  });
}

function redirectError(
  redirectUri: string,
  issuer: string,
  code: string,
  description: string,
  state?: string,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", description);
  url.searchParams.set("iss", issuer);
  if (state !== undefined) url.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: oauthHeaders({ Location: url.href }),
  });
}

function authorizationServerMetadata(config: McpOAuthAuthConfig): Response {
  return oauthJson({
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`,
    registration_endpoint: `${config.issuer}/register`,
    authorization_response_iss_parameter_supported: true,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: config.scopes,
    token_endpoint_auth_methods_supported: ["none"],
  });
}

async function registerClient(
  request: Request,
  config: McpOAuthAuthConfig,
): Promise<Response> {
  const body = await readOAuthParameters(request, "json");
  const applicationType = body.application_type === "native" ? "native" : "web";
  const rawRedirectUris = body.redirect_uris;
  if (!Array.isArray(rawRedirectUris) || rawRedirectUris.length === 0 || rawRedirectUris.length > 20) {
    throw new OAuthProtocolError(
      "invalid_redirect_uri",
      "Between one and twenty redirect_uris are required.",
    );
  }
  const redirectUris = [...new Set(rawRedirectUris)];
  if (
    redirectUris.some(
      (uri): boolean => typeof uri !== "string" || !validRedirectUri(uri, config),
    )
  ) {
    throw new OAuthProtocolError(
      "invalid_redirect_uri",
      "Every redirect URI must use an allowed origin.",
    );
  }
  if (
    body.token_endpoint_auth_method !== undefined &&
    body.token_endpoint_auth_method !== "none"
  ) {
    throw new OAuthProtocolError(
      "invalid_client_metadata",
      "Only token_endpoint_auth_method=none is supported.",
    );
  }
  const clientName = typeof body.client_name === "string"
    ? body.client_name.trim().slice(0, 200) || "MCP Client"
    : "MCP Client";
  const registration = await issueRegisteredClient(config, {
    clientName,
    redirectUris: redirectUris as string[],
    applicationType,
  });
  return oauthJson(
    {
      client_id: registration.clientId,
      client_id_issued_at: registration.issuedAt,
      client_id_expires_at: registration.expiresAt,
      client_name: clientName,
      redirect_uris: redirectUris,
      application_type: applicationType,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

async function beginAuthorization(
  request: Request,
  config: McpOAuthAuthConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const client = await readRegisteredClient(config, clientId);
  if (client === null || !client.redirectUris.includes(redirectUri)) {
    throw new OAuthProtocolError(
      "invalid_request",
      "The client or redirect URI is invalid.",
    );
  }

  const state = url.searchParams.get("state") ?? undefined;
  if (state !== undefined && state.length > 4_096) {
    return redirectError(
      redirectUri,
      config.issuer,
      "invalid_request",
      "The state parameter is too large.",
    );
  }
  if (url.searchParams.get("response_type") !== "code") {
    return redirectError(
      redirectUri,
      config.issuer,
      "unsupported_response_type",
      "Only response_type=code is supported.",
      state,
    );
  }
  if (url.searchParams.get("resource") !== config.resource.href) {
    return redirectError(
      redirectUri,
      config.issuer,
      "invalid_target",
      "The resource parameter must identify this MCP endpoint.",
      state,
    );
  }
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  if (
    url.searchParams.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)
  ) {
    return redirectError(
      redirectUri,
      config.issuer,
      "invalid_request",
      "A valid S256 PKCE code challenge is required.",
      state,
    );
  }
  const scopes = normalizeScopes(
    url.searchParams.get("scope") ?? undefined,
    config.scopes,
    config.scopes,
  );
  if (scopes === null) {
    return redirectError(
      redirectUri,
      config.issuer,
      "invalid_scope",
      "The requested scope is not supported.",
      state,
    );
  }

  const requestToken = await issueAuthorizationRequest(config, {
    clientId,
    clientName: client.clientName,
    redirectUri,
    scope: scopes.join(" "),
    ...(state === undefined ? {} : { state }),
    codeChallenge,
    resource: config.resource.href,
  });
  return loginPage({ requestToken, clientName: client.clientName, scopes });
}

async function completeAuthorization(
  request: Request,
  config: McpOAuthAuthConfig,
): Promise<Response> {
  const body = await readOAuthParameters(request, "form-or-json");
  const requestToken = typeof body.request === "string" ? body.request : "";
  const authorization = await readAuthorizationRequest(config, requestToken);
  if (authorization === null) {
    throw new OAuthProtocolError(
      "invalid_request",
      "The authorization request is invalid or expired.",
    );
  }
  const client = await readRegisteredClient(config, authorization.clientId);
  if (
    client === null ||
    !client.redirectUris.includes(authorization.redirectUri) ||
    authorization.resource !== config.resource.href
  ) {
    throw new OAuthProtocolError("invalid_request", "The registered client is invalid.");
  }

  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const [usernameMatches, passwordMatches] = await Promise.all([
    secureStringEqual(username, config.loginUsername),
    secureStringEqual(password, config.loginPassword),
  ]);
  if (!usernameMatches || !passwordMatches) {
    return loginPage({
      requestToken,
      clientName: authorization.clientName,
      scopes: authorization.scope.split(" "),
      error: "The username or password is invalid.",
    });
  }

  const now = Math.floor(Date.now() / 1_000);
  const code = await encryptArtifact(
    config,
    "authorizationCode",
    {
      type: "authorization_code",
      sub: config.subject,
      clientId: authorization.clientId,
      redirectUri: authorization.redirectUri,
      scope: authorization.scope,
      codeChallenge: authorization.codeChallenge,
      resource: authorization.resource,
    },
    now + AUTHORIZATION_CODE_TTL_SECONDS,
  );
  const redirect = new URL(authorization.redirectUri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("iss", config.issuer);
  if (authorization.state !== undefined) {
    redirect.searchParams.set("state", authorization.state);
  }
  return new Response(null, {
    status: 302,
    headers: oauthHeaders({ Location: redirect.href }),
  });
}

async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const encoded = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return secureStringEqual(encoded, challenge);
}

async function issueAccessToken(
  config: McpOAuthAuthConfig,
  input: { clientId: string; scope: string; subject: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return encryptArtifact(
    config,
    "accessToken",
    {
      type: "access_token",
      sub: input.subject,
      clientId: input.clientId,
      scope: input.scope,
      resource: config.resource.href,
    },
    now + config.accessTokenTtlSeconds,
  );
}

async function exchangeAuthorizationCode(
  body: Record<string, unknown>,
  config: McpOAuthAuthConfig,
): Promise<Response> {
  const code = typeof body.code === "string" ? body.code : "";
  const payload = await decryptArtifact(config, "authorizationCode", code);
  if (payload?.type !== "authorization_code") {
    throw new OAuthProtocolError(
      "invalid_grant",
      "The authorization code is invalid or expired.",
    );
  }
  const authorization = payload as unknown as AuthorizationCodeClaims;
  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
  const resource = typeof body.resource === "string" ? body.resource : "";
  const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
  if (
    clientId !== authorization.clientId ||
    redirectUri !== authorization.redirectUri ||
    resource !== config.resource.href ||
    authorization.resource !== config.resource.href ||
    !(await verifyPkce(verifier, authorization.codeChallenge))
  ) {
    throw new OAuthProtocolError(
      "invalid_grant",
      "The authorization-code binding is invalid.",
    );
  }
  if ((await readRegisteredClient(config, clientId)) === null) {
    throw new OAuthProtocolError("invalid_client", "The OAuth client is invalid.", 401);
  }

  const input = {
    clientId,
    scope: authorization.scope,
    subject: authorization.sub,
  };
  const accessToken = await issueAccessToken(config, input);
  return oauthJson({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.accessTokenTtlSeconds,
    scope: authorization.scope,
  });
}

async function exchangeToken(
  request: Request,
  config: McpOAuthAuthConfig,
): Promise<Response> {
  if (request.headers.has("Authorization")) {
    throw new OAuthProtocolError(
      "invalid_client",
      "This public-client token endpoint does not accept client authentication.",
      401,
    );
  }
  const body = await readOAuthParameters(request, "form-or-json");
  if (body.grant_type === "authorization_code") {
    return exchangeAuthorizationCode(body, config);
  }
  throw new OAuthProtocolError(
    "unsupported_grant_type",
    "Only the authorization_code grant is supported.",
  );
}

export async function readEmbeddedAccessToken(
  token: string,
  config: McpOAuthAuthConfig,
): Promise<EmbeddedAccessTokenClaims | null> {
  const payload = await decryptArtifact(config, "accessToken", token);
  if (payload?.type !== "access_token") return null;
  const claims = payload as unknown as EmbeddedAccessTokenClaims;
  if (
    typeof claims.sub !== "string" ||
    typeof claims.clientId !== "string" ||
    typeof claims.scope !== "string" ||
    claims.resource !== config.resource.href ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  return claims;
}

export function isEmbeddedOAuthServerPath(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/register" ||
    pathname === "/authorize" ||
    pathname === "/token"
  );
}

export async function handleEmbeddedOAuthServerRequest(
  request: Request,
  config: McpOAuthAuthConfig,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: oauthHeaders({
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": "*",
      }),
    });
  }

  try {
    if (pathname === "/.well-known/oauth-authorization-server") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET, OPTIONS" } });
      return authorizationServerMetadata(config);
    }
    if (pathname === "/register") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } });
      return await registerClient(request, config);
    }
    if (pathname === "/authorize") {
      if (request.method === "GET") return await beginAuthorization(request, config);
      if (request.method === "POST") return await completeAuthorization(request, config);
      return new Response(null, { status: 405, headers: { Allow: "GET, POST, OPTIONS" } });
    }
    if (pathname === "/token") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } });
      return await exchangeToken(request, config);
    }
    return new Response(null, { status: 404 });
  } catch (error) {
    return protocolErrorResponse(error);
  }
}
