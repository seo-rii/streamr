import { GatewayError } from "./errors";
import { timingSafeEqual } from "node:crypto";

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

export async function requireBearer(request: Request, expected: string): Promise<void> {
  const authorization = request.headers.get("Authorization");
  if (authorization === null) {
    throw new GatewayError("AUTH_REQUIRED", "Bearer authentication is required.", {
      stage: "auth",
    });
  }

  const match = /^Bearer[ \t]+(.+)$/.exec(authorization);
  if (match?.[1] === undefined) {
    throw new GatewayError("AUTH_INVALID", "Bearer authentication is invalid.", {
      stage: "auth",
    });
  }

  const [providedHash, expectedHash] = await Promise.all([
    digest(match[1]),
    digest(expected),
  ]);
  if (!timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash))) {
    throw new GatewayError("AUTH_INVALID", "Bearer authentication is invalid.", {
      stage: "auth",
    });
  }
}
