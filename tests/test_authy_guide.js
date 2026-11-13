const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync('app/templates/app.html', 'utf8');
const doc = fs.readFileSync('docs/2FA_MIGRATION_GUIDE.md', 'utf8');
assert.ok(html.includes('id="totp-import-authy"') && html.includes('id="totp-authy-scan"'));
assert.ok(/no official export/i.test(html) && /no official export/i.test(doc));
['Authy', 'Google Authenticator', 'Aegis', '2FAS'].forEach((n) => assert.ok(doc.includes(n), n));
// No promise of a direct Authy import and no extraction-tool advice.
const promise = /\b(import(ing)?\s+(from\s+)?authy|authy\s+import)\b/i;
[html, doc].forEach((t) => t.split('\n').forEach((l) => {
  if (promise.test(l)) assert.ok(/\b(no|not|never)\b/i.test(l), l);
}));
console.log('ok');
