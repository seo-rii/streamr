import { GatewayError } from "../errors";

export function decodeUtf8(
  decoder: TextDecoder,
  chunk?: Uint8Array,
  stream = false,
): string {
  try {
    return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream });
  } catch (error) {
    throw new GatewayError("INVALID_UTF8", "The transform input is not valid UTF-8.", {
      stage: "transform-text",
      cause: error,
    });
  }
}

export function assertUtf8ContentType(contentType: string | undefined): void {
  if (contentType === undefined) return;
  const charset = /(?:^|;)\s*charset\s*=\s*['"]?([^;'"\s]+)/i.exec(contentType)?.[1];
  if (charset !== undefined && charset.toLowerCase() !== "utf-8" && charset.toLowerCase() !== "utf8") {
    throw new GatewayError(
      "INVALID_TRANSFORM",
      "Text transforms require a UTF-8 input stream.",
      {
        stage: "transform-validate",
        details: { contentType },
      },
    );
  }
}

export function assertUnicodeScalar(value: string, field: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (unit < 0xdc00 || unit > 0xdfff) {
      continue;
    }
    throw new GatewayError("INVALID_TRANSFORM", "Transform text contains an unpaired surrogate.", {
      stage: "transform-validate",
      details: { field },
    });
  }
}
