import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/constants";
import {
  createSignedStreamUrl,
  verifySignedStreamUrl,
} from "../../src/util/signed-url";

const NOW = Date.UTC(2026, 7, 27, 0, 0, 0);
const SECRET = "test-signing-secret";

describe("signed stream URLs", () => {
  it("creates a canonical base64url HMAC URL with a ten-minute expiry", async () => {
    const pipeline = {
      source: { url: "https://source.test/archive.zip" },
      archive: { entries: [{ path: "data/01.in" }] },
      output: { mode: "raw" },
    };

    const signed = await createSignedStreamUrl(
      "https://gateway.test/base-path",
      pipeline,
      SECRET,
      NOW,
    );
    const url = new URL(signed.url);

    expect(url.pathname).toBe("/v1/stream");
    expect(url.searchParams.get("p")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("s")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("e")).toBe(
      String(Math.floor(NOW / 1_000) + LIMITS.signedUrlTtlSeconds),
    );
    expect(signed.expiresAt).toBe("2026-08-27T00:10:00.000Z");
    await expect(verifySignedStreamUrl(url.searchParams, SECRET, NOW)).resolves.toEqual(
      pipeline,
    );
  });

  it("rejects tampering, duplicate parameters, expiry, and future timestamps", async () => {
    const signed = await createSignedStreamUrl(
      "https://gateway.test",
      { source: { url: "https://source.test/file" }, output: { mode: "raw" } },
      SECRET,
      NOW,
    );

    const tampered = new URL(signed.url);
    tampered.searchParams.set("p", `${tampered.searchParams.get("p")}A`);
    await expect(verifySignedStreamUrl(tampered.searchParams, SECRET, NOW)).rejects.toMatchObject({
      code: "SIGNATURE_INVALID",
    });

    const duplicate = new URL(signed.url);
    duplicate.searchParams.append("e", duplicate.searchParams.get("e")!);
    await expect(verifySignedStreamUrl(duplicate.searchParams, SECRET, NOW)).rejects.toMatchObject({
      code: "SIGNATURE_INVALID",
    });

    await expect(
      verifySignedStreamUrl(new URL(signed.url).searchParams, SECRET, NOW + 600_000),
    ).rejects.toMatchObject({ code: "SIGNATURE_EXPIRED" });

    const createdInTheFuture = await createSignedStreamUrl(
      "https://gateway.test",
      { source: { url: "https://source.test/file" }, output: { mode: "raw" } },
      SECRET,
      NOW + 3_600_000,
    );
    await expect(
      verifySignedStreamUrl(new URL(createdInTheFuture.url).searchParams, SECRET, NOW),
    ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });

  it("rejects oversized payloads before signing or parsing", async () => {
    await expect(
      createSignedStreamUrl(
        "https://gateway.test",
        {
          source: { url: "https://source.test/file" },
          note: "x".repeat(LIMITS.signedPayloadBytes),
        },
        SECRET,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "SIGNED_URL_PAYLOAD_TOO_LARGE" });

    const parameters = new URLSearchParams({
      p: "A".repeat(Math.ceil((LIMITS.signedPayloadBytes * 4) / 3) + 1),
      e: String(Math.floor(NOW / 1_000) + 60),
      s: "A".repeat(43),
    });
    await expect(verifySignedStreamUrl(parameters, SECRET, NOW)).rejects.toMatchObject({
      code: "SIGNED_URL_PAYLOAD_TOO_LARGE",
    });
  });

  it("refuses sensitive headers at any nesting depth", async () => {
    await expect(
      createSignedStreamUrl(
        "https://gateway.test",
        {
          source: { url: "https://source.test/archive.zip" },
          routes: [
            {
              target: {
                url: "https://target.test/upload",
                headers: { "Proxy-Authorization": "secret" },
              },
            },
          ],
        },
        SECRET,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await expect(
      createSignedStreamUrl(
        "https://gateway.test",
        {
          source: { url: "https://source.test/archive.zip" },
          toJSON: () => ({
            source: {
              url: "https://source.test/archive.zip",
              headers: { Authorization: "Bearer secret" },
            },
          }),
        },
        SECRET,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const forbiddenPipeline = {
      source: {
        url: "https://source.test/archive.zip",
        headers: { Cookie: "session=secret" },
      },
    };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(forbiddenPipeline));
    let payloadBinary = "";
    for (const byte of payloadBytes) payloadBinary += String.fromCharCode(byte);
    const payload = btoa(payloadBinary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const expiry = String(Math.floor(NOW / 1_000) + LIMITS.signedUrlTtlSeconds);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signatureBytes = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${expiry}.${payload}`),
      ),
    );
    let signatureBinary = "";
    for (const byte of signatureBytes) signatureBinary += String.fromCharCode(byte);
    const signature = btoa(signatureBinary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");

    await expect(
      verifySignedStreamUrl(
        new URLSearchParams({ p: payload, e: expiry, s: signature }),
        SECRET,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
  });

  it("keeps signed GET pipelines public by rejecting every custom header", async () => {
    await expect(
      createSignedStreamUrl(
        "https://gateway.test",
        {
          source: {
            url: "https://source.test/archive.zip",
            headers: { "X-API-Key": "secret" },
          },
        },
        SECRET,
        NOW,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      details: { header: "X-API-Key" },
    });
  });

  it("rejects non-HTTP URLs and URL credentials", async () => {
    await expect(
      createSignedStreamUrl(
        "https://gateway.test",
        { source: { url: "data:text/plain,secret" } },
        SECRET,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEME" });

    await expect(
      createSignedStreamUrl(
        "https://gateway.test",
        { source: { url: "https://user:password@source.test/file" } },
        SECRET,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "INVALID_URL" });

    await expect(
      createSignedStreamUrl(
        "https://user:password@gateway.test",
        { source: { url: "https://source.test/file" } },
        SECRET,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "INVALID_URL" });
  });
});
