// 2FA icons: issuer matching, letter avatar, manual choice, and no third-party network use
// (docs/2FA_IMPORT_SPEC.md, section 6).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Any network attempt while matching or rendering is a failure.
let network = 0;
globalThis.fetch = () => { network += 1; throw new Error('network'); };
globalThis.XMLHttpRequest = function XHR() { network += 1; throw new Error('network'); };
globalThis.Image = function Img() { network += 1; throw new Error('network'); };
globalThis.navigator = { sendBeacon: () => { network += 1; return false; } };

const root = path.join(__dirname, '..');
const Brands = require('../app/static/js/totp-brands.js');
const Icons = require('../app/static/js/totp-icons.js');

// Normalisation: case, spaces, accents, punctuation, company suffixes, .com
assert.equal(Icons.normalize('  GitHub  '), 'github');
assert.equal(Icons.normalize('Git Hub'), 'github');
assert.equal(Icons.normalize('GITHUB, Inc.'), 'github');
assert.equal(Icons.normalize('Amazon.com'), 'amazon');
assert.equal(Icons.normalize('Proton Mail'), 'protonmail');
assert.equal(Icons.normalize('Ｄｉｓｃｏｒｄ'), 'discord'); // NFKC full-width
assert.equal(Icons.normalize('Nëxtcloud'), 'nextcloud');
assert.equal(Icons.normalize(null), '');

// Matching on issuer: case and spacing do not matter
const m = (issuer, host) => Icons.match({ issuer, host });
assert.equal(m('GitHub'), 'github');
assert.equal(m('github'), 'github');
assert.equal(m(' GITHUB '), 'github');
assert.equal(m('Git Hub'), 'github');
assert.equal(m('Proton Mail'), 'protonmail');
assert.equal(m('protonmail'), 'protonmail');
assert.equal(m('Amazon Web Services'), 'amazonwebservices');
assert.equal(m('Microsoft Corporation'), 'microsoft');
assert.equal(m('Epic Games'), 'epicgames');
// Aliases from brands.json and the hand-kept table
assert.equal(m('Twitter'), 'x');
assert.equal(m('Google Workspace'), 'google');
assert.equal(m('AWS'), 'amazonwebservices');
assert.equal(m('Outlook'), 'microsoft');
assert.equal(m('Sony'), 'playstation');
assert.equal(m('Amazon.de'), 'amazon');
// Host fallback: registrable label
assert.equal(Icons.registrableLabel('accounts.example.com'), 'example');
assert.equal(Icons.registrableLabel('login.example.co.uk'), 'example');
assert.equal(Icons.registrableLabel('localhost'), '');
assert.equal(m('', 'signin.aws.amazon.com'), 'amazon');
assert.equal(m('My Work Login', 'id.atlassian.com'), 'atlassian');
// No fuzzy matching: a wrong logo is worse than a letter
assert.equal(m('Gitea'), null);
assert.equal(m('GitHubby'), null);
assert.equal(m('Acme Bank'), null);
assert.equal(m(''), null);

// Resolve: automatic, forced letter, manual slug, unknown slug falls back to automatic
assert.deepEqual(Icons.resolve({ issuer: 'GitHub', icon_id: null }), { kind: 'brand', slug: 'github' });
assert.deepEqual(Icons.resolve({ issuer: 'GitHub', icon_id: 'letter' }), { kind: 'letter' });
assert.deepEqual(Icons.resolve({ issuer: 'Acme Bank', icon_id: 'discord' }), { kind: 'brand', slug: 'discord' });
assert.deepEqual(Icons.resolve({ issuer: 'Acme Bank', icon_id: 'no-such-icon' }), { kind: 'letter' });
assert.deepEqual(Icons.resolve({ issuer: 'Acme Bank' }), { kind: 'letter' });

// Letter avatar: first grapheme upper case, stable colour from issuer, AA text colour
assert.equal(Icons.letterFor({ issuer: 'acme' }), 'A');
assert.equal(Icons.letterFor({ issuer: '', account: 'zed@example.test' }), 'Z');
assert.equal(Icons.letterFor({}), '?');
assert.equal(Icons.letterColor({ issuer: 'Acme Bank' }), Icons.letterColor({ issuer: '  ACME bank ' }));
assert.ok(Icons.AVATAR_COLORS.includes(Icons.letterColor({ issuer: 'Acme Bank' })));
assert.equal(Icons.AVATAR_COLORS.length, 12);
assert.equal(Icons.textOn('#000000'), '#FFFFFF');
assert.equal(Icons.textOn('#FFFC00'), '#000000');
const contrast = (a, b) => {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
Icons.AVATAR_COLORS.forEach((c) => assert.ok(contrast(c, Icons.textOn(c)) >= 4.5, c));

// Rendering: escaped, same-origin sprite only, never an <img>
const letter = Icons.iconHtml({ issuer: '<img src=x onerror=alert(1)>' });
assert.ok(!letter.includes('<img'));
assert.ok(letter.includes('&lt;'));
const brand = Icons.iconHtml({ issuer: 'GitHub' });
assert.ok(brand.includes('href="/static/icons/brands/brands.svg#si-github"'));
assert.ok(!/<img/i.test(brand));

// Picker search: case/space-insensitive, aliases count
assert.ok(Icons.search('git hub').some((r) => r.slug === 'github'));
assert.ok(Icons.search('TWITTER').some((r) => r.slug === 'x'));
assert.equal(Icons.search('zzzz-nothing').length, 0);
assert.ok(Icons.search('').length === Object.keys(Brands).length);
assert.ok(Icons.isValidIconId(null) && Icons.isValidIconId('letter') && Icons.isValidIconId('github'));
assert.ok(!Icons.isValidIconId('https://evil.test/x.png'));

// Every brand has a symbol in the sprite and a valid colour
const sprite = fs.readFileSync(path.join(root, 'app/static/icons/brands/brands.svg'), 'utf8');
const brandsJson = JSON.parse(fs.readFileSync(path.join(root, 'app/static/icons/brands/brands.json'), 'utf8'));
assert.deepEqual(Object.keys(brandsJson).sort(), Object.keys(Brands).sort());
Object.entries(Brands).forEach(([slug, b]) => {
  assert.ok(sprite.includes(`<symbol id="si-${slug}" viewBox="0 0 24 24">`), slug);
  assert.ok(/^[0-9A-F]{6}$/.test(b.hex), slug);
});
assert.ok(fs.existsSync(path.join(root, 'app/static/icons/brands/LICENSE.txt')));
assert.ok(/CC0/.test(fs.readFileSync(path.join(root, 'app/static/icons/brands/LICENSE.txt'), 'utf8')));
assert.ok(/trademark/i.test(fs.readFileSync(path.join(root, 'app/static/icons/brands/SOURCE.txt'), 'utf8')));

// No external hosts in the icon assets and modules (outside comments and the SVG namespace).
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/<!--[\s\S]*?-->/g, '');
const noExternal = (name, text) => {
  const body = stripComments(text).replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
  assert.ok(!/https?:\/\//i.test(body), `${name} references an external URL`);
  assert.ok(!/(^|["'(\s=])\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(body), `${name} references a protocol-relative URL`);
  assert.ok(!/favicon|s2\/favicons|clearbit|icons\.duckduckgo|logo\.dev/i.test(body), `${name} references a logo service`);
};
noExternal('brands.svg', sprite);
noExternal('brands.json', JSON.stringify(brandsJson));
['totp-icons.js', 'totp-brands.js'].forEach((f) => {
  const src = fs.readFileSync(path.join(root, 'app/static/js', f), 'utf8');
  noExternal(f, src);
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|new Image|sendBeacon|<img/i.test(stripComments(src)), `${f} must not load anything`);
});
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const pickerSrc = appJs.slice(appJs.indexOf('function totpIconHtml'), appJs.indexOf('async function renderTotpList'));
assert.ok(pickerSrc.length > 100);
noExternal('app.js icon picker', pickerSrc);
assert.ok(!/<img/i.test(pickerSrc));
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const iconField = appHtml.slice(appHtml.indexOf('id="totp-icon-field"'), appHtml.indexOf('Secret or otpauth URL'));
noExternal('app.html icon field', iconField);
assert.ok(appJs.includes('${totpIconHtml(item)}'));

// Manual choice is stored in the encrypted item content and survives later edits/sync merges.
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const fnSrc = storeJs.slice(storeJs.indexOf('function upgradeTotpContent'), storeJs.indexOf('// Rename a 2FA tag'));
const items = new Map([['u1', { uuid: 'u1', content: { type: 'totp', issuer: 'Acme', account: 'a', secret: 'S', extra: 1 } }]]);
// eslint-disable-next-line no-new-func
const updateTotpAccount = new Function('get', 'upsert', 'normalizeTotpBoundHost', `${fnSrc}; return updateTotpAccount;`)(
  (id) => items.get(id),
  (id, content) => items.set(id, { uuid: id, content }),
  (h) => String(h || '').toLowerCase(),
);
assert.ok(updateTotpAccount('u1', { issuer: 'Acme', account: 'a', icon_id: 'github' }));
assert.equal(items.get('u1').content.icon_id, 'github');
assert.equal(items.get('u1').content.extra, 1);
assert.equal(items.get('u1').content.secret, 'S');
assert.ok(updateTotpAccount('u1', { issuer: 'Acme 2', account: 'a' })); // no icon_id given: keep choice
assert.equal(items.get('u1').content.icon_id, 'github');
updateTotpAccount('u1', { issuer: 'Acme', account: 'a', icon_id: 'letter' });
assert.equal(items.get('u1').content.icon_id, 'letter');
updateTotpAccount('u1', { issuer: 'Acme', account: 'a', icon_id: 'https://evil.test/x.png' });
assert.equal(items.get('u1').content.icon_id, null);
assert.ok(appJs.includes("icon_id: typeof content.icon_id === 'string' ? content.icon_id : null"));

assert.equal(network, 0);
console.log('test_totp_icons ok');
