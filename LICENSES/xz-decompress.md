# xz-decompress 0.2.3: license metadata and provenance

Streamr contains the package's unmodified WebAssembly module and an adapted version of its JavaScript streaming context. The root Streamr license does not replace the upstream package's terms.

The published package metadata identifies:

- Package: `xz-decompress`, version `0.2.3`.
- License declaration: `MIT`.
- Author: Tim Perry.
- Contributors: Tim Perry and Steven Sanderson.
- Source: <https://github.com/httptoolkit/xz-decompress/tree/v0.2.3>.
- Package: <https://registry.npmjs.org/xz-decompress/-/xz-decompress-0.2.3.tgz>.
- Original project credited in the upstream README: <https://github.com/SteveSanderson/xzwasm>.

Neither the npm distribution nor the upstream `v0.2.3` source tree includes a standalone license text or an upstream copyright notice for the package's own code. This document records the existing MIT declaration and verified author/contributor metadata without inventing a copyright year or claiming to reproduce an absent upstream notice.

## MIT permission and warranty text

The following is the standard permission and warranty text for the package's declared [SPDX MIT license](https://spdx.org/licenses/MIT.html). It is supplied as a reference reconstruction of that declaration, **not** as a verbatim license file provided by `xz-decompress`. No upstream copyright line was supplied; the verified authors and contributors are recorded above.

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Native dependencies

The bundled native module includes `xz-embedded` and `walloc`. Their exact upstream license texts are preserved separately in [xz-embedded.txt](xz-embedded.txt) and [walloc.md](walloc.md).

## Native memcpy provenance

The [upstream native helper source](https://github.com/httptoolkit/xz-decompress/blob/v0.2.3/src/native/memcmp.c) attributes its `memcpy` implementation to [this Stack Overflow question](https://stackoverflow.com/questions/17591624). The code in that question matches [OS/161's `common/libc/string/memcpy.c`](https://github.com/ops-class/os161/blob/cafa9f5690fefe60355213bc8bcd521cab14213a/common/libc/string/memcpy.c). The function in `xz-decompress` matches that source except for comments, whitespace, and omitted braces around single-statement loop bodies.

The original OS/161 source carries a BSD-3-Clause notice with `Copyright (c) 2000, 2001, 2002, 2003, 2004, 2005, 2008, 2009 The President and Fellows of Harvard College.` Its full [copyright, conditions, and disclaimer](os161-memcpy.txt) are preserved here for the code incorporated into the native module. This attribution follows the original permissively licensed code; no Stack Overflow question or answer prose is reproduced in Streamr.
