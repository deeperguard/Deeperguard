// Inline document viewer controls: fit width default, zoom, page indicator, full screen.
const assert = require('assert');
const { install, Element } = require('./domstub.js');

const { document } = install();
Element.prototype.setAttribute = function setAttribute(k, v) { (this.attrs = this.attrs || {})[k] = String(v); };
Element.prototype.getAttribute = function getAttribute(k) { return (this.attrs || {})[k] ?? null; };
Element.prototype.insertBefore = function insertBefore(n, ref) {
  this.appendChild(n);
  this.children.splice(this.children.indexOf(n), 1);
  this.children.splice(Math.max(0, this.children.indexOf(ref)), 0, n);
  n.parentNode = this;
  return n;
};
Object.defineProperty(Element.prototype, 'style', {
  get() { return this._style || (this._style = { setProperty(k, v) { this[k] = v; } }); },
  set(v) { this._style = v; },
});
const click = (el) => (el.listeners.click || []).forEach((fn) => fn({}));
const fire = (target, type) => (target.listeners?.[type] || []).forEach((fn) => fn());
document.addEventListener = function addEventListener(type, fn) {
  (this.listeners = this.listeners || {})[type] = (this.listeners[type] || []).concat(fn);
};
document.removeEventListener = () => {};

const { attach, clampZoom, pageFromScroll } = require('../app/static/js/doc-inline-controls.js');

// Synthetic PDF fixture: 3 A4-like page wrappers inside a 900px container.
const CONTAINER_W = 900;
function fixture() {
  const scroller = new Element('div');
  scroller.layoutHeight = 600; scroller.layoutWidth = CONTAINER_W; scroller.clientHeight = 600;
  const card = new Element('div');
  card.className = 'doc-inline-card';
  card.layoutHeight = 600;
  const stage = new Element('div');
  stage.className = 'doc-inline-stage';
  for (let i = 0; i < 3; i += 1) {
    const w = new Element('div');
    w.className = 'doc-page-wrap';
    w.layoutTop = i * 1200; w.layoutHeight = 1100; w.layoutWidth = CONTAINER_W;
    stage.appendChild(w);
  }
  card.appendChild(stage);
  scroller.appendChild(card);
  return { scroller, card, stage };
}

assert.strictEqual(clampZoom(10), 3);
assert.strictEqual(clampZoom(0.1), 0.5);
assert.strictEqual(pageFromScroll([{ top: 0 }, { top: 1200 }, { top: 2400 }], { top: 0, height: 600 }), 1);
assert.strictEqual(pageFromScroll([{ top: -1100 }, { top: 100 }, { top: 1300 }], { top: 0, height: 600 }), 2);

const f = fixture();
document.fullscreenEnabled = true;
f.card.requestFullscreen = () => { document.fullscreenElement = f.card; return Promise.resolve(); };
document.exitFullscreen = () => { document.fullscreenElement = null; return Promise.resolve(); };
const ctl = attach({ card: f.card, stage: f.stage, scroller: f.scroller, doc: document });

// Default: fit to width, no page wider than the container, "1 / 3".
assert.strictEqual(ctl.getZoom(), 1);
assert.strictEqual(f.stage.style.width, '100%');
// Real CSS contract (the DOM stub has no layout): at zoom 1 the stage is 100% of
// the column, pages are 100% / max-width 100% of the stage, the stage is centred
// and the main area scrolls horizontally on a neutral token background.
const fs0 = require('fs');
const css = fs0.readFileSync(require('path').join(__dirname, '../app/static/css/app.css'), 'utf8');
function ruleBody(selector) {
  const out = [];
  const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
  let m;
  while ((m = re.exec(css))) out.push(m[2]);
  return out.join('\n');
}
const pageRule = ruleBody('.doc-inline-stage .doc-page-wrap,\n.doc-stage .doc-page-wrap');
assert.match(pageRule, /width:\s*100%/);
assert.match(pageRule, /max-width:\s*100%/);
const stageRule = ruleBody('.doc-inline-card .doc-inline-stage,\n.editor.doc-preview-active .doc-inline-card .doc-inline-stage:not(.is-loading)');
assert.match(stageRule, /margin-inline:\s*auto/);
const mainRule = ruleBody('.doc-inline-card .doc-inline-main,\n.editor.doc-preview-active .doc-inline-card .doc-inline-main');
assert.match(mainRule, /background:\s*var\(--doc-surface\)/);
assert.match(mainRule, /overflow-x:\s*auto/);
assert.ok(!/border-left:\s*[1-9]/.test(ruleBody('.doc-inline-card .doc-inline-stage .doc-page-wrap')));
assert.ok(/--doc-surface:\s*#/.test(css), 'neutral surface token exists');
// Default zoom must be 1 and the stage must not carry any other width.
assert.strictEqual(ctl.getZoom(), 1);
assert.notStrictEqual(f.stage.style.width, '');
assert.strictEqual(parseFloat(f.stage.style.width), 100);
const btns = ctl.bar.querySelectorAll('button');
assert.strictEqual(btns.length, 6); // zoom out/in, fit, previous, next, full screen
btns.forEach((b) => {
  assert.ok(b.title && b.getAttribute('aria-label') === b.title);
  assert.strictEqual(b.type, 'button');
});
const page = ctl.bar.querySelector('.doc-inline-page');
assert.strictEqual(page.textContent, '1 / 3');

// Zoom buttons and fit width.
click(ctl.bar.querySelector('.doc-ctl-zoom-in'));
assert.strictEqual(ctl.getZoom(), 1.25);
assert.strictEqual(f.stage.style.width, '125%');
click(ctl.bar.querySelector('.doc-ctl-zoom-out'));
click(ctl.bar.querySelector('.doc-ctl-zoom-out'));
assert.strictEqual(ctl.getZoom(), 0.8);
click(ctl.bar.querySelector('.doc-ctl-fit'));
assert.strictEqual(ctl.getZoom(), 1);
assert.strictEqual(f.stage.style.width, '100%');
for (let i = 0; i < 10; i += 1) click(ctl.bar.querySelector('.doc-ctl-zoom-in'));
assert.strictEqual(ctl.getZoom(), 3);
assert.ok(ctl.bar.querySelector('.doc-ctl-zoom-in').disabled);
click(ctl.bar.querySelector('.doc-ctl-fit'));

// Page indicator follows the scroll position.
f.scroller.scrollHeight = 3600;
f.scroller.scrollTop = 1250;
fire(f.scroller, 'scroll');
assert.strictEqual(page.textContent, '2 / 3');

// Page navigation: shown for 2+ pages, ends disabled, clamped jumps, hidden for one page.
const { clampPage } = require('../app/static/js/doc-inline-controls.js');
assert.deepStrictEqual([clampPage(0, 3), clampPage(2.4, 3), clampPage(9, 3), clampPage('x', 3)], [1, 2, 3, 1]);
const nav = ctl.bar.querySelector('.doc-inline-pagenav');
assert.strictEqual(nav.hidden, false);
assert.strictEqual(page.hidden, true, 'the passive text gives way to the page bar');
assert.strictEqual(ctl.bar.querySelector('.doc-ctl-prev').getAttribute('aria-label'), 'Previous page');
assert.strictEqual(ctl.bar.querySelector('.doc-inline-page-total').textContent, '3');
ctl.goToPage(3);
assert.strictEqual(ctl.getPage(), 3);
assert.strictEqual(ctl.bar.querySelector('.doc-inline-page-input').value, '3');
assert.ok(ctl.bar.querySelector('.doc-ctl-next').disabled);
assert.ok(!ctl.bar.querySelector('.doc-ctl-prev').disabled);
click(ctl.bar.querySelector('.doc-ctl-prev'));
assert.strictEqual(ctl.getPage(), 2);
ctl.goToPage(99);
assert.strictEqual(ctl.getPage(), 3);
const one = fixture();
one.stage.children.splice(1);
const oneCtl = attach({ card: one.card, stage: one.stage, scroller: one.scroller, doc: document });
assert.strictEqual(oneCtl.bar.querySelector('.doc-inline-pagenav').hidden, true);

(async () => {
  // Full screen opens and closes.
  const fs = ctl.bar.querySelector('.doc-ctl-fullscreen');
  await ctl.toggleFullscreen();
  fire(document, 'fullscreenchange');
  assert.strictEqual(document.fullscreenElement, f.card);
  assert.strictEqual(fs.getAttribute('aria-pressed'), 'true');
  assert.strictEqual(fs.getAttribute('aria-label'), 'Exit full screen');
  await ctl.toggleFullscreen();
  fire(document, 'fullscreenchange');
  assert.strictEqual(document.fullscreenElement, null);
  assert.strictEqual(fs.getAttribute('aria-pressed'), 'false');
  // Re-attaching replaces the old controller; destroy leaves no toolbar behind.
  const again = attach({ card: f.card, stage: f.stage, scroller: f.scroller, doc: document });
  assert.strictEqual(f.card.querySelectorAll('.doc-inline-toolbar').length, 1);
  again.destroy();
  assert.strictEqual(f.card.querySelectorAll('.doc-inline-toolbar').length, 0);
  console.log('doc inline controls ok');
})().catch((e) => { console.error(e); process.exit(1); });
