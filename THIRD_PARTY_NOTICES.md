# Third-party notices

Streamr uses the following MIT-licensed packages in its bounded streaming archive pipeline:

- `fflate` 0.8.3, with a local patch that exposes ZIP local-header flags and CRC metadata to the streaming adapter.
- `modern-tar` 0.8.4.
- `@openpgp/unbzip2-stream` 2.0.0.
- `fzstd` 0.1.1, with a local patch that caps declared Zstandard windows at 32 MiB.
- `xz-decompress` 0.2.3.

The checked-in `src/vendor/xz-decompress.wasm` module is reproducibly extracted from the `xz-decompress` package by `npm run generate:xz-wasm`. The surrounding TypeScript adapter is based on that package's MIT-licensed streaming context. The module incorporates `xz-embedded` by Lasse Collin and Igor Pavlov (public domain) and `walloc` by Igalia, S.L. (MIT), as documented by `xz-decompress`.

The complete license texts for installed packages remain available in their package distributions and lockfile-resolved sources.
