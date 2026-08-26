import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

function authenticatedJson(path: string, body: unknown): Request {
  return new Request(`https://streamr.test${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MCP_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("raw HTTP data plane", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a missing bearer token before source fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(
      new Request("https://streamr.test/v1/probe", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTH_REQUIRED" },
    });
  });

  it("proxies a raw source without buffering it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first-"));
              controller.enqueue(new TextEncoder().encode("second"));
              controller.close();
            },
          }),
          {
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": "12",
            },
          },
        ),
      ),
    );

    const response = await exports.default.fetch(
      authenticatedJson("/v1/stream", {
        source: { url: "https://source.test/file" },
        output: { mode: "raw", contentType: "text/plain; charset=utf-8" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Content-Length")).toBe("12");
    await expect(response.text()).resolves.toBe("first-second");
  });

  it("streams a known-length source to a target and captures a bounded response", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return new Response("abc", {
            headers: { "Content-Length": "3", "Content-Type": "text/plain" },
          });
        }
        const uploaded = await new Response(init?.body).text();
        expect(init?.method).toBe("PUT");
        expect(uploaded).toBe("abc");
        return Response.json({ stored: true }, { status: 201 });
      }),
    );

    const response = await exports.default.fetch(
      authenticatedJson("/v1/transfer", {
        source: { url: "https://source.test/file" },
        target: {
          url: "https://target.test/upload",
          method: "PUT",
          requireContentLength: true,
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      sourceGets: 1,
      bytesRead: 3,
      bytesWritten: 3,
      targetStatus: 201,
      targetResponse: {
        contentType: "application/json",
        body: "{\"stored\":true}",
        truncated: false,
      },
    });
    expect(calls).toEqual([
      "https://source.test/file",
      "https://target.test/upload",
    ]);
  });
});

