import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Worker runtimes cannot compile arbitrary Wasm bytes. Generate capped binaries
// at install time, then import them as precompiled modules in image-codecs.ts.
// Both Emscripten and Rust can execute memory.grow internally, so a JS-side
// allocation check alone would not enforce this limit.
const MAX_MEMORY_PAGES = 512; // 32 MiB per fresh codec instance.
const codecs = [
  {
    source: "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
    output: "jpeg-dec.wasm",
    sha256: "a7c4b12169817e779ff4af137981393ae924944e167ad1bd95747c9199162d3e",
  },
  {
    source: "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
    output: "jpeg-enc.wasm",
    sha256: "24d4177f1c4963e2058b107189249651c61fdef125570e79b1dfb63c8bb49326",
  },
  {
    source: "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
    output: "png.wasm",
    sha256: "263d6e658808a74b72a1a99c5cc1d619237e70c150db6e41d5d84d3d117ab9be",
  },
];

function readUnsignedLeb(bytes, cursor) {
  let result = 0;
  for (let index = 0; index < 5; index += 1) {
    if (cursor.offset >= bytes.byteLength) throw new Error("Truncated Wasm LEB");
    const byte = bytes[cursor.offset++];
    if (index === 4 && byte > 15) throw new Error("Invalid Wasm u32 LEB");
    result += (byte & 127) * 2 ** (index * 7);
    if ((byte & 128) === 0) return result;
  }
  throw new Error("Invalid Wasm LEB");
}

function unsignedLeb(value) {
  const output = [];
  do {
    const remainder = value % 128;
    value = Math.floor(value / 128);
    output.push(remainder | (value > 0 ? 128 : 0));
  } while (value > 0);
  return Buffer.from(output);
}

function capMemory(source) {
  const header = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  if (!source.subarray(0, 8).equals(header)) throw new Error("Invalid Wasm header");
  const cursor = { offset: 8 };
  const sections = [source.subarray(0, 8)];
  let memories = 0;
  while (cursor.offset < source.byteLength) {
    const sectionStart = cursor.offset;
    const id = source[cursor.offset++];
    const length = readUnsignedLeb(source, cursor);
    const sectionEnd = cursor.offset + length;
    if (sectionEnd > source.byteLength) throw new Error("Truncated Wasm section");
    if (id === 5) {
      const count = readUnsignedLeb(source, cursor);
      const flags = readUnsignedLeb(source, cursor);
      const initial = readUnsignedLeb(source, cursor);
      const maximum = flags & 1 ? readUnsignedLeb(source, cursor) : undefined;
      if (
        memories !== 0 || count !== 1 || (flags !== 0 && flags !== 1) ||
        initial > MAX_MEMORY_PAGES ||
        (maximum !== undefined && maximum < MAX_MEMORY_PAGES) ||
        cursor.offset !== sectionEnd
      ) {
        throw new Error("Unexpected codec memory layout; review the upstream ABI");
      }
      memories += 1;
      const memory = Buffer.concat([
        unsignedLeb(1), unsignedLeb(1), unsignedLeb(initial), unsignedLeb(MAX_MEMORY_PAGES),
      ]);
      sections.push(Buffer.from([5]), unsignedLeb(memory.byteLength), memory);
    } else {
      sections.push(source.subarray(sectionStart, sectionEnd));
    }
    cursor.offset = sectionEnd;
  }
  if (memories !== 1) throw new Error("Expected exactly one codec memory");
  const capped = Buffer.concat(sections);
  const module = new WebAssembly.Module(capped);
  if (WebAssembly.Module.imports(module).some(({ kind }) => kind === "memory")) {
    throw new Error("Codec memory imports are not supported");
  }
  if (WebAssembly.Module.exports(module).filter(({ kind }) => kind === "memory").length !== 1) {
    throw new Error("Expected exactly one exported codec memory");
  }
  return capped;
}

const outputDirectory = new URL("../src/vendor/image/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
for (const codec of codecs) {
  const source = await readFile(new URL(`../node_modules/${codec.source}`, import.meta.url));
  if (createHash("sha256").update(source).digest("hex") !== codec.sha256) {
    throw new Error(`Unexpected ${codec.source} hash; review the upstream binary and license`);
  }
  const capped = capMemory(source);
  // Verify the memory rewrite is stable as well as validating the binary above.
  if (!capMemory(capped).equals(capped)) throw new Error("Non-idempotent memory cap");
  await writeFile(new URL(codec.output, outputDirectory), capped);
}

// Native WebP is built from patched libwebp, rather than the outdated npm
// codec. Ordinary npm installs verify the committed build, without installing
// a native toolchain or downloading native sources. The manual rebuild recipe
// and C bridge hashes must match the same build manifest as the binaries.
const manifest = JSON.parse(await readFile(new URL("webp-build.json", outputDirectory), "utf8"));
const inputPaths = new Set(["src/native/image-webp.c", "scripts/build-webp-wasm.mjs"]);
const artifactPaths = new Set(["src/vendor/image/webp-dec.wasm", "src/vendor/image/webp-enc.wasm"]);
if (manifest.formatVersion !== 1 || manifest.libwebp?.version !== "1.6.0" ||
  manifest.toolchain?.version !== "4.0.17" || !Array.isArray(manifest.inputs) ||
  !Array.isArray(manifest.artifacts)) throw new Error("Unexpected native WebP build manifest");

for (const input of manifest.inputs) {
  if (!inputPaths.delete(input.path)) throw new Error("Unexpected native WebP build input");
  const bytes = await readFile(new URL(`../${input.path}`, import.meta.url));
  if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) {
    throw new Error(`Native WebP build input changed; rebuild and review ${input.path}`);
  }
}
if (inputPaths.size !== 0) throw new Error("Native WebP build inputs are missing");

for (const artifact of manifest.artifacts) {
  if (!artifactPaths.delete(artifact.path) || artifact.version !== 0x010600 ||
    artifact.maxMemoryPages !== MAX_MEMORY_PAGES) throw new Error("Unexpected native WebP artifact");
  const bytes = await readFile(new URL(`../${artifact.path}`, import.meta.url));
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new Error(`Unexpected native WebP binary hash: ${artifact.path}`);
  }
  if (!capMemory(bytes).equals(bytes)) throw new Error("Native WebP memory was not capped at build time");
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {
    env: { emscripten_notify_memory_growth() {} },
    wasi_snapshot_preview1: {
      proc_exit() { throw new Error("Native WebP verification stopped"); },
      fd_write() { return 52; }, fd_close() { return 52; }, fd_seek() { return 52; },
    },
  });
  const { memory, _initialize: initialize, streamr_webp_version: version } = instance.exports;
  try {
    if (typeof initialize === "function") initialize();
    if (typeof version !== "function" || version() !== artifact.version) {
      throw new Error("Native WebP version does not match its build manifest");
    }
    let limited = false;
    try {
      memory.grow(MAX_MEMORY_PAGES + 1 - memory.buffer.byteLength / 65536);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      limited = true;
    }
    if (!limited) throw new Error("Native WebP can exceed its memory ceiling");
  } finally {
    new Uint8Array(memory.buffer).fill(0);
  }
}
if (artifactPaths.size !== 0) throw new Error("Native WebP artifacts are missing");
console.log(`Prepared ${codecs.length} npm codecs and verified 2 native WebP codecs with a ${MAX_MEMORY_PAGES * 65536} byte memory cap.`);
