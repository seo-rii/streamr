import { LIMITS } from "../constants";
import { GatewayError } from "../errors";

const textEncoder = new TextEncoder();
const MAX_ENCODED_PAYLOAD_LENGTH = Math.ceil((LIMITS.signedPayloadBytes * 4) / 3);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface SignedStreamUrl {
  url: string;
  expiresAt: string;
}

type SignedUrlStage = "signed-url-create" | "signed-url-verify";

function signingError(
  code: "SIGNATURE_INVALID" | "SIGNED_URL_PAYLOAD_TOO_LARGE",
  message: string,
  stage: SignedUrlStage,
): GatewayError {
  return new GatewayError(code, message, { stage });
}

function nowMilliseconds(now: number | Date | undefined, stage: SignedUrlStage): number {
  const value = now instanceof Date ? now.getTime() : (now ?? Date.now());
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw signingError("SIGNATURE_INVALID", "The signing timestamp is invalid.", stage);
  }
  return value;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCanonicalBase64Url(
  value: string,
  stage: SignedUrlStage,
): Uint8Array<ArrayBuffer> {
  if (
    value.length === 0 ||
    value.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw signingError("SIGNATURE_INVALID", "The signed URL encoding is invalid.", stage);
  }

  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      value.length + ((4 - (value.length % 4)) % 4),
      "=",
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64Url(bytes) !== value) {
      throw signingError("SIGNATURE_INVALID", "The signed URL encoding is not canonical.", stage);
    }
    return bytes;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("SIGNATURE_INVALID", "The signed URL encoding is invalid.", {
      stage,
      cause: error,
    });
  }
}

function validateHttpUrl(value: unknown, stage: SignedUrlStage): void {
  if (typeof value !== "string") {
    throw new GatewayError("INVALID_URL", "A signed pipeline URL must be a string.", {
      stage,
    });
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new GatewayError("INVALID_URL", "A signed pipeline URL is invalid.", {
      stage,
      cause: error,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GatewayError("UNSUPPORTED_SCHEME", "Only HTTP and HTTPS URLs are supported.", {
      stage,
      details: { scheme: url.protocol.replace(/:$/, "") },
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new GatewayError("INVALID_URL", "Credentials are not allowed in signed pipeline URLs.", {
      stage,
    });
  }
  if (/^\[.*\]$/.test(url.hostname) || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname)) {
    throw new GatewayError("INVALID_URL", "Cloudflare subrequests require a DNS hostname.", {
      stage,
    });
  }
}

function validateSignedPipeline(value: unknown, stage: SignedUrlStage): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError("INVALID_REQUEST", "A signed pipeline must be a JSON object.", {
      stage,
    });
  }

  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    if (visited.has(current)) {
      throw new GatewayError("INVALID_REQUEST", "A signed pipeline must not be cyclic.", {
        stage,
      });
    }
    visited.add(current);

    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }

    for (const [name, child] of Object.entries(current)) {
      const lowerName = name.toLowerCase();
      if (lowerName === "url") validateHttpUrl(child, stage);
      if (lowerName === "headers" && child !== null && typeof child === "object") {
        const headerName = Object.keys(child)[0];
        if (headerName !== undefined) {
          throw new GatewayError(
            stage === "signed-url-create" ? "INVALID_REQUEST" : "SIGNATURE_INVALID",
            "Custom headers are not allowed in a public signed URL payload; use POST /v1/stream.",
            { stage, details: { header: headerName } },
          );
        }
      }
      pending.push(child);
    }
  }
}

async function importSigningKey(secret: string, stage: SignedUrlStage): Promise<CryptoKey> {
  if (secret.length === 0) {
    throw signingError("SIGNATURE_INVALID", "The URL signing secret is not configured.", stage);
  }
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSignedStreamUrl(
  origin: string | URL,
  pipeline: unknown,
  secret: string,
  now?: number | Date,
): Promise<SignedStreamUrl> {
  const stage = "signed-url-create";
  validateSignedPipeline(pipeline, stage);

  let payloadJson: string;
  let serializedPipeline: unknown;
  try {
    payloadJson = JSON.stringify(pipeline);
    serializedPipeline = JSON.parse(payloadJson);
  } catch (error) {
    throw new GatewayError("INVALID_REQUEST", "The signed pipeline is not JSON serializable.", {
      stage,
      cause: error,
    });
  }
  // Validate the representation that will actually be exposed, including any toJSON output.
  validateSignedPipeline(serializedPipeline, stage);
  const payloadBytes = textEncoder.encode(payloadJson);
  if (payloadBytes.byteLength > LIMITS.signedPayloadBytes) {
    throw signingError(
      "SIGNED_URL_PAYLOAD_TOO_LARGE",
      "The signed URL payload exceeds 8 KiB.",
      stage,
    );
  }

  const nowMs = nowMilliseconds(now, stage);
  const expiry = Math.floor(nowMs / 1_000) + LIMITS.signedUrlTtlSeconds;
  const payload = encodeBase64Url(payloadBytes);
  const message = `${expiry}.${payload}`;
  const key = await importSigningKey(secret, stage);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(message)),
  );

  let url: URL;
  try {
    url = new URL("/v1/stream", origin);
  } catch (error) {
    throw new GatewayError("INVALID_URL", "The gateway origin is invalid.", {
      stage,
      cause: error,
    });
  }
  validateHttpUrl(url.toString(), stage);
  url.search = "";
  url.hash = "";
  url.searchParams.set("p", payload);
  url.searchParams.set("e", String(expiry));
  url.searchParams.set("s", encodeBase64Url(signature));

  return {
    url: url.toString(),
    expiresAt: new Date(expiry * 1_000).toISOString(),
  };
}

export async function verifySignedStreamUrl(
  parameters: URLSearchParams,
  secret: string,
  now?: number | Date,
): Promise<unknown> {
  const stage = "signed-url-verify";
  const allowedNames = new Set(["p", "e", "s"]);
  if (
    [...parameters.keys()].some((name) => !allowedNames.has(name)) ||
    parameters.getAll("p").length !== 1 ||
    parameters.getAll("e").length !== 1 ||
    parameters.getAll("s").length !== 1
  ) {
    throw signingError("SIGNATURE_INVALID", "The signed URL parameters are invalid.", stage);
  }

  const payload = parameters.get("p");
  const expiryText = parameters.get("e");
  const signatureText = parameters.get("s");
  if (payload === null || expiryText === null || signatureText === null) {
    throw signingError("SIGNATURE_INVALID", "The signed URL parameters are incomplete.", stage);
  }
  if (payload.length > MAX_ENCODED_PAYLOAD_LENGTH) {
    throw signingError(
      "SIGNED_URL_PAYLOAD_TOO_LARGE",
      "The signed URL payload exceeds 8 KiB.",
      stage,
    );
  }
  if (!/^[1-9]\d*$/.test(expiryText)) {
    throw signingError("SIGNATURE_INVALID", "The signed URL expiry is invalid.", stage);
  }
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry)) {
    throw signingError("SIGNATURE_INVALID", "The signed URL expiry is invalid.", stage);
  }

  const signature = decodeCanonicalBase64Url(signatureText, stage);
  if (signature.byteLength !== 32) {
    throw signingError("SIGNATURE_INVALID", "The signed URL signature is invalid.", stage);
  }
  const key = await importSigningKey(secret, stage);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    textEncoder.encode(`${expiryText}.${payload}`),
  );
  if (!valid) {
    throw signingError("SIGNATURE_INVALID", "The signed URL signature is invalid.", stage);
  }

  const nowSeconds = Math.floor(nowMilliseconds(now, stage) / 1_000);
  if (expiry <= nowSeconds) {
    throw new GatewayError("SIGNATURE_EXPIRED", "The signed URL has expired.", { stage });
  }
  if (expiry > nowSeconds + LIMITS.signedUrlTtlSeconds) {
    throw signingError("SIGNATURE_INVALID", "The signed URL expiry is too far in the future.", stage);
  }

  const payloadBytes = decodeCanonicalBase64Url(payload, stage);
  if (payloadBytes.byteLength > LIMITS.signedPayloadBytes) {
    throw signingError(
      "SIGNED_URL_PAYLOAD_TOO_LARGE",
      "The signed URL payload exceeds 8 KiB.",
      stage,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch (error) {
    throw new GatewayError("SIGNATURE_INVALID", "The signed URL payload is invalid JSON.", {
      stage,
      cause: error,
    });
  }
  validateSignedPipeline(parsed, stage);
  return parsed;
}
