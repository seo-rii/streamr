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

  it("propagates MCP call cancellation to the injected operation", async () => {
    let markStarted: (() => void) | undefined;
    let markAborted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const operationAborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const operations = gatewayOperations({
      probeUrl: vi.fn(
        (_input, signal) =>
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
      ),
    });
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
          name: "probe_url",
          arguments: { source: { url: "https://source.test/archive.zip" } },
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
