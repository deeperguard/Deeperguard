const assert = require('assert');
const { escapeAttr, safeColor, clearUnchangedDirty, safeRichHref, safeRichImageSrc, sanitizeRichHtml } = require('../app/static/js/sanitize.js');

assert.strictEqual(safeColor('#4f8cff'), '#4f8cff');
assert.strictEqual(safeColor('#fff'), '#fff');
assert.strictEqual(safeColor('red; } body { background: url(http://evil)'), '#4f8cff');
assert.strictEqual(safeColor('#4f8cff" onclick="alert(1)', ''), '');
assert.strictEqual(escapeAttr('x" onclick="alert(1)'), 'x&quot; onclick=&quot;alert(1)');

const dirty = new Set(['a', 'b']);
clearUnchangedDirty(
  dirty,
  new Map([
    ['a', 1],
    ['b', 1],
  ]),
  (uuid) => (uuid === 'b' ? 2 : 1),
);
assert.deepStrictEqual([...dirty], ['b']);

// Rich view URL allowlist: external links yes, script-capable schemes no.
assert.strictEqual(safeRichHref('mailto:a@b.nl'), 'mailto:a@b.nl');
assert.strictEqual(safeRichHref('JaVaScRiPt:alert(1)'), '');
assert.strictEqual(safeRichHref('https://x.nl/%0Ajavascript:1'), '');
assert.strictEqual(safeRichHref('https://x.nl/a b'), '');
assert.strictEqual(safeRichHref('https://x.nl/"'), '');
assert.strictEqual(safeRichImageSrc('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
assert.strictEqual(safeRichImageSrc('data:image/svg+xml,<svg/>'), '');
assert.strictEqual(safeRichImageSrc('javascript:alert(1)'), '');
// No DOM in node: the sanitizer reports that instead of returning unsanitized HTML.
assert.strictEqual(sanitizeRichHtml('<script>1</script>'), null);

console.log('ok');
