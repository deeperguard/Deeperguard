/**
 * Round 61: /verify polish + View server copy duplicate lead.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const verify = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/marketing.css'), 'utf8');
const clientAssets = fs.readFileSync(path.join(root, 'app/client_assets.py'), 'utf8');

// 1. Honest cosign wording + conditional signed releases
assert.ok(verify.includes('release_signed'));
assert.ok(verify.includes('once release signing is active')
  || verify.includes('Sigstore-signed'));
assert.ok(verify.includes('cosign verify-blob'));
assert.ok(verify.includes('signed releases'));
assert.ok(verify.includes('href="{{ release_url }}"'));
assert.ok(!verify.includes('href="https://github.com/deeperguard/Deeperguard/releases"'));

// 3. No stray { before labels; labels outside <pre>
assert.ok(!/<pre class="mk-code"[^>]*>\s*\{?\s*<span class="mk-code-label">/.test(verify));
assert.ok(!verify.includes('span class="mk-code-label"'));
assert.ok(verify.includes('figcaption class="mk-code-label"'));
assert.ok(verify.includes('figure class="mk-code-block"'));
// JSON samples still look like JSON
assert.ok(/<pre class="mk-code"[^>]*>\s*\{/.test(verify));

// 5. Mobile line-height + horizontal scroll for code blocks
assert.ok(css.includes('.mk-subpage .mk-card code'));
assert.ok(css.includes('line-height: inherit'));
assert.ok(css.includes('.mk-code-block'));
assert.ok(css.includes('overflow-x: auto'));

// 2. Dialog lead once — JS must not re-set the same sentence on success
const lead = "This is everything our server has for this item. Without your vault password it's unreadable.";
const leadCountHtml = (appHtml.split(lead).length - 1)
  + (appHtml.split("Without your vault password it\\'s unreadable.").length - 1)
  + (appHtml.split('Without your vault password it&apos;s unreadable.').length - 1);
assert.ok(leadCountHtml >= 1, 'dialog markup keeps the lead once');
assert.ok(appHtml.includes('scan-dialog-lead'));
// Success path hides status instead of duplicating the lead
assert.ok(appJs.includes('status.hidden = true'));
assert.ok(!/status\.textContent = 'This is everything our server has/.test(appJs));

// Only one About section
assert.strictEqual((appHtml.match(/id="settings-about"/g) || []).length, 1);

// Entry points for every item type (attachments included)
assert.ok(appJs.includes('note-info-server-copy'));
assert.ok(appJs.includes('totp-item-server-copy'));
assert.ok(appJs.includes('folder-server-copy'));
assert.ok(appJs.includes('View server copy for tag'));
assert.ok(appJs.includes('data-server-copy="${escapeAttr(a.uuid)}"')
  || appJs.includes('data-server-copy="${escapeAttr(a.uuid)}'));

assert.ok(clientAssets.includes('def release_is_signed'));
assert.ok(clientAssets.includes('client-manifest.sigstore.json'));

console.log('test_round61_verify_polish ok');
