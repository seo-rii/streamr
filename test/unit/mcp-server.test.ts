import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { GatewayError } from "../../src/errors";
import {
  createGatewayMcpHandler,
  createServer,
} from "../../src/mcp/server";
import { LIMITS } from "../../src/constants";
import type { GatewayOperations } from "../../src/mcp/tools";
import { describe, expect, it, vi } from "vitest";

function gatewayOperations(
  overrides: Partial<GatewayOperations> = {},
): GatewayOperations {
  return {
    probeUrl: vi.fn(async () => ({ ok: true, operation: "probe_url" })),
    listArchive: vi.fn(async () => ({ ok: true, operation: "list_archive" })),
    createStreamUrl: vi.fn(async () => ({ ok: true, operation: "create_stream_url" })),
    transfer: vi.fn(async () => ({ ok: true, operation: "transfer" })),
    distributeArchive: vi.fn(async () => ({ ok: true, operation: "distribute_archive" })),
    ...overrides,
  };
}

function jsonResult(result: CallToolResult): Record<string, unknown> {
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text") throw new Error("Expected an MCP text result.");
  return JSON.parse(text.text) as Record<string, unknown>;
}

describe("stateless MCP server", () => {
  it("registers exactly the five gateway tools with appropriate annotations", async () => {
    const operations = gatewayOperations();
    const server = createServer(operations);
    const [clientTransport, serverTransport] =
      (await import("@modelcontextprotocol/server")).InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(client.getServerVersion()).toEqual({
        name: "stateless-stream-gateway",
        version: "0.2.0",
      });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "probe_url",
        "list_archive",
        "create_stream_url",
        "transfer",
        "distribute_archive",
      ]);
      expect(tools.slice(0, 3)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            annotations: expect.objectContaining({
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
            }),
          }),
        ]),
      );
      expect(tools.slice(3)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            annotations: expect.objectContaining({
              readOnlyHint: false,
              destructiveHint: true,
              idempotentHint: false,
            }),
          }),
        ]),
      );
      expect(tools.find((tool) => tool.name === "transfer")).toMatchObject({
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    {
      type: "inline",
      encoding: "utf8",
      data: "안녕하세요\n",
      contentType: "text/plain; charset=utf-8",
      filename: "greeting.txt",
    },
    {
      type: "inline",
      encoding: "base64",
      data: "AAH+/w==",
      contentType: "application/octet-stream",
      filename: "data.bin",
    },
  ])("transfers inline $encoding sources with metadata and transforms", async (source) => {
    let receivedSignal: AbortSignal | undefined;
    const value = { ok: true, target: { status: 201 } };
    const operations = gatewayOperations({
      transfer: vi.fn(async (_input, signal) => {
        receivedSignal = signal;
        expect(signal.aborted).toBe(false);
        return value;
      }),
    });
    const server = createServer(operations);
    const [clientTransport, serverTransport] =
      (await import("@modelcontextprotocol/server")).InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "inline-transfer-client", version: "1.0.0" });
    const entryTransforms = [{ type: "append", encoding: "utf8", data: "\n" }];
    const target = { url: "https://target.test/content", method: "PUT" };

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "transfer",
        arguments: { source, entryTransforms, target },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(value);
      expect(jsonResult(result)).toEqual(value);
      expect(operations.transfer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          source,
          entryTransforms,
          target: expect.objectContaining(target),
        }),
        receivedSignal,
      );
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(["probe_url", "list_archive", "create_stream_url", "distribute_archive"] as const)(
    "accepts an inline archive source in %s",
    async (toolName) => {
      const operations = gatewayOperations();
      const server = createServer(operations);
      const [clientTransport, serverTransport] =
        (await import("@modelcontextprotocol/server")).InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "inline-source-client", version: "1.0.0" });
      const source = {
        type: "inline",
        encoding: "base64",
        data: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==",
        contentType: "application/zip",
        filename: "empty.zip",
      };
      const operationNames = {
        probe_url: "probeUrl",
        list_archive: "listArchive",
        create_stream_url: "createStreamUrl",
        distribute_archive: "distributeArchive",
      } as const;

      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({
          name: toolName,
          arguments: {
            source,
            ...(toolName === "distribute_archive"
              ? {
                  routes: [{
                    path: "optional.txt",
                    required: false,
                    target: { url: "https://target.test/content", method: "PUT" },
                  }],
                }
              : {}),
          },
        });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ ok: true, operation: toolName });
        expect(operations[operationNames[toolName]]).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ source }),
          expect.any(AbortSignal),
        );
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it("rejects invalid inline transfer arguments before invoking the operation", async () => {
    const operations = gatewayOperations();
    const server = createServer(operations);
    const [clientTransport, serverTransport] =
      (await import("@modelcontextprotocol/server")).InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "inline-validation-client", version: "1.0.0" });
    const source = { type: "inline", encoding: "utf8", data: "hello" };
    const target = { url: "https://target.test/content", method: "PUT" };
    const invalidArguments = [
      { target },
      { source: { encoding: "utf8", data: "hello" }, target },
      { source: { type: "inline", data: "hello" }, target },
      { source: { type: "inline", encoding: "hex", data: "00" }, target },
      { source: { type: "inline", encoding: "utf8", data: 42 }, target },
      { source, target: { ...target, method: "GET" } },
      { source: { ...source, url: "https://source.test/content" }, target },
      { source: { ...source, type: "http" }, target },
    ];

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      for (const arguments_ of invalidArguments) {
        const result = await client.callTool({ name: "transfer", arguments: arguments_ });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Invalid arguments for tool transfer"),
          }),
        ]);
      }
      expect(operations.transfer).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serves Streamable HTTP with a fresh server and passes the request signal", async () => {
    let factories = 0;
    const signals: AbortSignal[] = [];
    const abortedDuringOperation: boolean[] = [];
    const operations = gatewayOperations({
      probeUrl: vi.fn(async (_input, signal) => {
        signals.push(signal);
        abortedDuringOperation.push(signal.aborted);
        return { ok: true, status: 200 };
      }),
    });
    const handler = createGatewayMcpHandler((request) => {
      factories += 1;
      expect(request?.url).toBe("http://localhost/mcp");
      return operations;
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost/mcp"),
      {
        fetch: async (input, init) => {
          const request =
            input instanceof Request && init === undefined
              ? input
              : new Request(input, init);
          const headers = new Headers(request.headers);
          headers.set("Host", new URL(request.url).host);
          return handler.fetch(new Request(request, { headers }));
        },
      },
    );
    const client = new Client({ name: "http-test-client", version: "1.0.0" });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(5);

      const result = await client.callTool({
        name: "probe_url",
        arguments: { source: { url: "https://source.test/data.zip" } },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ ok: true, status: 200 });
      expect(jsonResult(result)).toEqual({ ok: true, status: 200 });
      expect(signals).toHaveLength(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(abortedDuringOperation).toEqual([false]);
      expect(signals[0]?.aborted).toBe(true);
      expect(factories).toBeGreaterThanOrEqual(3);
    } finally {
      await client.close();
    }
  });

  it("advertises OAuth schemes and returns a scope challenge before an operation", async () => {
    const operations = gatewayOperations();
    let grantedScopes = ["streamr.read"];
    const resourceMetadataUrl =
      "https://gateway.test/.well-known/oauth-protected-resource/mcp";
    const handler = createGatewayMcpHandler(operations, {
      mode: "oauth",
      readScopes: ["streamr.read"],
      writeScopes: ["streamr.write"],
      resourceMetadataUrl,
    });
    const wireMessages: Array<Record<string, unknown>> = [];
    const transport = new StreamableHTTPClientTransport(
      new URL("https://gateway.test/mcp"),
      {
        fetch: async (input, init) => {
          const request =
            input instanceof Request && init === undefined
              ? input
              : new Request(input, init);
          const response = await handler.fetch(request, {
            authInfo: {
              token: "test-token",
              clientId: "test-client",
              scopes: grantedScopes,
              expiresAt: Math.floor(Date.now() / 1000) + 60,
            },
          });
          const wireBody = await response.clone().text();
          for (const line of wireBody.split("\n")) {
            const encoded = line.startsWith("data: ") ? line.slice(6) : line;
            if (!encoded.startsWith("{")) continue;
            wireMessages.push(JSON.parse(encoded) as Record<string, unknown>);
          }
          return response;
        },
      },
    );
    const client = new Client({ name: "oauth-test-client", version: "1.0.0" });

    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.find((tool) => tool.name === "probe_url")).toMatchObject({
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["streamr.read"] }],
        },
      });
      expect(tools.find((tool) => tool.name === "transfer")).toMatchObject({
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["streamr.write"] }],
        },
      });
      const toolsWireResult = wireMessages.find((message) => {
        const result = message.result;
        return (
          typeof result === "object" &&
          result !== null &&
          Array.isArray((result as { tools?: unknown }).tools)
        );
      });
      expect(toolsWireResult).toMatchObject({
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: "probe_url",
              securitySchemes: [
                { type: "oauth2", scopes: ["streamr.read"] },
              ],
            }),
            expect.objectContaining({
              name: "transfer",
              securitySchemes: [
                { type: "oauth2", scopes: ["streamr.write"] },
              ],
            }),
          ]),
        },
      });

      const result = await client.callTool({
        name: "transfer",
        arguments: {
          source: { url: "https://source.test/data" },
          target: { url: "https://target.test/data", method: "PUT" },
        },
      });
      expect(result.isError).toBe(true);
      expect(result._meta).toEqual({
        "mcp/www_authenticate": [
          `Bearer error="insufficient_scope", ` +
            `error_description="The bearer token does not grant the required scope.", ` +
            `scope="streamr.read streamr.write", ` +
            `resource_metadata="${resourceMetadataUrl}"`,
        ],
      });
      expect(operations.transfer).not.toHaveBeenCalled();

      const inlineTransferArguments = {
        source: { type: "inline", encoding: "utf8", data: "hello" },
        target: { url: "https://target.test/content", method: "PUT" },
      };
      const deniedTransfer = await client.callTool({
        name: "transfer",
        arguments: inlineTransferArguments,
      });
      expect(deniedTransfer.isError).toBe(true);
      expect(deniedTransfer._meta).toEqual(result._meta);
      expect(operations.transfer).not.toHaveBeenCalled();

      grantedScopes = ["streamr.write"];
      const allowedTransfer = await client.callTool({
        name: "transfer",
        arguments: inlineTransferArguments,
      });
      expect(allowedTransfer.isError).not.toBe(true);
      expect(allowedTransfer.structuredContent).toEqual({ ok: true, operation: "transfer" });
      expect(operations.transfer).toHaveBeenCalledOnce();
    } finally {
      await client.close();
    }
  });

  it("rejects JSON-RPC batches before any gateway operation starts", async () => {
    const operations = gatewayOperations();
    const handler = createGatewayMcpHandler(operations);
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
        },
        body: JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "transfer",
              arguments: {
                source: { url: "https://source.test/one" },
                target: { url: "https://target.test/one", method: "PUT" },
              },
            },
          },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "transfer",
              arguments: {
                source: { url: "https://source.test/two" },
                target: { url: "https://target.test/two", method: "PUT" },
              },
            },
          },
        ]),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32600 },
      id: null,
    });
    expect(operations.transfer).not.toHaveBeenCalled();
  });

  it("bounds and validates the MCP control request body", async () => {
    const operations = gatewayOperations();
    const handler = createGatewayMcpHandler(operations);

    const malformed = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: -32700 },
    });

    const oversized = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: new Uint8Array(LIMITS.controlRequestBytes + 1),
      }),
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: -32600 },
    });
    expect(operations.probeUrl).not.toHaveBeenCalled();
  });

  it.each(["probe_url", "transfer"])("propagates %s call cancellation to the injected operation", async (toolName) => {
    let markStarted: (() => void) | undefined;
    let markAborted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const operationAborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const operation = vi.fn(
      (_input: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          markStarted?.();
          signal.addEventListener(
            "abort",
            () => {
              markAborted?.();
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const operations = gatewayOperations(
      toolName === "transfer" ? { transfer: operation } : { probeUrl: operation },
    );
    const server = createServer(operations);
    const [clientTransport, serverTransport] =
      (await import("@modelcontextprotocol/server")).InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cancel-test-client", version: "1.0.0" });
    const controller = new AbortController();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const pendingCall = client.callTool(
        {
          name: toolName,
          arguments: toolName === "transfer"
            ? {
                source: { type: "inline", encoding: "utf8", data: "hello" },
                target: { url: "https://target.test/content", method: "PUT" },
              }
            : { source: { url: "https://source.test/archive.zip" } },
        },
        { signal: controller.signal },
      );
      await started;
      controller.abort();

      await expect(pendingCall).rejects.toThrow("AbortError");
      await operationAborted;
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns structured GatewayError details without leaking unknown errors", async () => {
    const expected = new GatewayError("ENTRY_NOT_FOUND", "Archive entry was not found.", {
      stage: "archive-select",
      details: { path: "missing.txt", occurrence: 1 },
    });
    const operations = gatewayOperations({
      probeUrl: vi.fn(async () => {
        throw expected;
      }),
      listArchive: vi.fn(async () => {
        throw new Error("sensitive implementation detail");
      }),
    });
    const server = createServer(operations);
    const [clientTransport, serverTransport] =
      (await import("@modelcontextprotocol/server")).InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "error-test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const gatewayResult = await client.callTool({
        name: "probe_url",
        arguments: { source: { url: "https://source.test/archive.zip" } },
      });
      expect(gatewayResult.isError).toBe(true);
      expect(jsonResult(gatewayResult)).toMatchObject({
        ok: false,
        error: {
          code: "ENTRY_NOT_FOUND",
          message: "Archive entry was not found.",
          stage: "archive-select",
          details: { path: "missing.txt", occurrence: 1 },
        },
      });

      const internalResult = await client.callTool({
        name: "list_archive",
        arguments: { source: { url: "https://source.test/archive.zip" } },
      });
      expect(internalResult.isError).toBe(true);
      expect(JSON.stringify(internalResult)).not.toContain("sensitive implementation detail");
      expect(jsonResult(internalResult)).toMatchObject({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: "An internal error occurred." },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
