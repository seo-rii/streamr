import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { GatewayError } from "../../src/errors";
import worker from "../../src/index";
import {
  authenticateMcpRequest,
  oauthChallengeResponse,
  protectedResourceMetadataResponse,
  resolveMcpAuthConfig,
  type McpOAuthAuthConfig,
} from "../../src/oauth";
import { handleEmbeddedOAuthServerRequest } from "../../src/oauth-server";

const RESOURCE = "https://streamr.test/mcp";
const CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const USERNAME = "streamr-owner";
const PASSWORD = "correct-horse-battery-staple";

function tokenEnv(token = "expected-token"): Env {
  return {
    MCP_API_TOKEN: token,
    URL_SIGNING_SECRET: "signing-secret",
  } as Env;
}

function oauthEnv(overrides: Partial<Record<string, string>> = {}): Env {
  return {
    MCP_API_TOKEN: "legacy-api-token",
    URL_SIGNING_SECRET: "signed-url-secret",
    MCP_AUTH_MODE: "oauth",
    MCP_OAUTH_RESOURCE: RESOURCE,
    MCP_OAUTH_SIGNING_SECRET: "oauth-signing-secret-with-at-least-32-bytes",
    MCP_OAUTH_LOGIN_USERNAME: USERNAME,
    MCP_OAUTH_LOGIN_PASSWORD: PASSWORD,
    MCP_OAUTH_ALLOWED_REDIRECT_URIS: CALLBACK,
    MCP_OAUTH_READ_SCOPES: "streamr.read",
    MCP_OAUTH_WRITE_SCOPES: "streamr.write",
    ...overrides,
  } as Env;
}

function oauthConfig(): McpOAuthAuthConfig {
  const config = resolveMcpAuthConfig(oauthEnv(), RESOURCE);
  if (config.mode !== "oauth") throw new Error("Expected OAuth mode.");
  return config;
}

async function oauthRequest(
  path: string,
  init: RequestInit = {},
  config = oauthConfig(),
): Promise<Response> {
  return handleEmbeddedOAuthServerRequest(
    new Request(new URL(path, RESOURCE), init),
    config,
  );
}

async function registerClient(
  redirectUri = CALLBACK,
  config = oauthConfig(),
): Promise<string> {
  const response = await oauthRequest(
    "/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    },
    config,
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function pkce(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function beginAuthorization(
  clientId: string,
  verifier: string,
  config = oauthConfig(),
): Promise<string> {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: "streamr.read streamr.write",
    state: "test-state",
    code_challenge: await pkce(verifier),
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  const response = await oauthRequest(`/authorize?${query}`, {}, config);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Security-Policy")).toContain(
    "form-action 'self'",
  );
  const html = await response.text();
  const token = html.match(/name="request" value="([^"]+)"/)?.[1];
  if (token === undefined) throw new Error("Missing authorization request token.");
  return token;
}

async function completeAuthorization(
  requestToken: string,
  password = PASSWORD,
  config = oauthConfig(),
): Promise<Response> {
  return oauthRequest(
    "/authorize",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request: requestToken,
        username: USERNAME,
        password,
      }),
    },
    config,
  );
}

async function exchangeCode(
  code: string,
  clientId: string,
  verifier: string,
  config = oauthConfig(),
): Promise<Response> {
  return oauthRequest(
    "/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: CALLBACK,
        client_id: clientId,
        resource: RESOURCE,
      }),
    },
    config,
  );
}

describe("configurable MCP authentication", () => {
  it("keeps static bearer-token mode as the default", async () => {
    const config = resolveMcpAuthConfig(tokenEnv(), RESOURCE);

    expect(config.mode).toBe("token");
    await expect(
      authenticateMcpRequest(
        new Request(RESOURCE, {
          method: "POST",
          headers: { Authorization: "Bearer expected-token" },
        }),
        config,
      ),
    ).resolves.toMatchObject({ token: "expected-token" });
    await expect(
      authenticateMcpRequest(
        new Request(RESOURCE, {
          method: "POST",
          headers: { Authorization: "Bearer wrong-token" },
        }),
        config,
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID", stage: "auth" });
  });

  it("publishes protected-resource and authorization-server metadata", async () => {
    const config = oauthConfig();
    const metadataUrl =
      "https://streamr.test/.well-known/oauth-protected-resource/mcp";
    const resourceMetadata = protectedResourceMetadataResponse(
      new Request(metadataUrl),
      config,
    );
    expect(resourceMetadata).toBeInstanceOf(Response);
    if (resourceMetadata === undefined) throw new Error("Expected resource metadata.");
    await expect(resourceMetadata.json()).resolves.toMatchObject({
      resource: RESOURCE,
      authorization_servers: ["https://streamr.test"],
      scopes_supported: ["streamr.read", "streamr.write"],
    });

    const authorizationMetadata = await oauthRequest(
      "/.well-known/oauth-authorization-server",
      {},
      config,
    );
    await expect(authorizationMetadata.json()).resolves.toMatchObject({
      issuer: "https://streamr.test",
      authorization_endpoint: "https://streamr.test/authorize",
      token_endpoint: "https://streamr.test/token",
      registration_endpoint: "https://streamr.test/register",
      authorization_response_iss_parameter_supported: true,
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });

    const challenge = oauthChallengeResponse(
      new GatewayError("AUTH_REQUIRED", "Bearer authentication is required.", {
        stage: "auth",
      }),
      config,
    );
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("WWW-Authenticate")).toBe(
      `Bearer resource_metadata="${metadataUrl}", scope="streamr.read"`,
    );
  });

  it("routes built-in OAuth discovery and challenges through the Worker", async () => {
    const env = oauthEnv();
    const ctx = {} as ExecutionContext;
    const metadata = await worker.fetch(
      new Request("https://streamr.test/.well-known/oauth-authorization-server"),
      env,
      ctx,
    );
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      issuer: "https://streamr.test",
      registration_endpoint: "https://streamr.test/register",
    });

    const mcp = await worker.fetch(
      new Request(RESOURCE, { method: "POST" }),
      env,
      ctx,
    );
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://streamr.test/.well-known/oauth-protected-resource/mcp"',
    );
    expect(mcp.headers.get("WWW-Authenticate")).toContain('scope="streamr.read"');
  });

  it("restricts dynamic registration to exact configured redirect URIs", async () => {
    const acceptedClient = await registerClient();
    expect(acceptedClient).toMatch(/^ey/);

    const rejected = await oauthRequest("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Attacker",
        redirect_uris: ["https://attacker.example/callback"],
      }),
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: "invalid_redirect_uri",
    });

    const sameOriginWrongPath = await oauthRequest("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Wrong callback",
        redirect_uris: ["https://chatgpt.com/connector/oauth/other"],
      }),
    });
    expect(sameOriginWrongPath.status).toBe(400);
    await expect(sameOriginWrongPath.json()).resolves.toMatchObject({
      error: "invalid_redirect_uri",
    });
  });

  it("completes the stateless DCR, login, PKCE, and access-token flow", async () => {
    const config = oauthConfig();
    const clientId = await registerClient(CALLBACK, config);
    const verifier = "a".repeat(43);
    const requestToken = await beginAuthorization(clientId, verifier, config);

    const wrongLogin = await completeAuthorization(requestToken, "wrong-password-long", config);
    expect(wrongLogin.status).toBe(200);
    expect(await wrongLogin.text()).toContain("username or password is invalid");

    const authorization = await completeAuthorization(requestToken, PASSWORD, config);
    expect(authorization.status).toBe(302);
    const callback = new URL(authorization.headers.get("Location") ?? "");
    expect(callback.origin + callback.pathname).toBe(CALLBACK);
    expect(callback.searchParams.get("state")).toBe("test-state");
    expect(callback.searchParams.get("iss")).toBe("https://streamr.test");
    const code = callback.searchParams.get("code");
    if (code === null) throw new Error("Missing authorization code.");

    const badPkce = await exchangeCode(code, clientId, "b".repeat(43), config);
    expect(badPkce.status).toBe(400);
    await expect(badPkce.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const tokenResponse = await exchangeCode(code, clientId, verifier, config);
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      expires_in: number;
      scope: string;
    };
    expect(tokens.expires_in).toBe(12 * 60 * 60);
    expect(tokens.scope).toBe("streamr.read streamr.write");
    expect(tokens.access_token.split(".")).toHaveLength(5);

    const authInfo = await authenticateMcpRequest(
      new Request(RESOURCE, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }),
      config,
    );
    expect(authInfo).toMatchObject({
      clientId,
      scopes: ["streamr.read", "streamr.write"],
      resource: new URL(RESOURCE),
      extra: { sub: `owner:${USERNAME}` },
    });

    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
      requestInit: {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
      fetch: async (input, init) => {
        const mcpRequest =
          input instanceof Request && init === undefined
            ? input
            : new Request(input, init);
        return worker.fetch(mcpRequest, oauthEnv(), {} as ExecutionContext);
      },
    });
    const client = new Client({ name: "oauth-e2e-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "probe_url",
        "list_archive",
        "create_stream_url",
        "transfer",
        "distribute_archive",
      ]);
      expect(tools.find((tool) => tool.name === "probe_url")).toMatchObject({
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["streamr.read"] }],
        },
      });
    } finally {
      await client.close();
    }

    await expect(
      authenticateMcpRequest(
        new Request(RESOURCE, {
          method: "POST",
          headers: { Authorization: `Bearer ${code}` },
        }),
        config,
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" });

    // With no storage, code redemption cannot be marked as consumed. PKCE and
    // the 60-second expiry bound the replay window, but the same client can
    // redeem the same code again while it remains valid.
    const replay = await exchangeCode(code, clientId, verifier, config);
    expect(replay.status).toBe(200);
  });

  it("fails closed for missing secrets, unsafe redirect URIs, and origin drift", () => {
    for (const overrides of [
      { MCP_OAUTH_SIGNING_SECRET: "" },
      { MCP_OAUTH_LOGIN_PASSWORD: "short" },
      { MCP_OAUTH_ALLOWED_REDIRECT_URIS: `${CALLBACK}#fragment` },
    ]) {
      expect(() => resolveMcpAuthConfig(oauthEnv(overrides), RESOURCE)).toThrowError(
        expect.objectContaining({ stage: "auth-config" }),
      );
    }

    expect(() =>
      resolveMcpAuthConfig(oauthEnv(), "https://other-origin.test/mcp"),
    ).toThrowError(expect.objectContaining({ stage: "auth-config" }));
    expect(() =>
      resolveMcpAuthConfig(
        { ...tokenEnv(), MCP_AUTH_MODE: "none" } as Env,
        RESOURCE,
      ),
    ).toThrowError(expect.objectContaining({ stage: "auth-config" }));
  });
});
