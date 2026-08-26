import { LIMITS } from "../constants";
import { GatewayError } from "../errors";

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function validatedHeaders(
  values: Record<string, string> | undefined,
  options: { forbidden?: ReadonlySet<string>; stage: string },
): Headers {
  const result = new Headers();
  if (values === undefined) return result;

  const entries = Object.entries(values);
  if (entries.length > LIMITS.headerCount) {
    throw new GatewayError("INVALID_HEADER", "Too many headers were supplied.", {
      stage: options.stage,
      details: { max: LIMITS.headerCount },
    });
  }

  const encoder = new TextEncoder();
  for (const [name, value] of entries) {
    const lowerName = name.toLowerCase();
    if (
      !HEADER_NAME.test(name) ||
      /[\r\n]/.test(name) ||
      /[\r\n]/.test(value) ||
      encoder.encode(value).byteLength > LIMITS.headerValueBytes ||
      options.forbidden?.has(lowerName) === true
    ) {
      throw new GatewayError("INVALID_HEADER", "A supplied header is invalid.", {
        stage: options.stage,
        details: { name },
      });
    }
    result.append(name, value);
  }

  return result;
}

export function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function isTextualContentType(value: string | null): boolean {
  if (value === null) return false;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/problem+json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml")
  );
}

