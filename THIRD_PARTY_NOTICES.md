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

## Other archive dependencies

These packages are installed from npm, not vendored as source files. Their license texts are included for reference and retention when distributing a built Worker bundle:

- [`modern-tar` 0.8.4](https://github.com/ayuhito/modern-tar): [MIT; Copyright (c) 2025 Ayuhito](LICENSES/modern-tar.txt).
- [`@openpgp/unbzip2-stream` 2.0.0](https://github.com/openpgpjs/unbzip2-stream): [MIT; Jan Boelsche, with the original antimatter15 and Rob Landley notices](LICENSES/openpgp-unbzip2-stream.txt).

`package-lock.json` pins the remaining npm dependencies. Their own license and notice files remain authoritative; anyone redistributing a bundled artifact should retain the notices for every dependency included in that artifact.
