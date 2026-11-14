// Every vector from docs/design/rich-editor-tests.md (#1-#32), as Markdown note bodies.
// Shared by tests/test_rich_xss_vectors.js (node) and tests/test_rich_xss_vectors_browser.py
// (real Chromium DOM). New bypasses get the next number here first (see "Regressie").
const fence = '```';

const RENDER_VECTORS = [
  { id: 1, md: '<script>window.__xss=1</script>', text: '<script>window.__xss=1</script>' },
  { id: 2, md: 'Hallo <script>alert(1)</script> wereld', text: 'Hallo <script>alert(1)</script> wereld' },
  { id: 3, md: '<img src=x onerror="window.__xss=1">', text: '<img src=x onerror="window.__xss=1">' },
  { id: 4, md: '![a"onerror="window.__xss=1](x)' },
  { id: 4.1, md: '![x](x" onerror="window.__xss=1)' },
  { id: 5, md: '[klik](javascript:window.__xss=1)' },
  { id: 6, md: '[a](JaVa&#x09;Script:alert(1))' },
  { id: 6.1, md: '[a](&#106;avascript:alert(1))' },
  { id: 6.2, md: '[a](java\nscript:alert(1))' },
  { id: 6.3, md: '[a](  javascript:alert(1))' },
  { id: 6.4, md: '[a](<javascript:alert(1)>)' },
  { id: 7, md: '[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)' },
  { id: 7.1, md: '[a](vbscript:msgbox(1))' },
  { id: 8, md: '<svg onload="window.__xss=1"></svg>', text: '<svg onload="window.__xss=1"></svg>' },
  { id: 8.1, md: '<svg><script>window.__xss=1</script></svg>', text: '<svg><script>window.__xss=1</script></svg>' },
  { id: 9, md: '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=)' },
  { id: 10, md: '<div onclick="window.__xss=1">klik</div>', text: '<div onclick="window.__xss=1">klik</div>' },
  { id: 10.1, md: '<iframe src="javascript:alert(1)"></iframe>', text: '<iframe src="javascript:alert(1)"></iframe>' },
  { id: 10.2, md: '<object data="x">', text: '<object data="x">' },
  { id: 10.3, md: '<form action="javascript:alert(1)"><button>x</button></form>', text: '<form action="javascript:alert(1)"><button>x</button></form>' },
  { id: 11, md: '**vet** <b onmouseover=alert(1)>x</b> <a href="javascript:alert(1)">y</a>', strong: 'vet', text: '<b onmouseover=alert(1)>x</b> <a href="javascript:alert(1)">y</a>' },
  { id: 12, md: '[a](https://x.nl/"onmouseover="window.__xss=1)' },
  { id: 12.1, md: '[a](https://x.nl/ "title" onfocus=alert(1))' },
  { id: 13, md: `${fence}mermaid\ngraph TD\nA-->B\nclick A call alert(1)\n${fence}`, text: 'click A call alert(1)' },
  { id: 14, md: `${fence}mermaid\ngraph TD\nA-->B\nclick A href "javascript:alert(1)"\n${fence}`, text: 'click A href "javascript:alert(1)"' },
  { id: 15, md: `${fence}mermaid\n%%{init: {"securityLevel":"loose","htmlLabels":true}}%%\ngraph TD\nA["<img src=x onerror=alert(1)>"]-->B\n${fence}`, text: 'A["<img src=x onerror=alert(1)>"]-->B' },
  // #16 (Mermaid iframe isolation): there is no Mermaid iframe yet, so the check is that a
  // diagram whose content reaches for parent/top/storage renders as inert source, no iframe.
  { id: 16, md: `${fence}mermaid\ngraph TD\nA["<script>parent.document.title=top.location=localStorage.k=indexedDB</script>"]\n${fence}`, text: 'parent.document.title' },
  { id: 17, md: `${fence}html\n<script>window.__xss=1</script>\n${fence}`, text: '<script>window.__xss=1</script>' },
  { id: 18, md: `${fence}js"onmouseover="window.__xss=1\nx\n${fence}` },
  { id: 18.1, md: `${fence}<img src=x onerror=alert(1)>\nx\n${fence}` },
  { id: 19, md: '| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |', table: 2, text: '<img src=x onerror=alert(1)>' },
  { id: 20, md: '| a |\n|:--" onclick="alert(1)|\n| x |' },
  { id: 21, md: '<noscript><p title="</noscript><img src=x onerror=alert(1)>">', text: '<img src=x onerror=alert(1)>' },
  { id: 21.1, md: '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">' },
  { id: 21.2, md: '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">', text: '<img src=1 onerror=alert(1)>' },
  { id: 26, md: '![t](https://tracker.example/pixel.gif)' },
  { id: 27, md: '<javascript:alert(1)>', text: '<javascript:alert(1)>' },
  { id: 27.1, md: 'https://x.nl/"><script>alert(1)</script>', text: '<script>alert(1)</script>' },
  { id: 28, md: '[a][1]\n\n[1]: javascript:alert(1)' },
  { id: 29, md: '<img src=x onerror=alert(1)><script>window.__xss=1</script><b style="x:expression(alert(1))">x</b>', text: '<b style="x:expression(alert(1))">x</b>' },
  { id: 30, md: '---\nx: <script>alert(1)</script>\n---', text: '<script>alert(1)</script>' },
  { id: 30.1, md: '$$ <img src=x onerror=alert(1)> $$', text: '$$ <img src=x onerror=alert(1)> $$' },
  { id: 31, md: '[a](java​script:alert(1))' },
  { id: 31.1, md: '[a](javascript :alert(1))' },
  { id: 31.2, md: '[‮evil](https://x.nl/‮)' },
  { id: 32, md: '>'.repeat(10000) + ' diep', dos: true },
  { id: 32.1, md: '- '.repeat(5000) + 'x', dos: true },
  { id: 32.2, md: '*'.repeat(1024 * 1024), dos: true },
];

// #22-#25 are search UI paths (term, fragment, OCR text, title/attachment name).
const SEARCH_VECTORS = [
  { id: 22, text: 'zoek <img src=x onerror=alert(1)> hier', query: '<img src=x onerror=alert(1)>' },
  { id: 22.1, text: 'a "><script>alert(1)</script> b', query: '"><script>alert(1)</script>' },
  { id: 23, text: 'Notitie met <img src=x onerror=alert(1)> erin', query: 'onerror' },
  { id: 24, text: '<script>window.__xss=1</script> factuur', query: 'factuur' },
  { id: 25, text: '<img src=x onerror=alert(1)>', query: 'img' },
  { id: 25.1, text: '"><svg onload=alert(1)>.png', query: 'png' },
];

const ALLOWED_HREF = /^(?:https?:\/\/|mailto:|#)/i;
const ALLOWED_SRC = /^(?:blob:|data:image\/(?:png|jpeg|gif|webp)[;,])/i;
const DANGEROUS_SELECTOR = 'script, iframe, object, embed, link, meta, base, form, style, svg, math, noscript, frame, frameset';

module.exports = {
  RENDER_VECTORS, SEARCH_VECTORS, ALLOWED_HREF, ALLOWED_SRC, DANGEROUS_SELECTOR,
};
