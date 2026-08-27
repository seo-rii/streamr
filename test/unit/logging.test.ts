import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError } from "../../src/errors";
import type { ByteStream } from "../../src/streams/byte-stream";
import {
  createRequestLogContext,
  observeByteStream,
  observeResponseCompletion,
} from "../../src/util/logging";

function parseRecord(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const value: unknown = spy.mock.calls[0]?.[0];
  if (typeof value !== "string") throw new Error("missing structured log record");
  return JSON.parse(value) as Record<string, unknown>;
}

describe("request completion logging", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits for raw stream EOF and logs actual bytes without URL query data", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const log = createRequestLogContext("stream");
    const stats = { sourceGets: 1, bytesRead: 0 };
    log.observeSource({
      finalUrl: "https://source.test/archive.bin?token=must-not-be-logged",
      stats,
    });
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    const input: ByteStream = {
      stream: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk === undefined) controller.close();
          else {
            stats.bytesRead += chunk.byteLength;
            controller.enqueue(chunk);
          }
        },
      }),
      abort: vi.fn(),
    };

    const observed = observeByteStream(input, log);
    expect(output).not.toHaveBeenCalled();
    await expect(new Response(observed.stream).bytes()).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );

    expect(output).toHaveBeenCalledOnce();
    const record = parseRecord(output);
    expect(record).toMatchObject({
      operation: "stream",
      sourceScheme: "https",
      sourceHost: "source.test",
      sourcePath: "/archive.bin",
      sourceGets: 1,
      bytesRead: 3,
      bytesWritten: 3,
      result: "ok",
    });
    expect(JSON.stringify(record)).not.toContain("must-not-be-logged");
  });

  it("logs client cancellation once and propagates it upstream", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const abort = vi.fn();
    const log = createRequestLogContext("stream");
    const input: ByteStream = {
      stream: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
      }),
      abort,
    };
    const reader = observeByteStream(input, log).stream.getReader();

    await reader.read();
    await reader.cancel("client disconnected");

    expect(abort).toHaveBeenCalledWith("client disconnected");
    expect(parseRecord(output)).toMatchObject({ result: "aborted", bytesWritten: 1 });
    expect(output).toHaveBeenCalledOnce();
  });

  it("logs a streaming failure once with its structured error code", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new GatewayError("SOURCE_FETCH_FAILED", "source disconnected", {
      stage: "source-read",
    });
    const log = createRequestLogContext("stream");
    const input: ByteStream = {
      stream: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(failure);
        },
      }),
      abort: vi.fn(),
    };

    await expect(new Response(observeByteStream(input, log).stream).text()).rejects.toBe(
      failure,
    );
    expect(parseRecord(output)).toMatchObject({
      result: "error",
      errorCode: "SOURCE_FETCH_FAILED",
    });
    expect(output).toHaveBeenCalledOnce();
  });

  it("preserves operation bytes and partial status while observing an MCP response", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const log = createRequestLogContext("distribute_archive");
    log.patch({
      routesRequested: 3,
      routesCompleted: 2,
      routesFailed: 1,
      routesMissing: 0,
      bytesWritten: 1234,
    });
    log.markResult("partial");

    const response = observeResponseCompletion(Response.json({ ok: false }), log);
    await response.text();

    expect(parseRecord(output)).toMatchObject({
      operation: "distribute_archive",
      routesRequested: 3,
      routesCompleted: 2,
      routesFailed: 1,
      bytesWritten: 1234,
      result: "partial",
    });
    expect(output).toHaveBeenCalledOnce();
  });

  it("records an MCP protocol rejection as an error", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = createRequestLogContext("mcp");
    const response = observeResponseCompletion(
      Response.json({ jsonrpc: "2.0", error: { code: -32600 }, id: null }, { status: 400 }),
      log,
    );

    await response.text();

    expect(parseRecord(output)).toMatchObject({ operation: "mcp", result: "error" });
    expect(output).toHaveBeenCalledOnce();
  });
});
