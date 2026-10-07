export const ERROR_STATUS = {
  INVALID_REQUEST: 400,
  INVALID_URL: 400,
  INVALID_HEADER: 400,
  INVALID_CONTENT_TYPE: 400,
  INVALID_TRANSFORM: 400,
  UNSUPPORTED_SCHEME: 400,
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  SIGNATURE_INVALID: 403,
  SIGNATURE_EXPIRED: 403,
  SIGNED_URL_PAYLOAD_TOO_LARGE: 400,
  SOURCE_FETCH_FAILED: 502,
  SOURCE_STATUS_REJECTED: 502,
  SOURCE_REDIRECT_LIMIT: 502,
  SOURCE_TIMEOUT: 504,
  SOURCE_BODY_MISSING: 502,
  NOT_AN_ARCHIVE: 415,
  UNSUPPORTED_FORMAT: 415,
  UNSUPPORTED_COMPRESSION: 415,
  UNSUPPORTED_ZIP_METHOD: 415,
  ARCHIVE_ENCRYPTED: 415,
  CORRUPT_ARCHIVE: 422,
  ARCHIVE_DEPTH_EXCEEDED: 415,
  ENTRY_NOT_FOUND: 404,
  ENTRY_TYPE_UNSUPPORTED: 415,
  ENTRY_LIMIT_REACHED: 413,
  ENTRY_OUTPUT_LIMIT: 413,
  ENTRY_ALREADY_CONSUMED: 409,
  INVALID_UTF8: 422,
  IMAGE_INVALID: 422,
  IMAGE_FORMAT_UNSUPPORTED: 415,
  IMAGE_LIMIT_EXCEEDED: 413,
  IMAGE_BUSY: 503,
  OUTPUT_LIMIT_EXCEEDED: 413,
  CONTENT_LENGTH_UNKNOWN: 400,
  PIPELINE_ABORTED: 502,
  TARGET_FETCH_FAILED: 502,
  TARGET_REDIRECT: 502,
  TARGET_STATUS_REJECTED: 502,
  TARGET_TIMEOUT: 504,
  TARGET_BODY_REJECTED: 502,
  PARTIAL_DISTRIBUTION: 502,
  MULTIPART_STREAM_INCOMPLETE: 502,
  INTERNAL_ERROR: 500,
} as const;

export type GatewayErrorCode = keyof typeof ERROR_STATUS;

export interface SerializedGatewayError {
  code: GatewayErrorCode;
  message: string;
  stage: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly stage: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly status: number;

  constructor(
    code: GatewayErrorCode,
    message: string,
    options: {
      stage: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
      status?: number;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "GatewayError";
    this.code = code;
    this.stage = options.stage;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.status = options.status ?? ERROR_STATUS[code];
  }

  serialize(): SerializedGatewayError {
    return {
      code: this.code,
      message: this.message,
      stage: this.stage,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function asGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;

  if (error instanceof DOMException && error.name === "AbortError") {
    return new GatewayError("PIPELINE_ABORTED", "The pipeline was aborted.", {
      stage: "pipeline",
      retryable: true,
      cause: error,
    });
  }

  return new GatewayError("INTERNAL_ERROR", "An internal error occurred.", {
    stage: "internal",
    cause: error,
  });
}

export function errorResponse(error: unknown, requestId?: string): Response {
  const gatewayError = asGatewayError(error);
  return Response.json(
    {
      ok: false,
      ...(requestId === undefined ? {} : { requestId }),
      error: gatewayError.serialize(),
    },
    {
      status: gatewayError.status,
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
