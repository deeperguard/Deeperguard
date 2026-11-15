// 2FA icons (docs/2FA_IMPORT_SPEC.md section 6): issuer matching, letter avatar, icon_id kept in
// the encrypted item across edits, and no external hosts anywhere in the icon assets or code.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./sync_harness');
const T = require('../app/static/js/totp.js');
global.NotesTotp = T;
const I = require('../app/static/js/totp-icons.js');

const root = path.join(__dirname, '..', 'app', 'static');
const brandsDir = path.join(root, 'icons', 'brands');
const map = JSON.parse(fs.readFileSync(path.join(brandsDir, 'brands.json'), 'utf8'));
I.setBrands(map);
const { NotesStore } = h;

// --- matching: case, spaces, accents, suffixes, aliases, host fallback ---
for (const [issuer, slug] of [
  ['GitHub', 'github'], ['github', 'github'], ['  GITHUB  ', 'github'], ['Git Hub', 'github'],
  ['GitHub Inc', 'github'], ['github.com', 'github'], ['Google Workspace', 'google'],
  ['Twitter', 'x'], ['X', 'x'], ['Cloudflare, Inc.', 'cloudflare'], ['Dropbox', 'dropbox'],
  ['ＧｉｔＨｕｂ', 'github'], ['Épic Games', 'epicgames'], ['Epic Games Store', 'epicgames'],
]) assert.strictEqual(I.matchIssuer(issuer), slug, issuer);
assert.strictEqual(I.matchIssuer('Unknown Corp 123'), null);
assert.strictEqual(I.matchIssuer('Gitub'), null, 'no fuzzy matching');
assert.strictEqual(I.matchIssuer('', ''), null);
assert.strictEqual(I.matchIssuer('Intranet', 'accounts.github.com'), 'github');
assert.strictEqual(I.matchIssuer('Intranet', 'login.dropbox.co.uk'), 'dropbox');
assert.strictEqual(I.matchIssuer('Intranet', 'github'), null);

// --- resolve: automatic, forced letter, manual slug, stale slug ---
assert.deepStrictEqual(I.resolve({ issuer: 'GitHub', icon_id: null }), { kind: 'brand', slug: 'github' });
assert.deepStrictEqual(I.resolve({ issuer: 'GitHub', icon_id: 'letter' }), { kind: 'letter' });
assert.deepStrictEqual(I.resolve({ issuer: 'My Bank', icon_id: 'spotify' }), { kind: 'brand', slug: 'spotify' });
assert.deepStrictEqual(I.resolve({ issuer: 'GitHub', icon_id: 'gone-slug' }), { kind: 'letter' });
assert.deepStrictEqual(I.resolve({ issuer: 'My Bank' }), { kind: 'letter' });

// --- letter avatar: stable, case-insensitive colour, readable text ---
const a1 = I.avatarSpec({ issuer: 'My Bank' });
assert.strictEqual(a1.letter, 'M');
assert.deepStrictEqual(I.avatarSpec({ issuer: 'my  bank' }), a1);
assert.strictEqual(I.avatarSpec({ issuer: '', label: 'zed@x.io' }).letter, 'Z');
assert.strictEqual(I.avatarSpec({}).letter, '?');
for (const c of I.AVATAR_COLORS) {
  const n = parseInt(c.slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  assert.ok(Math.max(1.05 / (L + 0.05), (L + 0.05) / 0.05) >= 4.5, 'AA contrast ' + c);
}
assert.ok(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => I.avatarSpec({ issuer: x }).bg)).size > 1);
assert.ok(!/<b>/.test(I.iconHtml({ issuer: '<b>' })), 'letter is escaped');
assert.ok(I.iconHtml({ issuer: 'GitHub' }).includes('/static/icons/brands/brands.svg#si-github'));

// --- picker search ---
assert.ok(I.search('GITHUB').includes('github'));
assert.ok(I.search('twitter').includes('x'), 'aliases are searchable');
assert.strictEqual(I.search('zzzzqqq').length, 0);

// --- icon_id lives in the item content and survives edits ---
const added = NotesStore.addTotpAccount({ issuer: 'Acme', account: 'ann', secret: 'JBSWY3DPEHPK3PXP' });
assert.strictEqual(NotesStore.get(added.uuid).content.icon_id, null);
NotesStore.updateTotpAccount(added.uuid, { issuer: 'Acme', account: 'ann', icon_id: 'spotify' });
assert.strictEqual(NotesStore.get(added.uuid).content.icon_id, 'spotify');
NotesStore.updateTotpAccount(added.uuid, { issuer: 'Acme Inc', account: 'ann2', tags: ['Work'] });
assert.strictEqual(NotesStore.get(added.uuid).content.icon_id, 'spotify', 'kept when icon_id is not part of the edit');
assert.strictEqual(T.accountFields(NotesStore.get(added.uuid).content).icon_id, 'spotify');
NotesStore.updateTotpAccount(added.uuid, { icon_id: 'letter' });
assert.strictEqual(NotesStore.get(added.uuid).content.icon_id, 'letter');
const picked = NotesStore.addTotpAccount({ issuer: 'B', account: 'b', secret: 'MFRGGZDFMZTWQ2LK', icon_id: 'github' });
assert.strictEqual(NotesStore.get(picked.uuid).content.icon_id, 'github');

// --- no third parties ---
const EXT = /https?:\/\/[a-z0-9-]+\.[a-z]/i;
for (const f of ['brands.svg', 'brands.json']) {
  const text = fs.readFileSync(path.join(brandsDir, f), 'utf8').replace('xmlns="http://www.w3.org/2000/svg"', '');
  assert.ok(!EXT.test(text), f + ' has no external URL');
}
const iconsSrc = fs.readFileSync(path.join(root, 'js', 'totp-icons.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
assert.ok(!/https?:\/\//i.test(iconsSrc), 'totp-icons.js has no absolute URL');
assert.ok(!/<img/i.test(iconsSrc), 'totp-icons.js creates no <img>');
for (const m of iconsSrc.matchAll(/fetch\(\s*([^,)]+)/g)) assert.strictEqual(m[1].trim(), 'JSON_URL');
assert.ok(I.JSON_URL.startsWith('/static/') && I.SPRITE_URL.startsWith('/static/'));
for (const f of ['LICENSE-simple-icons.txt', 'SOURCE.txt']) assert.ok(fs.existsSync(path.join(brandsDir, f)), f);
assert.ok(/CC0/.test(fs.readFileSync(path.join(brandsDir, 'LICENSE-simple-icons.txt'), 'utf8')));
assert.ok(/trademark/i.test(fs.readFileSync(path.join(brandsDir, 'SOURCE.txt'), 'utf8')));
const tpl = fs.readFileSync(path.join(__dirname, '..', 'app', 'templates', 'app.html'), 'utf8');
const dlg = tpl.slice(tpl.indexOf('id="totp-icon-field"') < 0 ? tpl.indexOf('totp-icon-field') : 0, tpl.indexOf('id="totp-icon-grid"') + 100);
assert.ok(dlg.length > 100 && !/<img/i.test(dlg.slice(dlg.indexOf('totp-icon-field'))));
console.log('totp icons ok');
