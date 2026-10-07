# Third-party notices

Streamr's original code is covered by the root [MIT license](LICENSE). Third-party code and its modifications retain the applicable upstream terms below; the root license does not replace those terms.

## Modified packages

The patches in `patches/` contain changes to the following packages. The accompanying license files are verbatim copies from the exact npm versions pinned in `package-lock.json`.

| Package | Upstream terms | Local changes |
| --- | --- | --- |
| [`fflate` 0.8.3](https://github.com/101arrowz/fflate) | [MIT; Copyright (c) 2026 Arjun Barrett](LICENSES/fflate.txt) | Exposes ZIP local-header flags, encryption and data-descriptor indicators, and CRC metadata to the streaming adapter. |
| [`fzstd` 0.1.1](https://github.com/101arrowz/fzstd) | [MIT; Copyright (c) 2020 Arjun Barrett](LICENSES/fzstd.txt) | Caps declared Zstandard windows at **16 MiB** and verifies frame checksums with a streaming XXH64 implementation, including checksums split across input chunks. |
| [`@modelcontextprotocol/server` 2.0.0](https://github.com/modelcontextprotocol/typescript-sdk) | [Upstream Apache-2.0/MIT transition notice and license texts](LICENSES/modelcontextprotocol-server.txt) | Carries `securitySchemes` through tool registration, updates, and tool-list responses, including the TypeScript declarations. |

The MCP package's `package.json` declares `MIT`, but its actual `LICENSE` explains an ongoing transition: new code and contributions with relicensing consent use Apache-2.0; existing contributions without that consent remain MIT. The complete upstream file is preserved rather than treating the package as MIT-only or offering a choice of licenses. Its CC-BY-4.0 statement concerns upstream documentation; no upstream documentation is reproduced in Streamr's README.

## Vendored XZ module and adapted code

`src/vendor/xz-decompress.wasm` is an unmodified 12,558-byte module extracted from the npm distribution of [`xz-decompress` 0.2.3](https://github.com/httptoolkit/xz-decompress/tree/v0.2.3). `npm run generate:xz-wasm` reproduces that extraction; it does not compile the native sources. The file's SHA-256 is `eb37d130fd379597765e87a044b243fb6ac6d0870ea468374003b9d4c2bee0e4`.

The streaming context in `src/archive/xz.ts` is adapted from that package's [`src/xz-decompress.js`](https://github.com/httptoolkit/xz-decompress/blob/v0.2.3/src/xz-decompress.js) for Cloudflare Workers and Streamr's stream lifecycle and limits. The package declares MIT and credits Tim Perry and Steven Sanderson. Its npm distribution and tagged source omit a standalone license text and copyright notice; the [preserved metadata and MIT reference text](LICENSES/xz-decompress.md) explain this limitation. The reference text is labeled separately from verbatim upstream notices, and no upstream copyright year has been invented.

The module also incorporates these dependencies, pinned by the upstream v0.2.3 git submodules:

| Component | Upstream revision | Terms preserved here |
| --- | --- | --- |
| [`xz-embedded`](https://github.com/tukaani-project/xz-embedded/tree/6f0e0c41e3682254c2e0be245f275f77df821ffe) | `6f0e0c41e3682254c2e0be245f275f77df821ffe` | [Public-domain dedication and warranty notice; Lasse Collin and Igor Pavlov](LICENSES/xz-embedded.txt) |
| [`walloc`](https://github.com/wingo/walloc/tree/a93409f5ebd49c875514c5fee30d3b151f7b0882) | `a93409f5ebd49c875514c5fee30d3b151f7b0882` | [MIT-style license; Copyright (c) 2020 Igalia, S.L.](LICENSES/walloc.md) |

The upstream native `memcpy` helper also matches OS/161's implementation, with comments and optional single-statement loop braces changed. Its source provenance and the [original Harvard BSD-3-Clause notice](LICENSES/os161-memcpy.txt) are recorded in [the XZ provenance document](LICENSES/xz-decompress.md#native-memcpy-provenance).

## Image WASM codecs and adapted bindings

The `image` transform bundles memory-capped JPEG/PNG WASM binaries from the following locked npm distributions. Their package-level Apache-2.0 license files are identical and are preserved in [the jSquash license](LICENSES/jsquash.txt); native codec terms remain applicable as well.

| Package | Package and codec terms |
| --- | --- |
| [`@jsquash/jpeg` 1.6.0](https://github.com/jamsinclair/jSquash/tree/1f62015f53e28bd18b2d7c8a3ca3326577efc445/packages/jpeg) | Apache-2.0 wrapper; [upstream libjpeg-turbo IJG/BSD/zlib licensing roll-up](LICENSES/jsquash-jpeg-codec.md) and [IJG README](LICENSES/README.ijg) |
| [`@jsquash/png` 3.1.1](https://github.com/jamsinclair/jSquash/tree/b7fa9ac9ec02f224847ad23d19d115f9e296a368/packages/png) | Apache-2.0 Squoosh wrapper; [provided Google BSD-3-Clause codec notice](LICENSES/jsquash-png-codec.txt) and [Rust dependency MIT/Unicode notices](LICENSES/jsquash-png-rust.txt) |

This software is based in part on the work of the Independent JPEG Group.

`scripts/prepare-image-wasm.mjs` validates each JPEG/PNG upstream binary's SHA-256 and changes only its memory declaration to enforce a 32 MiB maximum per instance. The checked-in JPEG/PNG files under `src/vendor/image/` are modified binaries. The PNG per-operation adapter in `src/transforms/image-codecs.ts` is adapted from upstream Apache-2.0 wasm-bindgen glue.

WebP is compiled from official [libwebp 1.6.0](https://github.com/webmproject/libwebp/tree/v1.6.0) source with Emscripten 4.0.17, using Streamr's original MIT-licensed C bridge. Its [BSD-3-Clause license](LICENSES/libwebp.txt) and [patent grant](LICENSES/libwebp-patents.txt) are retained. The native build also retains [Emscripten's MIT/NCSA notice](LICENSES/emscripten.txt), [emmalloc's additional 2018 copyright notice](LICENSES/emmalloc.txt), [musl's copyright notice](LICENSES/musl.txt), and [compiler-rt's Apache-2.0 with LLVM exceptions and legacy license texts](LICENSES/compiler-rt.txt). No npm WebP wrapper is included.

[Image codec provenance](LICENSES/image-codecs.md) records original JPEG/PNG file hashes, pinned upstream revisions, the native WebP build/rebuild process, runtime notices, and the PNG npm notice's licensing inconsistency without silently replacing its terms. Ordinary dependency installation regenerates JPEG/PNG modules and verifies the separately built WebP artifacts.

## Other archive dependencies

These packages are installed from npm, not vendored as source files. Their license texts are included for reference and retention when distributing a built Worker bundle:

- [`modern-tar` 0.8.4](https://github.com/ayuhito/modern-tar): [MIT; Copyright (c) 2025 Ayuhito](LICENSES/modern-tar.txt).
- [`@openpgp/unbzip2-stream` 2.0.0](https://github.com/openpgpjs/unbzip2-stream): [MIT; Jan Boelsche, with the original antimatter15 and Rob Landley notices](LICENSES/openpgp-unbzip2-stream.txt).

`package-lock.json` pins the remaining npm dependencies. Their own license and notice files remain authoritative; anyone redistributing a bundled artifact should retain the notices for every dependency included in that artifact.
