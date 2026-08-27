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

  remainingInput(): Uint8Array {
    this.refresh();
    const position = this.words[2] ?? 0;
    const size = this.words[3] ?? 0;
    if (position > size || size > this.bufferSize) {
      throw new GatewayError("CORRUPT_ARCHIVE", "The XZ decoder input state is invalid.", {
        stage: "decompress",
        details: { format: "xz" },
      });
    }
    return this.bytes.slice(this.inputStart + position, this.inputStart + size);
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
  let decoderRemainder: Uint8Array | undefined;
  let decoderRemainderOffset = 0;
  let inputEnded = false;
  let awaitingNextStream = false;
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

  const readNextCompressedByte = async (): Promise<number | undefined> => {
    if (
      decoderRemainder !== undefined &&
      decoderRemainderOffset < decoderRemainder.byteLength
    ) {
      const value = decoderRemainder[decoderRemainderOffset];
      decoderRemainderOffset += 1;
      return value;
    }
    decoderRemainder = undefined;
    decoderRemainderOffset = 0;

    while (currentInput === undefined || inputOffset >= currentInput.byteLength) {
      if (inputEnded) return undefined;
      const result = await reader.read();
      if (result.done) {
        inputEnded = true;
        return undefined;
      }
      if (result.value.byteLength === 0) continue;
      currentInput = result.value;
      inputOffset = 0;
    }
    const value = currentInput[inputOffset];
    inputOffset += 1;
    return value;
  };

  const startNextStream = async (): Promise<boolean> => {
    let paddingBytes = 0;
    let first = await readNextCompressedByte();
    while (first === 0) {
      paddingBytes += 1;
      first = await readNextCompressedByte();
    }
    if (paddingBytes % 4 !== 0) {
      throw new GatewayError("CORRUPT_ARCHIVE", "The XZ stream padding is invalid.", {
        stage: "decompress",
        details: { format: "xz" },
      });
    }
    if (first === undefined) return false;

    const header = new Uint8Array(6);
    header[0] = first;
    for (let index = 1; index < header.byteLength; index += 1) {
      const value = await readNextCompressedByte();
      if (value === undefined) {
        throw new GatewayError("CORRUPT_ARCHIVE", "Trailing XZ data is truncated.", {
          stage: "decompress",
          details: { format: "xz" },
        });
      }
      header[index] = value;
    }
    if (
      header[0] !== 0xfd ||
      header[1] !== 0x37 ||
      header[2] !== 0x7a ||
      header[3] !== 0x58 ||
      header[4] !== 0x5a ||
      header[5] !== 0x00
    ) {
      throw new GatewayError("CORRUPT_ARCHIVE", "Unexpected data follows the XZ stream.", {
        stage: "decompress",
        details: { format: "xz" },
      });
    }

    context = new XzContext();
    context.supplyInput(header);
    return true;
  };

  const stream = new ReadableStream<Uint8Array>({
    start() {
      context = new XzContext();
    },
    async pull(controller) {
      try {
        if (awaitingNextStream) {
          if (!(await startNextStream())) {
            await cleanup("XZ stream complete");
            controller.close();
            return;
          }
          awaitingNextStream = false;
        }
        if (context === undefined) throw new Error("XZ decoder was not initialized");
        while (context.needsInput()) {
          if (
            decoderRemainder !== undefined &&
            decoderRemainderOffset < decoderRemainder.byteLength
          ) {
            const length = Math.min(
              context.bufferSize,
              decoderRemainder.byteLength - decoderRemainderOffset,
            );
            context.supplyInput(
              decoderRemainder.subarray(
                decoderRemainderOffset,
                decoderRemainderOffset + length,
              ),
            );
            decoderRemainderOffset += length;
            continue;
          }
          decoderRemainder = undefined;
          decoderRemainderOffset = 0;
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
          decoderRemainder = context.remainingInput();
          decoderRemainderOffset = 0;
          context.dispose();
          context = undefined;
          awaitingNextStream = true;
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
