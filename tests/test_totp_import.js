const assert = require('assert');
const NotesTotp = require('../app/static/js/totp.js');
const Imp = require('../app/static/js/totp-import.js');

// Any console or network use during parsing is a failure (no plaintext secrets out).
let leaked = 0;
['log', 'info', 'warn', 'error', 'debug'].forEach((k) => { console[k] = () => { leaked += 1; }; });
globalThis.fetch = () => { leaked += 1; throw new Error('network'); };

const S1 = 'JBSWY3DPEHPK3PXP';
const S2 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const S3 = 'MFRGGZDFMZTWQ2LK';

// Strict otpauth parser
const ok = NotesTotp.parseOtpauthStrict(`otpauth://totp/Acme%20Co:ann%40example.test?secret=${S1}&algorithm=sha-256&digits=8&period=60`);
assert.ok(ok.ok);
assert.deepEqual([ok.entry.issuer, ok.entry.account, ok.entry.algorithm, ok.entry.digits, ok.entry.period], ['Acme Co', 'ann@example.test', 'SHA256', 8, 60]);
const hotp = NotesTotp.parseOtpauthStrict(`otpauth://hotp/X:y?secret=${S1}&counter=5`);
assert.ok(hotp.ok && hotp.entry.counter === 5 && hotp.entry.otp_type === 'hotp');
assert.equal(NotesTotp.parseOtpauthStrict(`otpauth://hotp/X:y?secret=${S1}`).ok, false);
const bad = [
  `otpauth://totp/X?secret=${S1}&algorithm=MD5`,
  `otpauth://totp/X?secret=${S1}&digits=9`,
  `otpauth://totp/X?secret=${S1}&digits=6abc`,
  `otpauth://totp/X?secret=${S1}&period=0`,
  `otpauth://totp/X?secret=${S1}&period=301`,
  `otpauth://totp/X?secret=${S1}&secret=${S2}`,
  'otpauth://totp/X?secret=abc!defgh',
  'otpauth://totp/X?secret=ABC',
  `otpauth://totp/%E0%A4%A?secret=${S1}`,
  `otpauth://steam/X?secret=${S1}`,
  `https://example.test/?secret=${S1}`,
  `otpauth://totp/X?secret=${S1}&issuer=${'a'.repeat(5000)}`,
];
for (const u of bad) {
  const r = NotesTotp.parseOtpauthStrict(u);
  assert.equal(r.ok, false, u.slice(0, 40));
  assert.ok(!JSON.stringify(r).includes(S1), 'error must not echo input');
}

// otpauth list
const list = `# comment\n\notpauth://totp/A:one?secret=${S1}&issuer=A\notpauth://totp/B:two?secret=${S2}\nnot a link\notpauth://hotp/C:h?secret=${S3}&counter=1\n`;
let res = Imp.parse(list);
assert.ok(res.ok);
assert.equal(res.format, 'otpauth');
assert.equal(res.entries.length, 2);
assert.deepEqual(res.skipped.slice().sort(), ['hotp', 'invalid']);

// Plain Aegis
const aegis = JSON.stringify({
  version: 1,
  header: { slots: null, params: null },
  db: {
    version: 3,
    entries: [
      { type: 'totp', name: 'ann@example.test', issuer: 'Acme', info: { secret: S1, algo: 'SHA1', digits: 6, period: 30 } },
      { type: 'totp', name: 'bob', issuer: 'Beta', info: { secret: S2, algo: 'SHA512', digits: 8, period: 60 } },
      { type: 'steam', name: 's', issuer: 'Steam', info: { secret: S3, algo: 'SHA1', digits: 5, period: 30 } },
      { type: 'totp', name: 'md5', issuer: 'Old', info: { secret: S3, algo: 'MD5', digits: 6, period: 30 } },
    ],
  },
});
res = Imp.parse(aegis);
assert.ok(res.ok && res.format === 'aegis');
assert.equal(res.entries.length, 2);
assert.equal(res.entries[1].algorithm, 'SHA512');
assert.equal(res.skipped.length, 2);

// Plain 2FAS
const twofas = JSON.stringify({
  schemaVersion: 4,
  services: [
    { name: 'Gamma', secret: S1, otp: { tokenType: 'TOTP', account: 'carol', digits: 6, period: 30, algorithm: 'SHA256' } },
    { name: 'Delta', secret: S2, otp: { tokenType: 'HOTP', counter: 1 } },
  ],
});
res = Imp.parse(twofas);
assert.ok(res.ok && res.format === '2fas');
assert.equal(res.entries.length, 1);
assert.equal(res.entries[0].issuer, 'Gamma');
assert.equal(res.entries[0].algorithm, 'SHA256');
assert.deepEqual(res.skipped, ['hotp']);

// Encrypted formats are recognised
res = Imp.parse(JSON.stringify({ version: 1, header: { slots: [{ type: 1 }], params: { nonce: 'aa', tag: 'bb' } }, db: 'AAAA' }));
assert.equal(res.error, 'encrypted');
assert.match(res.message, /coming soon/);
res = Imp.parse(JSON.stringify({ schemaVersion: 4, services: [], servicesEncrypted: 'a:b:c' }));
assert.equal(res.error, 'encrypted');

// Preview: no secrets, duplicates flagged
const parsed = Imp.parse(list).entries;
const rows = Imp.plan(parsed.concat(parsed[0]), [S2]);
assert.deepEqual(rows.map((r) => r.duplicate), [false, true, true]);
const preview = JSON.stringify(Imp.previewRows(rows));
for (const s of [S1, S2, S3]) assert.ok(!preview.includes(s));

(async () => {
  // Imported entries produce working codes
  const code = await NotesTotp.generate({ ...Imp.parse(aegis).entries[0], now: 59000 });
  assert.match(code.code, /^\d{6}$/);

  // Limits
  assert.equal(Imp.parse('x'.repeat(Imp.LIMITS.maxChars + 1)).error, 'too_large');
  const many = Array.from({ length: 2001 }, () => `otpauth://totp/A:b?secret=${S1}`).join('\n');
  assert.equal(Imp.parse(many).error, 'too_many');
  assert.equal(Imp.parse('{"a":'.repeat(40) + '1' + '}'.repeat(40)).ok, false);
  assert.equal(Imp.parse('').error, 'empty');

  // Fuzz: broken and hostile input never throws and never echoes content
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const seeds = [aegis, twofas, list, `otpauth://totp/A:b?secret=${S1}`];
  const junk = ['\u0000', '%', '%zz', '{', '}', '[', '"', '\\', '__proto__', '\uD800', '9'.repeat(30), 'null', '{"constructor":1}'];
  for (let i = 0; i < 3000; i += 1) {
    let t = seeds[Math.floor(rnd() * seeds.length)];
    const n = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k += 1) {
      const pos = Math.floor(rnd() * (t.length + 1));
      const m = rnd();
      if (m < 0.4) t = t.slice(0, pos) + junk[Math.floor(rnd() * junk.length)] + t.slice(pos);
      else if (m < 0.7) t = t.slice(0, pos) + t.slice(pos + 1 + Math.floor(rnd() * 8));
      else t = t.slice(0, pos);
    }
    const r = Imp.parse(t);
    if (!r.ok) {
      assert.ok(Object.values(Imp.MESSAGES).includes(r.message));
      assert.ok(!r.message.includes(S1));
    }
    NotesTotp.parseOtpauthStrict(t);
  }
  for (const v of [null, undefined, 5, {}, [], '{"__proto__":{"x":1}}', '[]', '{"header":1,"db":2}', '{"services":"x"}']) {
    assert.equal(Imp.parse(v).ok, false);
  }
  assert.equal(leaked, 0, 'no console or network use');
  process.stdout.write('totp import ok\n');
})().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
