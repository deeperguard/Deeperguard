/**
 * 2FA vault list: on phone-width viewports, issuer/account and Site lines must wrap
 * instead of single-line ellipsis crushed by the code + action cluster.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');

const renderTotp = appJs.split('async function renderTotpList()')[1].split('function startTotpClock()')[0];
assert.ok(renderTotp.includes('title="${escapeAttr(label)}"'), 'account label needs native tooltip when clipped on wide rows');
assert.ok(renderTotp.includes('totp-bound-host" title="${escapeAttr(boundHost)}"'));
assert.ok(renderTotp.includes('>On server</button>'), 'marketing label must stay On server');
assert.ok(renderTotp.includes('data-totp-copy'), 'tap-to-copy row control must remain');

assert.ok(appCss.includes('@media (max-width: 999px)'));
const narrowBlock = appCss.split('@media (max-width: 999px) {')[1].split('@media (min-width: 1000px)')[0];
assert.ok(narrowBlock.includes('.totp-item-main'), 'narrow rules must retarget the copy row');
assert.ok(narrowBlock.includes('grid-template-areas'), 'code moves off the identity column on narrow viewports');
assert.ok(narrowBlock.includes('"code code"'), 'TOTP code sits on its own row so names keep horizontal space');
assert.ok(narrowBlock.includes('white-space: normal'), 'issuer/account must wrap, not Krak... ellipsis');
assert.ok(narrowBlock.includes('-webkit-line-clamp: unset'), 'Site line must not stay single-line clamped');
assert.ok(narrowBlock.includes('flex-wrap: wrap'), 'Edit / On server actions wrap under the main row');
assert.ok(narrowBlock.includes('margin-left: auto'), 'action cluster aligns to the row end without stealing label width');

console.log('test_round86_totp_list_narrow: ok');
