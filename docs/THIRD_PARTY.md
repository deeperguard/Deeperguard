# Third-party code shipped to the browser

Every file is vendored, pinned and served from our own origin (no CDN). Files are byte-identical to the
upstream npm artefact; the SHA-256 below is checked by `tests/test_vendor_hashes.py` and the file is also
listed (SHA-256 + SRI) in `client-manifest.json` by `scripts/build-client-manifest.py`. Updates only via a
deliberate PR with the upstream changelog and new hashes. See `docs/design/rich-editor.md` section 4.2.

| Library | Version | License (SPDX) | Purpose |
|---|---|---|---|
| markdown-it | 14.1.0 | MIT | Markdown parser for the note view (`html: false`) |
| DOMPurify | 3.2.6 | Apache-2.0 (dual MPL-2.0 OR Apache-2.0; used under Apache-2.0) | Allowlist HTML sanitizer, last step before the note view enters the DOM |

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

## Reproducing

Download the tarball above, check its sha256 against this file, and extract the listed upstream paths
unchanged. Neither file uses `eval` or `new Function`, so the app CSP stays without `'unsafe-eval'` and
without `'unsafe-inline'` in `script-src`.

Older vendored libraries (noble, pdf.js, jsPDF, tesseract, jsQR, heic2any, qrcode-generator) predate this
file and are not yet listed here.
