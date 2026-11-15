'use strict';
// Static contract checks for footer alignment, reading width and the
// collapsible list column (docs/UI_POLISH.md section 7).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const js = read('app/static/js/app.js');
const css = read('app/static/css/app.css');
const html = read('app/templates/app.html');

// No "0 words" for attachment/PDF notes; scanned-text count stays.
assert.match(js, /scannedWords > 0 \|\| NotesStore\.listAttachments\(note\.uuid\)\.length > 0\) \? updated : `0 words/);
assert.match(js, /Scanned text: \$\{scannedWords\}/);

// Reading width comes from tokens and applies at the 1920px desktop layout.
assert.match(css, /--content-max: 860px/);
assert.match(css, /--content-max-viewer: 1100px/);
assert.match(css, /max-width: min\(var\(--content-max\), 100%\)/);
assert.match(css, /\.backlinks\[data-empty="true"\] \.backlinks-empty \{ display: none; \}/);

// Splitter: keyboard-operable separator with visible grip; toggle button.
assert.match(html, /id="pane-splitter"[^>]*role="separator"[^>]*tabindex="0"/);
assert.match(css, /\.pane-splitter::after/);
const toggle = html.match(/<button[^>]*id="btn-list-toggle"[^>]*>/)[0];
assert.ok(/aria-label="[^"]+"/.test(toggle) && /title="[^"]+"/.test(toggle) && /aria-expanded=/.test(toggle));

// Collapsed state persists in the local UI prefs only, never the server prefs.
assert.match(js, /prefs\.listCollapsed = !!collapsed;\s*try \{ localStorage\.setItem\('deeperguard-prefs', localPrefsJson\(\)\)/);
assert.ok(!/GLOBAL_PREF_KEYS[^;]*listCollapsed/.test(js));
console.log('ok layout footer/width');
