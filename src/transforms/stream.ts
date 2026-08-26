import type { ByteStream } from "../streams/byte-stream";

export interface DerivedByteStreamMetadata {
  knownLength?: number;
  contentType?: string;
  filename?: string;
}

export type NativeTransformCompletion =
  | { ok: true }
  | { ok: false; error: unknown };

export function pipeNativeTransform(
  input: ReadableStream<Uint8Array>,
  transform: { readable: ReadableStream<unknown>; writable: WritableStream<BufferSource> },
): { stream: ReadableStream<Uint8Array>; completion: Promise<NativeTransformCompletion> } {
  const completion = input
    .pipeTo(transform.writable as WritableStream<Uint8Array>)
    .then(
      (): NativeTransformCompletion => ({ ok: true }),
      (error: unknown): NativeTransformCompletion => ({ ok: false, error }),
    );
  return {
    stream: transform.readable as ReadableStream<Uint8Array>,
    completion,
  };
}

export function derivedByteStream(
  input: ByteStream,
  iterator: AsyncIterator<Uint8Array>,
  metadata: DerivedByteStreamMetadata,
): ByteStream {
  let finished = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) {
          finished = true;
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        finished = true;
        input.abort(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      input.abort(reason);
      if (!finished) {
        finished = true;
        await iterator.return?.();
      }
    },
  });

  return {
    stream,
    ...(metadata.knownLength === undefined ? {} : { knownLength: metadata.knownLength }),
    ...(metadata.contentType === undefined ? {} : { contentType: metadata.contentType }),
    ...(metadata.filename === undefined ? {} : { filename: metadata.filename }),
    abort(reason) {
      input.abort(reason);
    },
  };
}

export async function* inputChunks(input: ByteStream): AsyncGenerator<Uint8Array> {
  const reader = input.stream.getReader();
  let completed = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!completed) await reader.cancel("downstream transform stopped").catch(() => undefined);
    reader.releaseLock();
  }
}

export function preservedMetadata(
  input: ByteStream,
  knownLength: number | undefined,
): DerivedByteStreamMetadata {
  return {
    ...(knownLength === undefined ? {} : { knownLength }),
    ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
    ...(input.filename === undefined ? {} : { filename: input.filename }),
  };
}
