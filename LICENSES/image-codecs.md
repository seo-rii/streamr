# Image codec provenance

The image operator runs in the Worker using static modules under
`src/vendor/image/`. Streamr's original image pipeline and resizing code use
the root MIT license. The bundled codecs and adapted bindings retain their
upstream terms.

## Pinned distributions and notices

The following npm versions are pinned in `package-lock.json`. Their two
package-level `LICENSE` files are identical; [jsquash.txt](jsquash.txt) preserves
the full Apache-2.0 text and upstream `Copyright [2023] jamsinclair` notice.
The codec notices are copied from each distribution's `codec/LICENSE.codec.md`;
the JPEG notice's final newline is normalized without changing its text.

| Package | npm source revision (`gitHead`) | Codec notices |
| --- | --- | --- |
| `@jsquash/jpeg` 1.6.0 | [`1f62015f53e28bd18b2d7c8a3ca3326577efc445`](https://github.com/jamsinclair/jSquash/tree/1f62015f53e28bd18b2d7c8a3ca3326577efc445/packages/jpeg) | [libjpeg-turbo/IJG/BSD/zlib notice](jsquash-jpeg-codec.md) and [IJG README](README.ijg) |
| `@jsquash/png` 3.1.1 | [`b7fa9ac9ec02f224847ad23d19d115f9e296a368`](https://github.com/jamsinclair/jSquash/tree/b7fa9ac9ec02f224847ad23d19d115f9e296a368/packages/png) | [Upstream Google BSD-3-Clause codec notice](jsquash-png-codec.txt) and [Rust dependency notices](jsquash-png-rust.txt) |

This software is based in part on the work of the Independent JPEG Group.

The JPEG package's [build recipe](https://github.com/jamsinclair/jSquash/blob/1f62015f53e28bd18b2d7c8a3ca3326577efc445/packages/jpeg/codec/Makefile)
references MozJPEG v3.3.1. `README.ijg` is preserved from that tag's
[original file](https://github.com/mozilla/mozjpeg/blob/v3.3.1/README.ijg), including
its copyright and warranty terms. The npm package itself supplies the
libjpeg-turbo licensing roll-up reproduced in `jsquash-jpeg-codec.md`.

The PNG package's `codec/README.md` and `codec/pkg/README.md` declare its Squoosh
wrapper Apache-2.0, while its provided `codec/LICENSE.codec.md` is a Google
BSD-3-Clause text. Both notices are retained; the entire PNG module is not
relabeled as BSD-only. Its [pinned Cargo.lock](https://github.com/jamsinclair/jSquash/blob/b7fa9ac9ec02f224847ad23d19d115f9e296a368/packages/png/codec/Cargo.lock)
also records `png` 0.17.10, `rgb` 0.8.37, and their Rust dependencies. The
accompanying Rust notice file preserves the MIT alternatives from the exact
checksum-verified crate archives and Unicode's additional data license,
including build-time dependencies. These source revisions describe upstream
build provenance; Streamr does not independently rebuild the JPEG or PNG
native codecs.

## Native WebP build

WebP uses [libwebp 1.6.0](https://github.com/webmproject/libwebp/tree/v1.6.0),
compiled from the [official release archive](https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz)
with Emscripten 4.0.17. The codec's [BSD-3-Clause COPYING text](libwebp.txt) and
[additional patent grant](libwebp-patents.txt) are preserved from that release.
No npm WebP codec wrapper or generated Emscripten JavaScript glue is bundled.
`src/native/image-webp.c` is Streamr's original MIT-licensed C bridge.

The v1.6.0 tag resolves to source commit
[`4fa21912338357f89e4fd51cf2368325b59e9bd9`](https://github.com/webmproject/libwebp/commit/4fa21912338357f89e4fd51cf2368325b59e9bd9).
The official source archive SHA-256 is
`e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564`.
The Linux x64 Emscripten release archive is pinned to release
`41d2106c68c28e101e6252a48e22c78b07722508`, with SHA-256
`5e4269ab4d4dd97da93f2833bb97780ef6ddee9a7325d345587bddf8890d89aa`.

`src/vendor/image/webp-build.json` records the source archive, source and build
inputs, toolchain identity, and resulting WASM hashes. The build uses
`-O3`, standalone WebAssembly without an entry point, memory growth with a
32 MiB maximum and 8 MiB initial memory, a 64 KiB stack, and the `emmalloc`
allocator. SIMD, threads, and filesystem support are disabled. Mux/demux and
command-line/image format utilities are not linked. The native version export identifies libwebp
1.6.0; version, memory layout, and hashes are checked during artifact verification.

The encoder uses lossy RGB with the requested quality and stores decoded alpha
values exactly as an uncompressed `ALPH` plane (`alpha_compression=0`,
`alpha_filtering=0`, `alpha_quality=100`). This avoids the additional lossless
alpha encoder state at the image pixel ceiling. Transparent outputs can be
larger than outputs with compressed alpha; opaque encoding is unaffected.
This alpha policy is fixed, not a caller-selectable transform option.

The native modules can include Emscripten and its C/runtime support. Their
upstream notices are retained as [Emscripten's MIT/NCSA license](emscripten.txt),
[emmalloc's additional 2018 copyright notice](emmalloc.txt),
[musl's copyright and permissive terms](musl.txt), and
[compiler-rt's Apache-2.0 with LLVM exceptions and legacy license texts](compiler-rt.txt),
copied from Emscripten 4.0.17. Trailing whitespace and final blank lines in
the copied notices are normalized without changing their terms or attributions.
The LLVM text includes its exception for compiled
portions embedded into an object's code. These retained runtime notices do not
relicense libwebp or Streamr's original bridge.

To rebuild on Linux x64, install Node.js 24+, Python 3, CMake, Ninja, and tar
with gzip/xz support, then run:

```sh
node scripts/build-webp-wasm.mjs
```

The script downloads SHA-256-pinned libwebp source and the Emscripten 4.0.17
toolchain into its own temporary directory, builds and validates both modules,
writes the artifacts and manifest, and removes its scratch directory.
`STREAMR_WEBP_SOURCE_ARCHIVE` and `STREAMR_WEBP_TOOLCHAIN_ARCHIVE` can point to
local release archives; their hashes are checked identically. Ordinary
`npm ci` does not download a native compiler or rebuild WebP; it verifies the
checked-in native modules and their recorded build inputs instead.

## Streamr modifications

For JPEG and PNG, `scripts/prepare-image-wasm.mjs` verifies the SHA-256 of every input binary,
rewrites only its declared memory maximum to 512 WebAssembly pages (32 MiB),
validates the resulting module, and verifies that applying the cap again is
idempotent. The code and data sections are unchanged. The JPEG and PNG
generated modules are therefore **modified upstream binaries**, not byte-identical
copies of the npm files. `npm run generate:image-wasm` reproducibly performs
this step and verifies the separately built WebP artifacts; installation
invokes it automatically.

| Generated module | Original npm file | Original SHA-256 |
| --- | --- | --- |
| `jpeg-dec.wasm` | `@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm` | `a7c4b12169817e779ff4af137981393ae924944e167ad1bd95747c9199162d3e` |
| `jpeg-enc.wasm` | `@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm` | `24d4177f1c4963e2058b107189249651c61fdef125570e79b1dfb63c8bb49326` |
| `png.wasm` | `@jsquash/png/codec/pkg/squoosh_png_bg.wasm` | `263d6e658808a74b72a1a99c5cc1d619237e70c150db6e41d5d84d3d117ab9be` |

The PNG adapter in `src/transforms/image-codecs.ts` is adapted from jSquash's
Apache-2.0 wasm-bindgen bindings. It creates a fresh instance and object table
per decode/encode operation instead of retaining the generated glue's global
instance. The JPEG adapter instantiates its low-level factories with static,
memory-capped modules; the WebP adapter calls the native C bridge directly.
No image payload or codec instance is
cached between requests, and codec linear memory is cleared after use.

Redistributors of a built Worker should retain this provenance document and
the linked upstream notices along with the root license.
