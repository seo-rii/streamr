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
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          onDone?.();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        onDone?.();
        abort(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      onDone?.();
      abort(reason);
      await reader.cancel(reason);
    },
  });
}

