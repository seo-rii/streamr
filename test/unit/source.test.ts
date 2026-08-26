import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSource } from "../../src/source/fetch";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("source fetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams the body and preserves known metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("payload", {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
            "Content-Length": "7",
          },
        }),
      ),
    );

    const source = await fetchSource({
      url: "https://source.test/data",
      redirect: { max: 5, forwardSensitiveHeadersAcrossHosts: false },
      acceptStatus: [200, 206],
      timeoutMs: 300_000,
    });

    expect(source.contentLength).toBe(7);
    expect(source.contentType).toBe("text/plain");
    await expect(readAll(source.byteStream.stream)).resolves.toBe("payload");
    expect(source.stats).toEqual({ bytesRead: 7, sourceGets: 1 });
  });

  it("removes credentials across origins while keeping ordinary headers", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        if (requests.length === 1) {
          return new Response("redirect", {
            status: 302,
            headers: { Location: "https://other.test/file" },
          });
        }
        return new Response("ok", { status: 200 });
      }),
    );

    const source = await fetchSource({
      url: "https://source.test/data",
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=secret",
        "X-Trace": "kept",
      },
      redirect: { max: 5, forwardSensitiveHeadersAcrossHosts: false },
      acceptStatus: [200],
      timeoutMs: 300_000,
    });
    await readAll(source.byteStream.stream);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get("Authorization")).toBeNull();
    expect(requests[1]?.headers.get("Cookie")).toBeNull();
    expect(requests[1]?.headers.get("X-Trace")).toBe("kept");
  });
});

