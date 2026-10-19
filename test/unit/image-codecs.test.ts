import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeImage, encodeImage } from "../../src/transforms/image-codecs";

interface FactoryOptions {
  instantiateWasm(
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ): WebAssembly.Exports;
}

type Factory = (options: FactoryOptions) => Promise<unknown>;

const fixture = vi.hoisted(() => ({
  storage: "independent" as "independent" | "heap",
  outputs: [] as (Uint8Array | Uint8ClampedArray)[],
  memories: [] as WebAssembly.Memory[],
}));

async function instantiate(factory: Factory, options: FactoryOptions): Promise<WebAssembly.Memory> {
  let memory: WebAssembly.Memory | undefined;
  await factory({
    ...options,
    instantiateWasm(imports, receive) {
      return options.instantiateWasm(imports, (instance, module) => {
        memory = Object.values(instance.exports).find(
          (value): value is WebAssembly.Memory => value instanceof WebAssembly.Memory,
        );
        receive(instance, module);
      });
    },
  });
  if (memory === undefined) throw new Error("The test codec has no memory.");
  fixture.memories.push(memory);
  return memory;
}

vi.mock("@jsquash/jpeg/codec/dec/mozjpeg_dec.js", async (importOriginal) => {
  const original = await importOriginal<{ default: Factory }>();
  return {
    default: async (options: FactoryOptions) => {
      const memory = await instantiate(original.default, options);
      return {
        decode() {
          const data = fixture.storage === "heap"
            ? new Uint8ClampedArray(memory.buffer, memory.buffer.byteLength - 8, 8)
            : new Uint8ClampedArray(8);
          data.set([20, 40, 60, 255, 80, 100, 120, 255]);
          fixture.outputs.push(data);
          return { data, width: 2, height: 1 };
        },
      };
    },
  };
});

vi.mock("@jsquash/jpeg/codec/enc/mozjpeg_enc.js", async (importOriginal) => {
  const original = await importOriginal<{ default: Factory }>();
  return {
    default: async (options: FactoryOptions) => {
      const memory = await instantiate(original.default, options);
      return {
        encode() {
          const data = fixture.storage === "heap"
            ? new Uint8Array(memory.buffer, memory.buffer.byteLength - 8, 8)
            : new Uint8Array(8);
          data.set([255, 216, 20, 40, 60, 80, 255, 217]);
          fixture.outputs.push(data);
          return data;
        },
      };
    },
  };
});

beforeEach(() => {
  fixture.storage = "independent";
  fixture.outputs.length = 0;
  fixture.memories.length = 0;
});

afterEach(() => {
  for (const output of fixture.outputs) output.fill(0);
});

describe("JPEG output ownership across codec disposal", () => {
  it.each(["independent", "heap"] as const)("keeps %s decoded pixels usable after memory is cleared", async (storage) => {
    fixture.storage = storage;
    const result = await decodeImage(new Uint8Array([1]), "jpeg");
    expect(result).toMatchObject({ width: 2, height: 1 });
    expect([...result.data]).toEqual([20, 40, 60, 255, 80, 100, 120, 255]);
    if (storage === "independent") expect(result.data).toBe(fixture.outputs[0]);
    else expect(result.data).not.toBe(fixture.outputs[0]);
    expect(result.data.buffer).not.toBe(fixture.memories[0]!.buffer);
    expect(new Uint8Array(fixture.memories[0]!.buffer).every((byte) => byte === 0)).toBe(true);
    result.data.fill(0);
  });

  it.each(["independent", "heap"] as const)("keeps %s encoded output usable after memory is cleared", async (storage) => {
    fixture.storage = storage;
    const result = await encodeImage({ data: new Uint8ClampedArray(8), width: 2, height: 1 }, "jpeg");
    expect([...result]).toEqual([255, 216, 20, 40, 60, 80, 255, 217]);
    if (storage === "independent") expect(result).toBe(fixture.outputs[0]);
    else expect(result).not.toBe(fixture.outputs[0]);
    expect(result.buffer).not.toBe(fixture.memories[0]!.buffer);
    expect(new Uint8Array(fixture.memories[0]!.buffer).every((byte) => byte === 0)).toBe(true);
    result.fill(0);
  });
});
