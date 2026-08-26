import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("health endpoint", () => {
  it("is public and reports the service version", async () => {
    const response = await exports.default.fetch(
      new Request("https://streamr.test/healthz"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "streamr",
      version: "0.2.0",
    });
    expect(env).toBeDefined();
  });
});
