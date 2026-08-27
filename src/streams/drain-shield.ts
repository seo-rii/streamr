import type { ByteStream } from "./byte-stream";

export interface DrainShield {
  byteStream: ByteStream;
  drain(reason?: unknown): Promise<void>;
  waitForCompletion(): Promise<void>;
}

/**
 * Prevents a transform-local cancellation, such as a completed slice, from
 * aborting the enclosing archive. The remaining bytes of the one active entry
 * are drained before the archive iterator is allowed to advance.
 */
export function createDrainShield(input: ByteStream): DrainShield {
  const reader = input.stream.getReader();
  let done = false;
  let released = false;
  let terminalError: unknown;
  let drainRequested = false;
  let activeRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let drainPromise: Promise<void> | undefined;

  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const read = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    activeRead ??= reader
      .read()
      .then(
        (result) => {
          if (result.done) {
            done = true;
            release();
          }
          return result;
        },
        (error: unknown) => {
          done = true;
          terminalError = error;
          release();
          throw error;
        },
      )
      .finally(() => {
        activeRead = undefined;
      });
    return activeRead;
  };
  const drain = (reason?: unknown): Promise<void> => {
    drainRequested = true;
    drainPromise ??= (async () => {
      try {
        if (terminalError !== undefined) throw terminalError;
        while (!done) {
          const result = await read();
          if (result.done) done = true;
        }
        if (terminalError !== undefined) throw terminalError;
      } finally {
        if (done) release();
      }
    })();
    // ByteStream.abort cannot return a promise. Observe errors immediately;
    // the caller still receives the same rejection when it awaits drain().
    void drainPromise.catch(() => undefined);
    void reason;
    return drainPromise;
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (drainRequested) {
          await drain();
          controller.close();
          return;
        }
        const result = await read();
        if (result.done) {
          controller.close();
        } else if (drainRequested) {
          await drain();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      },
      async cancel(reason) {
        await drain(reason);
      },
    },
    { highWaterMark: 0 },
  );

  return {
    byteStream: {
      stream,
      ...(input.knownLength === undefined ? {} : { knownLength: input.knownLength }),
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      ...(input.filename === undefined ? {} : { filename: input.filename }),
      abort(reason?: unknown) {
        void drain(reason);
      },
    },
    drain,
    async waitForCompletion() {
      if (!done) await drain();
    },
  };
}
