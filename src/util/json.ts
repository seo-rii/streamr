import { LIMITS } from "../constants";
import { GatewayError } from "../errors";

export async function readJsonRequest(request: Request): Promise<unknown> {
  if (request.body === null) {
    throw new GatewayError("INVALID_REQUEST", "A JSON request body is required.", {
      stage: "request-parse",
    });
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.controlRequestBytes) {
        await reader.cancel("control request limit exceeded");
        throw new GatewayError("INVALID_REQUEST", "The request body is too large.", {
          stage: "request-parse",
          status: 413,
          details: { maxBytes: LIMITS.controlRequestBytes },
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError("INVALID_REQUEST", "The request body could not be read.", {
      stage: "request-parse",
      cause: error,
    });
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new GatewayError("INVALID_REQUEST", "The request body is not valid UTF-8.", {
      stage: "request-parse",
      cause: error,
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new GatewayError("INVALID_REQUEST", "The request body is not valid JSON.", {
      stage: "request-parse",
      cause: error,
    });
  }
}

