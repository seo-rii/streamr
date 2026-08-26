export interface RequestLog {
  requestId: string;
  operation: string;
  durationMs: number;
  result: string;
  sourceHost?: string;
  sourceGets?: number;
  bytesRead?: number;
  bytesWritten?: number;
  [key: string]: unknown;
}

export function requestId(): string {
  return `req_${crypto.randomUUID()}`;
}

export function logRequest(log: RequestLog): void {
  console.log(JSON.stringify(log));
}

export function safeUrlParts(value: string): {
  scheme: string;
  hostname: string;
  pathname: string;
} | undefined {
  try {
    const url = new URL(value);
    return {
      scheme: url.protocol.replace(/:$/, ""),
      hostname: url.hostname,
      pathname: url.pathname,
    };
  } catch {
    return undefined;
  }
}

