export interface ByteStream {
  stream: ReadableStream<Uint8Array>;
  knownLength?: number;
  contentType?: string;
  filename?: string;
  abort(reason?: unknown): void;
}

export function wrapCancellableStream(
  stream: ReadableStream<Uint8Array>,
  abort: (reason?: unknown) => void,
  onDone?: () => void,
  mapError?: (error: unknown) => unknown,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          onDone?.();
          release();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        const mappedError = mapError?.(error) ?? error;
        onDone?.();
        release();
        abort(mappedError);
        controller.error(mappedError);
      }
    },
    async cancel(reason) {
      onDone?.();
      abort(reason);
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}
