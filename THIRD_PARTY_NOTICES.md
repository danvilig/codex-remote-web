# Third-party notices

## Lucide

The interface icons in `public/codex-icons.js` use the exact Lucide icon path data bundled with the locally installed Codex.app (`lucide-react` 0.456.0).

ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Source verification: the Lucide 0.456.0 upstream ISC license and the corresponding third-party notice in Codex.app.

## QR code generation

The interface uses `qrcode-generator` (MIT) to generate temporary-address QR codes locally. Its package license and dependency metadata are included in generated release notices. No external QR service is used.

## Code editor and language highlighting

CodeMirror 6 and its Lezer language parsers (MIT) provide local file editing and syntax highlighting. Their installed package license notices and dependency metadata are included in the release inventory. The editor is bundled locally and does not send source files to an external editor service.

## Upstream source

Based on lezi-fun/codex-webui, commit 332b14d2600a7e14332fae7b6032b973c8e5b198, under the MIT license. The original copyright and license are retained in LICENSE. Public source is a current-code snapshot with upstream and development provenance in SOURCE_PROVENANCE.json; the complete development history is retained locally.

## Project-owned visual resources

The current public/codex-brand.js and public/favicon.svg terminal/window mark, workspace icons, and CSS activity pulse are original project resources distributed under the project MIT license. Codex.app-extracted PNGs, wordmark paths and Lottie animations from earlier commits are no longer shipped. Those earlier commits are retained only in the local development repository and are not included in the public snapshot. The snapshot does not assert ownership of those historical third-party resources.

Lucide's upstream source is https://github.com/lucide-icons/lucide/tree/0.456.0 and its ISC license is retained above. The Codex.app reference above describes the historical acquisition, not a development dependency.

Runtime dependencies remain subject to their package licenses. Release archives include a generated inventory and the installed runtime package license notices.

## Portable executable runtimes

Linux executable packages embed Bun 1.4.4 and include Node.js 24.22.2 for isolated terminal and connector workers, plus the target architecture's node-pty native module. Bun's upstream licensing and linked-library notices are retained in `runtime/BUN-LICENSE.md` (source copy: `docs/licenses/BUN.md`); Node's full distribution notices are retained in `runtime/NODE-LICENSE`. Package dependency notices remain in `third-party/`. Runtime versions and source links are recorded in `runtime/RUNTIMES.json`.

The original bundled application remains available as `dist/portable.js` for rebuilding with a modified Bun runtime; `runtime/REBUILD.md` describes rebuilding/relinking. Bun's JavaScriptCore/WebKit and other libraries retain their respective licenses, including LGPL terms; the project MIT license does not replace them. Runtime source: https://github.com/oven-sh/bun/tree/bun-v1.4.4 and https://github.com/nodejs/node/tree/v24.22.2.

DOMPurify 3.4.17 is distributed under the Apache-2.0 option of its dual license (MPL-2.0 OR Apache-2.0). Its license texts and applicable NOTICE files are retained in release dependency notices. KaTeX 0.18.2 is distributed under MIT. The project MIT license does not replace these dependency licenses.

OpenAI and Codex are trademarks of their respective owners. This independent project is not affiliated with or endorsed by OpenAI.
