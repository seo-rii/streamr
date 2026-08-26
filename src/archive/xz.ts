import xzModule from "../vendor/xz-decompress.wasm";
import { LIMITS } from "../constants";
import { GatewayError } from "../errors";
import type { ByteStream } from "../streams/byte-stream";

const XZ_OK = 0;
const XZ_STREAM_END = 1;
const XZ_MEMORY_LIMIT = 64 * 1024 * 1024;

interface XzExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  create_context(): number;
  destroy_context(pointer: number): void;
  supply_input(pointer: number, length: number): void;
  get_next_output(pointer: number): number;
}

class XzContext {
  readonly exports: XzExports;
  readonly pointer: number;
  readonly bufferSize: number;
  private bytes!: Uint8Array;
  private words!: Uint32Array;
  private inputStart!: number;
  private inputEnd!: number;
  private outputStart!: number;

  constructor() {
    const instance = new WebAssembly.Instance(xzModule, {});
    this.exports = instance.exports as XzExports;
    this.pointer = this.exports.create_context();
    this.refresh();
    this.bufferSize = this.words[0] ?? 0;
    this.inputStart = (this.words[1] ?? 0) - this.pointer;
    this.inputEnd = this.inputStart + this.bufferSize;
    this.outputStart = (this.words[4] ?? 0) - this.pointer;
    if (
      this.bufferSize <= 0 ||
      this.inputStart < 0 ||
      this.outputStart < 0 ||
      this.exports.memory.buffer.byteLength > XZ_MEMORY_LIMIT
    ) {
      this.dispose();
      throw new GatewayError("UNSUPPORTED_COMPRESSION", "The XZ decoder memory layout is invalid.", {
        stage: "decompress",
        details: { format: "xz", maxMemoryBytes: XZ_MEMORY_LIMIT },
      });
    }
  }

  needsInput(): boolean {
    return this.words[2] === this.words[3];
  }

  supplyInput(chunk: Uint8Array): void {
    this.refresh();
    this.bytes.subarray(this.inputStart, this.inputEnd).set(chunk);
    this.exports.supply_input(this.pointer, chunk.byteLength);
    this.refresh();
  }

  nextOutput(): { chunk: Uint8Array; finished: boolean } {
    const result = this.exports.get_next_output(this.pointer);
    this.refresh();
    if (this.exports.memory.buffer.byteLength > XZ_MEMORY_LIMIT) {
      throw new GatewayError("UNSUPPORTED_COMPRESSION", "The XZ dictionary is too large.", {
        stage: "decompress",
        details: { format: "xz", maxMemoryBytes: XZ_MEMORY_LIMIT },
      });
    }
    if (result !== XZ_OK && result !== XZ_STREAM_END) {
      throw new GatewayError("CORRUPT_ARCHIVE", "The XZ stream is corrupt or truncated.", {
        stage: "decompress",
        details: { format: "xz", decoderCode: result },
      });
    }
    const outputLength = this.words[5] ?? 0;
    const chunk = this.bytes.slice(this.outputStart, this.outputStart + outputLength);
    this.words[5] = 0;
    return { chunk, finished: result === XZ_STREAM_END };
  }

  dispose(): void {
    this.exports.destroy_context(this.pointer);
  }

  private refresh(): void {
    if (this.bytes?.buffer !== this.exports.memory.buffer) {
      this.bytes = new Uint8Array(this.exports.memory.buffer, this.pointer);
      this.words = new Uint32Array(this.exports.memory.buffer, this.pointer);
    }
  }
}

export function decompressXz(
  input: ByteStream,
  maxOutputBytes = LIMITS.requestOutputBytes,
): ByteStream {
  const reader = input.stream.getReader();
  let context: XzContext | undefined;
  let currentInput: Uint8Array | undefined;
  let inputOffset = 0;
  let inputEnded = false;
  let disposed = false;
  let outputBytes = 0;

  const cleanup = async (reason?: unknown, abortUpstream = false) => {
    if (!disposed) {
      disposed = true;
      context?.dispose();
    }
    if (abortUpstream) input.abort(reason);
    await reader.cancel(reason).catch(() => undefined);
  };

  const stream = new ReadableStream<Uint8Array>({
    start() {
      context = new XzContext();
    },
    async pull(controller) {
      try {
        if (context === undefined) throw new Error("XZ decoder was not initialized");
        while (context.needsInput()) {
          while (currentInput === undefined || inputOffset >= currentInput.byteLength) {
            const result = await reader.read();
            if (result.done) {
              if (inputEnded) {
                throw new GatewayError("CORRUPT_ARCHIVE", "The XZ stream is truncated.", {
                  stage: "decompress",
                  details: { format: "xz" },
                });
              }
              inputEnded = true;
              context.supplyInput(new Uint8Array());
              break;
            }
            if (result.value.byteLength === 0) continue;
            currentInput = result.value;
            inputOffset = 0;
          }
          if (inputEnded) break;
          const length = Math.min(context.bufferSize, currentInput!.byteLength - inputOffset);
          context.supplyInput(currentInput!.subarray(inputOffset, inputOffset + length));
          inputOffset += length;
        }

        const output = context.nextOutput();
        outputBytes += output.chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          throw new GatewayError("OUTPUT_LIMIT_EXCEEDED", "The decompressed output is too large.", {
            stage: "decompress",
            details: { format: "xz", maxBytes: maxOutputBytes },
          });
        }
        // A zero-length enqueue still satisfies the pending pull and schedules
        // the next decoder step when XZ needs more input before producing data.
        controller.enqueue(output.chunk);
        if (output.finished) {
          await cleanup("XZ stream complete");
          controller.close();
        }
      } catch (error) {
        await cleanup(error, true);
        controller.error(
          error instanceof GatewayError
            ? error
            : new GatewayError("CORRUPT_ARCHIVE", "The XZ stream is corrupt.", {
                stage: "decompress",
                cause: error,
                details: { format: "xz" },
              }),
        );
      }
    },
    async cancel(reason) {
      await cleanup(reason, true);
    },
  });

  return {
    stream,
    abort(reason?: unknown) {
      input.abort(reason);
      void cleanup(reason);
    },
  };
}
