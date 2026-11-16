# Third-party code shipped to the browser

Every file is vendored, pinned and served from our own origin (no CDN). Files are byte-identical to the
upstream npm artefact (the one exception is the CodeMirror bundle, which is built from pinned upstream
tarballs, see its section); the SHA-256 below is checked by `tests/test_vendor_hashes.py` and the file is also
listed (SHA-256 + SRI) in `client-manifest.json` by `scripts/build-client-manifest.py`. Updates only via a
deliberate PR with the upstream changelog and new hashes. See `docs/design/rich-editor.md` section 4.2.

| Library | Version | License (SPDX) | Purpose |
|---|---|---|---|
| markdown-it | 14.1.0 | MIT | Markdown parser for the note view (`html: false`) |
| DOMPurify | 3.2.6 | Apache-2.0 (dual MPL-2.0 OR Apache-2.0; used under Apache-2.0) | Allowlist HTML sanitizer, last step before the note view enters the DOM |
| highlight.js | 11.11.1 | BSD-3-Clause | Syntax colouring of fenced code blocks in the note view (the official "common" bundle: 36 languages; output still goes through DOMPurify) |
| CodeMirror 6 | state 6.5.2, view 6.36.8, commands 6.8.1, language 6.11.0 | MIT | Editor core of the formatted Markdown editing mode (`js/rich-editor.js`); the note text stays the Markdown string |
| Mermaid | 11.4.1 | MIT | Diagrams from ```` ```mermaid ```` blocks; runs only inside a sandboxed iframe (`/static/mermaid-sandbox.html`), never in the app page |

## markdown-it 14.1.0

- Source: https://registry.npmjs.org/markdown-it/-/markdown-it-14.1.0.tgz (git commit `0fe7ccb4b7f30236fb05f623be6924961d296d3d`, https://github.com/markdown-it/markdown-it)
- Tarball sha256: `7c4fab4d4d39fe98206a7fbbed4b1e3578f2b70b6b69d309413e33eec140e19f` (npm `integrity` verified)
- Last checked: 2026-11-14

| File | Upstream path | sha256 |
|---|---|---|
| `app/static/js/vendor/markdown-it/markdown-it.min.js` | `package/dist/markdown-it.min.js` | `38c70a1e7ca91ab40e2d9e6e60129851a717ed1c7d4acbbdd41bf9503791cf68` |
| `app/static/js/vendor/markdown-it/LICENSE` | `package/LICENSE` | `792c48c5a849a15fdf9e37e8bcf9e6d1dd13b32b46c642a748a0a46a9919d473` |

## DOMPurify 3.2.6

- Source: https://registry.npmjs.org/dompurify/-/dompurify-3.2.6.tgz (git commit `0f7ce144b2dd12295366b3e677da7d64bff2b60d`, https://github.com/cure53/DOMPurify)
- Tarball sha256: `fe734a97f5938a5ff7f99aedf348c53b8d47c897859fcc57ac4feaa70582c0b6` (npm `integrity` verified)
- Last checked: 2026-11-14

| File | Upstream path | sha256 |
|---|---|---|
| `app/static/js/vendor/dompurify/purify.min.js` | `package/dist/purify.min.js` | `89e1fa7647cb495370d3a997ace4387f5d15d9f4c5af12352c53daa400956287` |
| `app/static/js/vendor/dompurify/LICENSE` | `package/LICENSE` | `1b02e03c3fb4f87d476c128f0eb9def1f5a1709d28b180465228bd41574623b7` |

## highlight.js 11.11.1

- Source: https://registry.npmjs.org/@highlightjs/cdn-assets/-/cdn-assets-11.11.1.tgz (npm package `@highlightjs/cdn-assets`, the official prebuilt browser bundle; https://github.com/highlightjs/highlight.js, git `08cb242e7d`)
- Tarball sha256: `28a06bf6ebcc2218c6e842bdb4f1c8353508a8cada59e85110f91892f5726195` (npm `integrity` verified)
- Last checked: 2026-11-16
- Languages in the bundle: bash, c, cpp, csharp, css, diff, go, graphql, ini, java, javascript, json, kotlin, less, lua, makefile, markdown, objectivec, perl, php, php-template, plaintext, python, python-repl, r, ruby, rust, scss, shell, sql, swift, typescript, vbnet, wasm, xml, yaml (plus their aliases such as `js`, `ts`, `py`, `html`, `sh`).

| File | Upstream path | sha256 |
|---|---|---|
| `app/static/js/vendor/highlightjs/highlight.min.js` | `package/highlight.min.js` | `c4a399dd6f488bc97a3546e3476747b3e714c99c57b9473154c6fb8d259b9381` |
| `app/static/js/vendor/highlightjs/LICENSE` | `package/LICENSE` | `6c081431591d9df696c82dc598fe1423765b8a299b200ed00b281afd0f64c490` |

## Mermaid 11.4.1

- Source: https://registry.npmjs.org/mermaid/-/mermaid-11.4.1.tgz (https://github.com/mermaid-js/mermaid)
- Tarball sha256: `ec7b61b391aaa24bf666fd20e48d0a626eeb4a95b95bc6b3016a122d7f0bc2af` (npm `integrity` verified)
- Last checked: 2026-11-16
- Loaded only by `app/static/mermaid-sandbox.html`, which is shown in an `<iframe sandbox="allow-scripts">` (no `allow-same-origin`) and only when a note contains a `mermaid` block.

| File | Upstream path | sha256 |
|---|---|---|
| `app/static/js/vendor/mermaid/mermaid.min.js` | `package/dist/mermaid.min.js` | `a43bc1afd446f9c4cc66ac5dd45d02e8d65e26fc5344ec0ef787f88d6ddb6f9e` |
| `app/static/js/vendor/mermaid/LICENSE` | `package/LICENSE` | `ec9fb67dcb25eccc416ed56e1aab819222c805a2a4bfe4cb19e7556bf2ffde80` |

## Reproducing

Download the tarball above, check its sha256 against this file, and extract the listed upstream paths
unchanged. None of these files uses `eval` or `new Function`, so the app CSP stays without `'unsafe-eval'` and
without `'unsafe-inline'` in `script-src`.

Older vendored libraries (noble, pdf.js, jsPDF, tesseract, jsQR, heic2any, qrcode-generator) predate this
file and are not yet listed here.

## CodeMirror 6 (formatted Markdown editor)

- Not byte-identical to one upstream file: CodeMirror ships as many ESM packages, so `codemirror.min.js` is a
  single IIFE bundle (global `DGCodeMirror`) that esbuild 0.25.5 builds from the pinned npm tarballs listed below,
  with the entry point `scripts/vendor/codemirror/entry.js`. Rebuild: `python3 scripts/vendor/codemirror/build.py <folder with the tarballs>`
  (verifies every tarball against `scripts/vendor/codemirror/SHA256SUMS`, runs no package script, no npm). The
  output is identical on every run. It contains no `eval` / `new Function` (checked in `tests/test_vendor_hashes.py`),
  so the CSP keeps no `unsafe-eval` for scripts. The editor runs from our own origin only.
- Source of the packages: https://registry.npmjs.org/ (tarball sha256 in `scripts/vendor/codemirror/SHA256SUMS`; npm `integrity` verified when fetched):
  @codemirror/state 6.5.2, @codemirror/view 6.36.8, @codemirror/commands 6.8.1, @codemirror/language 6.11.0 (https://github.com/codemirror),
  @lezer/common 1.2.3, @lezer/highlight 1.2.1, @lezer/lr 1.4.2 (https://github.com/lezer-parser), style-mod 4.1.2, w3c-keyname 2.2.8, crelt 1.0.6, @marijn/find-cluster-break 1.0.2.
  Build tool only (not shipped): esbuild 0.25.5 and @esbuild/linux-x64 0.25.5 (MIT).
- Licences: all MIT; the notices are collected in `app/static/js/vendor/codemirror/LICENSE`.
- Last checked: 2026-11-16

| File | Upstream path | sha256 |
|---|---|---|
| `app/static/js/vendor/codemirror/codemirror.min.js` | build output of `scripts/vendor/codemirror/build.py` | `cde3e4d905ece6ccd5262097befb1b6d5be32544200c13f64351cc54408e5c36` |
| `app/static/js/vendor/codemirror/LICENSE` | combined notices of the packages above | `a174ec9acc631033bf25cb5a1267679029d64f884dd1205ae1a25b2580235040` |
