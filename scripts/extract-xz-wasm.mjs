import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageBundle = new URL(
  "../node_modules/xz-decompress/dist/package/xz-decompress.js",
  import.meta.url,
);
const outputUrl = new URL("../src/vendor/xz-decompress.wasm", import.meta.url);
const source = await readFile(packageBundle, "utf8");
const match = /module\.exports = "data:application\/wasm;base64,([A-Za-z0-9+/=]+)"/.exec(
  source,
);
if (match?.[1] === undefined) {
  throw new Error("xz-decompress's embedded WebAssembly module was not found");
}

await mkdir(new URL("../src/vendor/", import.meta.url), { recursive: true });
await writeFile(fileURLToPath(outputUrl), Buffer.from(match[1], "base64"));
