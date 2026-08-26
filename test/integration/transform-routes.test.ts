import { env, exports } from "cloudflare:workers";
import { gzipSync, strToU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

function request(path: string, body: unknown): Request {
  return new Request(`https://streamr.test${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MCP_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("transform HTTP pipelines", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates transforms before fetching the source", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await exports.default.fetch(
      request("/v1/stream", {
        source: { url: "https://source.test/file" },
        entryTransforms: [
          {
            type: "multipart-form-data",
            fieldName: "file",
            filename: "a.txt",
            contentType: "text/plain",
          },
        ],
        output: { mode: "raw" },
      }),
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_TRANSFORM", stage: "transform-validate" },
    });
  });

  it("normalizes newlines across source chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(strToU8("one\r"));
              controller.enqueue(strToU8("\ntwo\rthree"));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/plain; charset=utf-8" } },
        ),
      ),
    );

    const response = await exports.default.fetch(
      request("/v1/stream", {
        source: { url: "https://source.test/file.txt" },
        entryTransforms: [
          { type: "newline", mode: "lf", ensureFinalNewline: true },
        ],
        output: { mode: "raw" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("one\ntwo\nthree\n");
  });

  it("decompresses an entry stream before a target upload", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return new Response(gzipSync(strToU8("payload\n")), {
            headers: { "Content-Type": "application/gzip" },
          });
        }
        await expect(new Response(init?.body).text()).resolves.toBe("payload\n");
        return new Response(null, { status: 204 });
      }),
    );

    const response = await exports.default.fetch(
      request("/v1/transfer", {
        source: { url: "https://source.test/payload.gz" },
        entryTransforms: [{ type: "decompress", format: "auto" }],
        target: { url: "https://target.test/upload", method: "PUT" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, targetStatus: 204 });
  });

  it("wraps a target body in multipart/form-data as the final entry transform", async () => {
    let uploadedContentType = "";
    let uploadedBody = "";
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) return new Response("abc");
        uploadedContentType = new Headers(init?.headers).get("Content-Type") ?? "";
        uploadedBody = await new Response(init?.body).text();
        return new Response(null, { status: 201 });
      }),
    );

    const response = await exports.default.fetch(
      request("/v1/transfer", {
        source: { url: "https://source.test/a.txt" },
        entryTransforms: [
          {
            type: "multipart-form-data",
            fieldName: "file",
            filename: "a.txt",
            contentType: "text/plain",
            fields: { problemId: "1234" },
          },
        ],
        target: { url: "https://target.test/upload", method: "POST" },
      }),
    );

    expect(response.status).toBe(200);
    expect(uploadedContentType).toMatch(/^multipart\/form-data; boundary=sgw_form_/);
    expect(uploadedBody).toContain('name="problemId"\r\n\r\n1234');
    expect(uploadedBody).toContain('filename="a.txt"');
    expect(uploadedBody).toContain("\r\n\r\nabc\r\n--sgw_form_");
  });
});
