import { describe, expect, it } from "vitest";
import { requireBearer } from "../../src/auth";

describe("Bearer authentication", () => {
  it("accepts the exact configured token", async () => {
    const request = new Request("https://streamr.test/v1/probe", {
      headers: { Authorization: "Bearer expected-token" },
    });

    await expect(requireBearer(request, "expected-token")).resolves.toBeUndefined();
  });

  it("distinguishes missing and invalid credentials", async () => {
    await expect(
      requireBearer(new Request("https://streamr.test/v1/probe"), "expected-token"),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    await expect(
      requireBearer(
        new Request("https://streamr.test/v1/probe", {
          headers: { Authorization: "Bearer wrong-token" },
        }),
        "expected-token",
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID" });
  });
});
