/**
 * Marketing dark mode: surfaces use theme tokens, not hard-coded white panels.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const marketing = fs.readFileSync(path.join(__dirname, '../app/static/css/marketing.css'), 'utf8');

assert.ok(!/\.mk-distinction-card\.featured\s*\{[^}]*background:\s*#fff/i.test(marketing));
assert.ok(marketing.includes('.mk-distinction-card.featured'));
assert.ok(marketing.includes('background: var(--mk-panel)'));
assert.ok(marketing.includes('--mk-col-highlight-bg:'));
assert.ok(marketing.includes('--mk-topbar-solid:'));
const dark = marketing.split('@media (prefers-color-scheme: dark)')[1];
assert.ok(dark.includes('--mk-col-highlight-bg: #1e3a5f'));
assert.ok(dark.includes('--mk-topbar-solid: #1e293b'));
assert.ok(dark.includes('--mk-distinction-verdict-featured-bg'));

console.log('test_round39_marketing_dark ok');
