const assert = require('assert');
const crypto = require('crypto');
const NotesTotp = require('../app/static/js/totp.js');
globalThis.NotesTotp = NotesTotp;
const Imp = require('../app/static/js/totp-import.js');
const Kdf = require('../app/static/js/kdf-worker.js');

// Fixtures are generated here with node:crypto (not with the code under test).
const PASSWORD = 'correct horse battery staple';
const S1 = 'JBSWY3DPEHPK3PXP';
const S2 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

let leaked = 0;
['log', 'info', 'warn', 'error', 'debug'].forEach((k) => { console[k] = () => { leaked += 1; }; });
globalThis.fetch = () => { leaked += 1; throw new Error('network'); };

function gcm(key, iv, plain) {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { ct, tag: c.getAuthTag() };
}

function aegisFile(password, { n = 1024, r = 8, p = 1, extraSlots = [] } = {}) {
  const db = { version: 2, entries: [
    { type: 'totp', name: 'ann@example.test', issuer: 'Acme', info: { secret: S1, algo: 'SHA1', digits: 6, period: 30 } },
    { type: 'totp', name: 'bob', issuer: 'Globex', info: { secret: S2, algo: 'SHA256', digits: 8, period: 60 } },
  ] };
  const master = crypto.randomBytes(32);
  const salt = crypto.randomBytes(32);
  const kek = crypto.scryptSync(password, salt, 32, { N: n > 2 ** 20 ? 1024 : n, r, p, maxmem: 1 << 30 });
  const kn = crypto.randomBytes(12);
  const wrapped = gcm(kek, kn, master);
  const dbn = crypto.randomBytes(12);
  const d = gcm(master, dbn, Buffer.from(JSON.stringify(db)));
  return JSON.stringify({
    version: 1,
    header: {
      slots: [...extraSlots, { type: 1, uuid: 'u', key: wrapped.ct.toString('hex'), key_params: { nonce: kn.toString('hex'), tag: wrapped.tag.toString('hex') }, n, r, p, salt: salt.toString('hex'), repaired: true }],
      params: { nonce: dbn.toString('hex'), tag: d.tag.toString('hex') },
    },
    db: d.ct.toString('base64'),
  });
}

function twofasFile(password, iterations) {
  const services = [
    { name: 'Acme', secret: S1, otp: { tokenType: 'TOTP', issuer: 'Acme', account: 'ann', digits: 6, period: 30, algorithm: 'SHA1' } },
    { name: 'Globex', secret: S2, otp: { tokenType: 'TOTP', issuer: 'Globex', account: 'bob', digits: 8, period: 60, algorithm: 'SHA256' } },
  ];
  const salt = crypto.randomBytes(256);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, iterations || 10000, 32, 'sha256');
  const e = gcm(key, iv, Buffer.from(JSON.stringify(services)));
  const part = (c, s, i) => [Buffer.concat([c.ct, c.tag]).toString('base64'), s.toString('base64'), i.toString('base64')].join(':');
  const out = { schemaVersion: 4, services: [], servicesEncrypted: part(e, salt, iv) };
  const rs = crypto.randomBytes(256);
  const ri = crypto.randomBytes(12);
  const rk = crypto.pbkdf2Sync(password, rs, iterations || 10000, 32, 'sha256');
  out.reference = part(gcm(rk, ri, Buffer.from('ref')), rs, ri);
  if (iterations) out.iterations = iterations;
  return JSON.stringify(out);
}

// Run the real worker core, without the thread.
const inProcess = (job) => Kdf.runKdfJob(job);

(async () => {
  // scrypt agrees with node's implementation (and so with RFC 7914).
  for (const [n, r, p] of [[1024, 1, 1], [1024, 8, 2], [4096, 4, 1]]) {
    const mine = Buffer.from(await Kdf.scrypt(Buffer.from('pässword'), Buffer.from('saltsalt'), n, r, p, 40));
    assert.ok(mine.equals(crypto.scryptSync('pässword', 'saltsalt', 40, { N: n, r, p })), `scrypt ${n}/${r}/${p}`);
  }
  assert.equal(Buffer.from(await Kdf.scrypt(Buffer.alloc(0), Buffer.alloc(0), 16, 1, 1, 8).catch(() => 'x')).toString(), 'x', 'N below minimum refused');

  // Aegis: right password, also with a first slot for another password
  const decrypt = (file, pw) => Imp.decryptAndParse(file, pw, { run: inProcess });
  const otherSlot = (() => { const f = JSON.parse(aegisFile('other')); return f.header.slots; })();
  for (const file of [aegisFile(PASSWORD), aegisFile(PASSWORD, { extraSlots: otherSlot })]) {
    assert.equal(Imp.parse(file).error, 'encrypted');
    const res = await decrypt(file, PASSWORD);
    assert.ok(res.ok, res.message);
    assert.deepEqual(res.entries.map((e) => e.secret), [S1, S2]);
    assert.equal(res.format, 'aegis');
  }
  // Wrong password: generic message, same as damaged file
  const wrong = await decrypt(aegisFile(PASSWORD), 'nope');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.message, 'Wrong password or damaged file');
  assert.equal((await decrypt(aegisFile(PASSWORD), '')).message, wrong.message);
  const damaged = JSON.parse(aegisFile(PASSWORD));
  damaged.db = Buffer.from('garbage-garbage').toString('base64');
  assert.equal((await decrypt(JSON.stringify(damaged), PASSWORD)).message, wrong.message);
  // No password slot
  const noSlot = JSON.parse(aegisFile(PASSWORD));
  noSlot.header.slots[0].type = 2;
  assert.equal((await decrypt(JSON.stringify(noSlot), PASSWORD)).error, 'no_slot');

  // Too-high KDF parameters are refused fast, before deriving anything
  const bigs = [{ n: 2 ** 24 }, { n: 2 ** 20, r: 16 }, { n: 1000 }, { n: 1024, r: 17 }, { n: 1024, p: 5 }, { n: 512 }];
  for (const big of bigs) {
    const f = aegisFile(PASSWORD, { n: 1024 });
    const o = JSON.parse(f);
    Object.assign(o.header.slots[0], big);
    const t = Date.now();
    const res = await decrypt(JSON.stringify(o), PASSWORD);
    assert.equal(res.error, 'kdf_limit', JSON.stringify(big));
    assert.ok(Date.now() - t < 1000);
  }
  // A second, over-cap slot is refused too, even behind a valid one
  const mixed = JSON.parse(aegisFile(PASSWORD));
  mixed.header.slots.push(Object.assign({}, mixed.header.slots[0], { n: 2 ** 24 }));
  assert.equal((await decrypt(JSON.stringify(mixed), PASSWORD)).error, 'kdf_limit');

  // 2FAS
  const tf = twofasFile(PASSWORD);
  assert.equal(Imp.parse(tf).error, 'encrypted');
  const ok2 = await decrypt(tf, PASSWORD);
  assert.ok(ok2.ok, ok2.message);
  assert.deepEqual(ok2.entries.map((e) => e.secret), [S1, S2]);
  assert.equal((await decrypt(tf, 'nope')).message, 'Wrong password or damaged file');
  const custom = await decrypt(twofasFile(PASSWORD, 20000), PASSWORD);
  assert.ok(custom.ok, 'in-range iterations from the file are used');
  const tooHigh = JSON.parse(tf);
  tooHigh.iterations = 50000000;
  const t0 = Date.now();
  assert.equal((await decrypt(JSON.stringify(tooHigh), PASSWORD)).error, 'kdf_limit');
  tooHigh.iterations = 10;
  assert.equal((await decrypt(JSON.stringify(tooHigh), PASSWORD)).error, 'kdf_limit');
  assert.ok(Date.now() - t0 < 1000);
  const badIv = JSON.parse(tf);
  const parts = badIv.servicesEncrypted.split(':');
  parts[2] = Buffer.alloc(8).toString('base64');
  badIv.servicesEncrypted = parts.join(':');
  assert.equal((await decrypt(JSON.stringify(badIv), PASSWORD)).ok, false);

  // The worker zeroes the password buffer, and nothing leaks to console or network
  const pw = new TextEncoder().encode(PASSWORD);
  await Kdf.runKdfJob({ format: 'aegis', password: pw, data: JSON.parse(aegisFile(PASSWORD)).header });
  assert.ok(pw.every((b) => b === 0), 'password zeroed');
  const errs = [wrong, ok2].map((r) => JSON.stringify(r.message || ''));
  errs.forEach((e) => assert.ok(!e.includes(PASSWORD)));
  assert.equal(leaked, 0);
  process.stdout.write('ok test_totp_kdf\n');
})().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
