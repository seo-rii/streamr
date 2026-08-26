import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";

function encodedFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function rawResponse(
  byteStream: ByteStream,
  output: {
    contentType?: string | undefined;
    filename?: string | undefined;
  },
): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  const contentType = output.contentType ?? byteStream.contentType;
  if (contentType !== undefined) {
    if (/[\r\n]/.test(contentType)) {
      byteStream.abort("invalid content type");
      throw new GatewayError("INVALID_CONTENT_TYPE", "The output content type is invalid.", {
        stage: "output-validate",
      });
    }
    headers.set("Content-Type", contentType);
  }
  const filename = output.filename ?? byteStream.filename;
  if (filename !== undefined) {
    if (/[\r\n]/.test(filename)) {
      byteStream.abort("invalid filename");
      throw new GatewayError("INVALID_HEADER", "The output filename is invalid.", {
        stage: "output-validate",
      });
    }
    headers.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodedFilename(filename)}`,
    );
  }
  if (byteStream.knownLength !== undefined) {
    headers.set("Content-Length", String(byteStream.knownLength));
  }

  return new Response(byteStream.stream, { status: 200, headers });
}
