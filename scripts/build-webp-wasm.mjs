import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// This optional maintainer rebuild fetches pinned archives, not floating npm
// codec binaries. Normal npm ci verifies the committed artifacts and manifest.
// Optional local archives still have to match the same hashes exactly.
const LIBWEBP = {
  version: "1.6.0",
  tag: "v1.6.0",
  commit: "4fa21912338357f89e4fd51cf2368325b59e9bd9",
  source: {
    url: "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz",
    sha256: "e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564",
  },
};
const TOOLCHAIN = {
  name: "Emscripten",
  version: "4.0.17",
  release: "41d2106c68c28e101e6252a48e22c78b07722508",
  platform: "linux-x64",
  url: "https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/41d2106c68c28e101e6252a48e22c78b07722508/wasm-binaries.tar.xz",
  sha256: "5e4269ab4d4dd97da93f2833bb97780ef6ddee9a7325d345587bddf8890d89aa",
};
const VERSION = 0x010600;
const MAX_MEMORY_PAGES = 512;
const CMAKE_OPTIONS = [
  "-G", "Ninja",
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_C_FLAGS_RELEASE=-O3 -DNDEBUG",
  "-DBUILD_SHARED_LIBS=OFF",
  "-DWEBP_LINK_STATIC=ON",
  "-DWEBP_ENABLE_SIMD=OFF",
  "-DWEBP_USE_THREAD=OFF",
  "-DWEBP_BUILD_ANIM_UTILS=OFF",
  "-DWEBP_BUILD_CWEBP=OFF",
  "-DWEBP_BUILD_DWEBP=OFF",
  "-DWEBP_BUILD_GIF2WEBP=OFF",
  "-DWEBP_BUILD_IMG2WEBP=OFF",
  "-DWEBP_BUILD_VWEBP=OFF",
  "-DWEBP_BUILD_WEBPINFO=OFF",
  "-DWEBP_BUILD_LIBWEBPMUX=OFF",
  "-DWEBP_BUILD_WEBPMUX=OFF",
  "-DWEBP_BUILD_EXTRAS=OFF",
  "-DWEBP_BUILD_WEBP_JS=OFF",
  "-DWEBP_BUILD_FUZZTEST=OFF",
];
const LINK_OPTIONS = [
  "-O3",
  "-DNDEBUG",
  "--no-entry",
  "-sSTANDALONE_WASM=1",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sINITIAL_MEMORY=8388608",
  "-sMAXIMUM_MEMORY=33554432",
  "-sSTACK_SIZE=65536",
  "-sFILESYSTEM=0",
  "-sMALLOC=emmalloc",
  "-sABORTING_MALLOC=0",
  "-sASSERTIONS=0",
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = "src/native/image-webp.c";
const script = "scripts/build-webp-wasm.mjs";

async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function pinnedArchive(spec, filename, local) {
  if (local === undefined) {
    console.log(`Downloading pinned ${path.basename(filename)}.`);
    const response = await fetch(spec.url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || response.body === null) {
      throw new Error(`Archive download failed with HTTP ${response.status}.`);
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(filename, { mode: 0o600, flags: "wx" }),
    );
  }
  const archive = local === undefined ? filename : path.resolve(local);
  if (await hashFile(archive) !== spec.sha256) {
    throw new Error(`Pinned archive hash did not match: ${path.basename(archive)}.`);
  }
  return archive;
}

async function run(command, args, env, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      if (status === 0) resolve();
      else reject(new Error(`${path.basename(command)} failed (${status ?? signal}).`));
    });
  });
}

function readLeb(bytes, position) {
  let value = 0;
  for (let offset = 0; offset < 5; offset += 1) {
    if (position.index >= bytes.length) throw new Error("Truncated Wasm LEB.");
    const byte = bytes[position.index++];
    if (offset === 4 && byte > 15) throw new Error("Invalid Wasm LEB.");
    value += (byte & 127) * 2 ** (7 * offset);
    if ((byte & 128) === 0) return value;
  }
  throw new Error("Invalid Wasm LEB.");
}

function verifyArtifact(bytes, operation) {
  const position = { index: 8 };
  let memories = 0;
  while (position.index < bytes.length) {
    const section = bytes[position.index++];
    const length = readLeb(bytes, position);
    const end = position.index + length;
    if (end > bytes.length) throw new Error("Truncated Wasm section.");
    if (section === 5) {
      const count = readLeb(bytes, position);
      const flags = readLeb(bytes, position);
      const initial = readLeb(bytes, position);
      const maximum = readLeb(bytes, position);
      if (count !== 1 || flags !== 1 || initial !== 128 || maximum !== MAX_MEMORY_PAGES ||
          position.index !== end || memories !== 0) {
        throw new Error("WebP module memory must be private and capped at 32 MiB.");
      }
      memories += 1;
    }
    position.index = end;
  }
  if (memories !== 1) throw new Error("Expected exactly one WebP module memory.");
  const module = new WebAssembly.Module(bytes);
  const allowedImports = new Set([
    "env.emscripten_notify_memory_growth",
    "wasi_snapshot_preview1.proc_exit",
    "wasi_snapshot_preview1.fd_write",
    "wasi_snapshot_preview1.fd_close",
    "wasi_snapshot_preview1.fd_seek",
  ]);
  for (const imported of WebAssembly.Module.imports(module)) {
    if (imported.kind !== "function" || !allowedImports.has(`${imported.module}.${imported.name}`)) {
      throw new Error(`Unexpected native WebP import: ${imported.module}.${imported.name}.`);
    }
  }
  const instance = new WebAssembly.Instance(module, {
    env: { emscripten_notify_memory_growth() {} },
    wasi_snapshot_preview1: {
      proc_exit() { throw new Error("WebP native process exited."); },
      fd_write: () => 52,
      fd_close: () => 52,
      fd_seek: () => 52,
    },
  });
  instance.exports._initialize?.();
  if (instance.exports.streamr_webp_version() !== VERSION ||
      typeof instance.exports.streamr_alloc !== "function" ||
      typeof instance.exports.streamr_free !== "function" ||
      typeof instance.exports[`streamr_webp_${operation}`] !== "function") {
    throw new Error("WebP binary version or ABI differs from the pinned build.");
  }
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("WebP memory is unavailable.");
  try {
    memory.grow(MAX_MEMORY_PAGES + 1);
    throw new Error("WebP memory can exceed its required cap.");
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  } finally {
    new Uint8Array(memory.buffer).fill(0);
  }
}

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("This pinned rebuild uses the Linux x64 Emscripten toolchain.");
}
if (process.argv.length !== 2) throw new Error("Usage: node scripts/build-webp-wasm.mjs");
const scratch = await mkdtemp(path.join(tmpdir(), "streamr-webp-build-"));
try {
  const sourceArchive = await pinnedArchive(
    LIBWEBP.source, path.join(scratch, "libwebp.tar.gz"), process.env.STREAMR_WEBP_SOURCE_ARCHIVE,
  );
  const toolchainArchive = await pinnedArchive(
    TOOLCHAIN, path.join(scratch, "emscripten.tar.xz"), process.env.STREAMR_WEBP_TOOLCHAIN_ARCHIVE,
  );
  await run("tar", ["-xzf", sourceArchive, "-C", scratch], process.env);
  await run("tar", ["-xJf", toolchainArchive, "-C", scratch], process.env);
  const source = path.join(scratch, `libwebp-${LIBWEBP.version}`);
  const install = path.join(scratch, "install");
  const emscripten = path.join(install, "emscripten");
  const config = path.join(scratch, "emscripten.config");
  await writeFile(config, [
    `LLVM_ROOT = ${JSON.stringify(path.join(install, "bin"))}`,
    `BINARYEN_ROOT = ${JSON.stringify(install)}`,
    `NODE_JS = ${JSON.stringify(process.execPath)}`,
  ].join("\n") + "\n", { mode: 0o600 });
  const env = {
    ...process.env,
    EM_CONFIG: config,
    // The pinned archive already contains its matching C runtime libraries.
    // Keep that cache private to this extracted install, avoiding a global
    // cache or unnecessary recompilation of toolchain-owned runtime sources.
    EM_CACHE: path.join(emscripten, "cache"),
    EMCC_CORES: "4",
    SOURCE_DATE_EPOCH: "1752105600",
  };
  delete env.EMCC_CFLAGS;
  delete env.CFLAGS;
  delete env.LDFLAGS;
  const emcc = path.join(emscripten, "emcc");
  const emcmake = path.join(emscripten, "emcmake");
  const build = path.join(scratch, "build");
  const prefixMaps = [
    `-ffile-prefix-map=${scratch}=/streamr-webp-build`,
    `-ffile-prefix-map=${root}=/streamr`,
  ];
  const cmakeOptions = CMAKE_OPTIONS.map((option) =>
    option.startsWith("-DCMAKE_C_FLAGS_RELEASE=")
      ? `${option} ${prefixMaps.map((flag) => JSON.stringify(flag)).join(" ")}`
      : option,
  );
  await run(emcc, ["--version"], env);
  await run(emcmake, ["cmake", "-S", source, "-B", build, ...cmakeOptions], env);
  await run("cmake", ["--build", build, "--parallel", "4", "--target", "webp", "webpdecoder"], env);
  const artifacts = [];
  const outputDirectory = path.join(root, "src/vendor/image");
  await mkdir(outputDirectory, { recursive: true });
  for (const operation of ["decode", "encode"]) {
    const decoder = operation === "decode";
    const filename = decoder ? "webp-dec.wasm" : "webp-enc.wasm";
    const output = path.join(scratch, filename);
    const exports = ["_streamr_alloc", "_streamr_free", "_streamr_webp_version",
      `_streamr_webp_${operation}`];
    await run(emcc, [
      path.join(root, bridge),
      "-I", path.join(source, "src"),
      `-DSTREAMR_WEBP_${decoder ? "DECODER" : "ENCODER"}=1`,
      path.join(build, decoder ? "libwebpdecoder.a" : "libwebp.a"),
      ...(decoder ? [] : [path.join(build, "libsharpyuv.a")]),
      ...LINK_OPTIONS,
      ...prefixMaps,
      `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports)}`,
      "-o", output,
    ], env);
    const bytes = await readFile(output);
    verifyArtifact(bytes, operation);
    await writeFile(path.join(outputDirectory, filename), bytes);
    artifacts.push({
      path: `src/vendor/image/${filename}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      version: VERSION,
      maxMemoryPages: MAX_MEMORY_PAGES,
    });
    console.log(`Built ${filename}: ${bytes.byteLength} bytes, libwebp ${LIBWEBP.version}.`);
  }
  const inputs = await Promise.all([bridge, script].map(async (input) => ({
    path: input, sha256: await hashFile(path.join(root, input)),
  })));
  const manifest = {
    formatVersion: 1,
    libwebp: LIBWEBP,
    toolchain: TOOLCHAIN,
    inputs,
    artifacts,
    build: {
      cmakeOptions: CMAKE_OPTIONS,
      linkOptions: LINK_OPTIONS,
      decoderDefine: "STREAMR_WEBP_DECODER=1",
      encoderDefine: "STREAMR_WEBP_ENCODER=1",
      pathMappings: { scratch: "/streamr-webp-build", repository: "/streamr" },
    },
  };
  await writeFile(path.join(outputDirectory, "webp-build.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("Wrote native WebP provenance manifest.");
} finally {
  // Remove only the unique directory this script created, never a caller's path.
  await rm(scratch, { recursive: true, force: true });
}
