// Google Authenticator otpauth-migration:// import (docs/2FA_IMPORT_SPEC.md 3.4).
// Payloads are built here from made-up secrets with a tiny protobuf encoder.
const assert = require('assert');
const NotesTotp = require('../app/static/js/totp.js');
const Imp = require('../app/static/js/totp-import.js');

let leaked = 0;
['log', 'info', 'warn', 'error', 'debug'].forEach((k) => { console[k] = () => { leaked += 1; }; });
globalThis.fetch = () => { leaked += 1; throw new Error('network'); };

// ---- encoder ----
function varint(n) {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
const vfield = (f, n) => [...varint((f << 3) | 0), ...varint(n)];
const bfield = (f, bytes) => [...varint((f << 3) | 2), ...varint(bytes.length), ...bytes];
const str = (s) => [...Buffer.from(s, 'utf8')];
function otp({ secret, name = '', issuer = '', algorithm = 1, digits = 1, type = 2, counter }) {
  const out = [...bfield(1, [...secret]), ...bfield(2, str(name))];
  if (issuer) out.push(...bfield(3, str(issuer)));
  out.push(...vfield(4, algorithm), ...vfield(5, digits), ...vfield(6, type));
  if (counter != null) out.push(...vfield(7, counter));
  return out;
}
function payload(params, { size = 1, index = 0, id = 77, version = 1 } = {}) {
  const out = [];
  for (const p of params) out.push(...bfield(1, otp(p)));
  out.push(...vfield(2, version), ...vfield(3, size), ...vfield(4, index), ...vfield(5, id));
  return Uint8Array.from(out);
}
const uri = (bytes, { urlsafe = false, encode = true } = {}) => {
  let b64 = Buffer.from(bytes).toString('base64');
  if (urlsafe) b64 = b64.replace(/\+/g, '-').replace(/\//g, '_');
  return `otpauth-migration://offline?data=${encode ? encodeURIComponent(b64) : b64}`;
};

const K1 = Buffer.from('12345678901234567890'); // RFC 6238 test key
const K2 = Buffer.from('made-up-secret-two!!');
const K3 = Buffer.from('another made up key3');
const B32_1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

(async () => {
  // Single batch: enums, name split, base32 and correct codes
  const single = uri(payload([
    { secret: K1, name: 'Acme:ann@example.test', issuer: 'Acme' },
    { secret: K2, name: 'Beta:bob', algorithm: 2, digits: 2 },
    { secret: K3, name: 'plain', algorithm: 3 },
    { secret: K3, name: 'md5', algorithm: 4 },
    { secret: K3, name: 'unspecified', type: 0 },
    { secret: K3, name: 'hotp', type: 1, counter: 42 },
    { secret: K3, name: 'hotp-neg', type: 1, counter: -1 },
    { secret: K3, name: 'nine digits', digits: 7 },
    { secret: Buffer.from('short'), name: 'short' },
  ]));
  assert.ok(Imp.isMigration(single));
  let res = Imp.parse(single);
  assert.ok(res.ok, res.message);
  assert.equal(res.format, 'google');
  assert.equal(res.incomplete, null);
  assert.equal(res.entries.length, 3);
  const [a, b, c] = res.entries;
  assert.deepEqual([a.issuer, a.account, a.secret, a.algorithm, a.digits, a.period], ['Acme', 'ann@example.test', B32_1, 'SHA1', 6, 30]);
  assert.deepEqual([b.issuer, b.account, b.algorithm, b.digits], ['Beta', 'bob', 'SHA256', 8]);
  assert.deepEqual([c.account, c.algorithm], ['plain', 'SHA512']);
  assert.deepEqual(res.skipped, ['md5', 'unsupported', 'hotp', 'invalid', 'unsupported', 'invalid']);
  // RFC 6238 SHA1 vector at T=59 -> 94287082 (8 digits), so 6 digits -> 287082
  assert.equal((await NotesTotp.generate({ ...a, now: 59000 })).code, '287082');
  const dec = Imp.decodeMigration(single);
  assert.deepEqual(dec.batch, { size: 1, index: 0, id: '77' });

  // HOTP counter is read (and validated as a safe integer)
  const hotpOnly = Imp.decodeMigration(uri(payload([{ secret: K3, name: 'h', type: 1, counter: 9007199254740993n }])));
  assert.deepEqual(hotpOnly.skipped, ['invalid']);

  // URL-safe and unencoded base64 both work; '+' must not become a space
  const plusBytes = payload([{ secret: Buffer.from([0xfb, 0xff, 0xfe, 0xfb, 0xef, 0xbe, 0xfb, 0xff, 0xfe, 0xfb]), name: 'p' }]);
  for (const opts of [{ urlsafe: true }, { encode: false }, {}]) {
    const r = Imp.parse(uri(plusBytes, opts));
    assert.ok(r.ok && r.entries.length === 1, JSON.stringify(opts));
  }

  // Multi-batch collector: progress, duplicate ignored, other export refused (nothing lost)
  const batches = [0, 1, 2].map((i) => uri(payload([{ secret: [K1, K2, K3][i], name: `n${i}`, issuer: `I${i}` }], { size: 3, index: i, id: -5 })));
  const other = uri(payload([{ secret: K1, name: 'x' }], { size: 2, index: 0, id: 99 }));
  const col = Imp.createMigrationCollector();
  let st = col.add(batches[1]);
  assert.deepEqual([st.status, st.have, st.size, st.complete], ['added', 1, 3, false]);
  assert.equal(col.add(batches[1]).status, 'duplicate');
  st = col.add(other);
  assert.equal(st.status, 'other_batch');
  assert.equal(st.have, 1);
  assert.equal(col.add('otpauth-migration://offline?data=%%%').status, 'invalid');
  let partial = col.result();
  assert.ok(partial.ok);
  assert.deepEqual(partial.incomplete, { have: 1, size: 3 });
  col.add(batches[2]);
  st = col.add(batches[0]);
  assert.deepEqual([st.status, st.have, st.complete], ['added', 3, true]);
  const full = col.result();
  assert.equal(full.incomplete, null);
  assert.deepEqual(full.entries.map((e) => e.issuer), ['I0', 'I1', 'I2']);
  col.reset();
  assert.deepEqual(col.progress(), { have: 0, size: 0, complete: false });

  // Pasted text: all batches -> complete; missing batch -> incomplete warning; mixed -> error
  res = Imp.parse(batches.join('\n'));
  assert.ok(res.ok && res.entries.length === 3 && res.incomplete === null);
  res = Imp.parse([batches[0], batches[2]].join('\n'));
  assert.ok(res.ok);
  assert.deepEqual(res.incomplete, { have: 2, size: 3 });
  res = Imp.parse([batches[0], other].join('\n'));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'mixed_batches');
  res = Imp.parse([batches[0], `otpauth://totp/X?secret=${B32_1}`].join('\n'));
  assert.equal(res.ok, false);

  // Plan with dedupe against the vault
  const rows = Imp.plan(full.entries, [B32_1]);
  assert.deepEqual(rows.map((r) => r.duplicate), [true, false, false]);

  // Invalid and truncated protobuf is refused, never throws
  const good = payload([{ secret: K1, name: 'a' }]);
  for (let cut = 1; cut < good.length; cut += 1) {
    const r = Imp.decodeMigration(uri(good.slice(0, cut)));
    if (r.ok) assert.ok(r.entries.length + r.skipped.length <= 1);
    else assert.equal(r.error, 'migration_invalid');
  }
  const bad = [
    Uint8Array.from([0x0a, 0x7f, 0x01]), // length past end
    Uint8Array.from([0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]), // varint > 10 bytes
    Uint8Array.from([0x10, 0x80]), // truncated varint
    Uint8Array.from([0x0b, 0x0c]), // group wire type
    Uint8Array.from([0x00, 0x01]), // field 0
    payload([], { size: 51 }), // batch_size over limit
    payload([], { size: 3, index: 3 }), // index out of range
    payload([], { size: -1 }),
    Uint8Array.from([...payload([]), 0x0a, 0x04, 0x12, 0x02, 0xc3, 0x28]), // bad UTF-8 in name
    Uint8Array.from([0x0a, 0x03, 0x0a, 0x09, 0x00]), // nested length past inner end
  ];
  for (const bytes of bad) {
    const r = Imp.parse(uri(bytes));
    assert.equal(r.ok, false);
  }
  for (const u of ['otpauth-migration://offline?data=', 'otpauth-migration://offline?foo=1',
    `otpauth-migration://offline?data=${'A'.repeat(5000)}`, 'otpauth-migration://offline?data=a&data=b',
    'otpauth-migration://offline?data=%E0%A4%A', 'otpauth-migration://offline?data=A']) {
    assert.equal(Imp.parse(u).ok, false, u.slice(0, 50));
  }
  // Unknown fields (incl. fixed32/64) are skipped
  const extra = Uint8Array.from([...payload([{ secret: K1, name: 'a' }]), 0x31, 1, 2, 3, 4, 5, 6, 7, 8, 0x3d, 1, 2, 3, 4, 0x42, 0x01, 0x00]);
  assert.equal(Imp.parse(uri(extra)).entries.length, 1);
  // Count limits: too many batches pasted, too many accounts collected
  assert.equal(Imp.parse(Array(51).fill(batches[0]).join('\n')).error, 'too_many');
  const many = payload(Array.from({ length: 150 }, (_, i) => ({ secret: K1, name: `n${i}` })));
  assert.ok(Imp.decodeMigration(uri(many)).ok === false); // data over 4096 chars

  // Fuzz: random mutations of valid payloads and random bytes never throw or hang
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const seeds = [payload([{ secret: K1, name: 'Acme:a', issuer: 'Acme' }, { secret: K2, name: 'b', type: 1, counter: 3 }], { size: 2, index: 1 }), good];
  const started = Date.now();
  for (let i = 0; i < 5000; i += 1) {
    let bytes;
    if (rnd() < 0.2) bytes = Uint8Array.from({ length: Math.floor(rnd() * 200) }, () => Math.floor(rnd() * 256));
    else {
      bytes = Uint8Array.from(seeds[Math.floor(rnd() * seeds.length)]);
      const n = 1 + Math.floor(rnd() * 4);
      for (let k = 0; k < n; k += 1) bytes[Math.floor(rnd() * bytes.length)] = Math.floor(rnd() * 256);
      if (rnd() < 0.3) bytes = bytes.slice(0, Math.floor(rnd() * bytes.length));
    }
    const r = Imp.parse(uri(bytes, { urlsafe: rnd() < 0.5 }));
    if (!r.ok) assert.ok(Object.values(Imp.MESSAGES).includes(r.message));
    else for (const e of r.entries) assert.ok(NotesTotp.decodeBase32(e.secret));
    const c2 = Imp.createMigrationCollector();
    c2.add(uri(bytes));
    c2.result();
  }
  assert.ok(Date.now() - started < 20000, 'fuzz must not hang');

  // ---- UI collector flow (app.js), run against small DOM stubs ----
  const fs = require('fs');
  const path = require('path');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'app/static/js/app.js'), 'utf8');
  const from = appJs.indexOf('  const totpMigration = NotesTotpImport.createMigrationCollector();');
  const to = appJs.indexOf('  async function decodeQrFromSource(', from);
  assert.ok(from > 0 && to > from, 'migration UI block found');
  const pasteFrom = appJs.indexOf("totpUi.secret?.addEventListener('paste', (event) => {");
  const pasteSrc = appJs.slice(pasteFrom, appJs.indexOf('\n  });\n', pasteFrom) + 6);
  const ui = (() => {
    const els = {};
    const el = (id) => { els[id] = els[id] || { id, hidden: true, textContent: '' }; return els[id]; };
    const log = { camStatus: [], addError: [], importShown: null, importError: '', stopped: 0, hidden: 0 };
    let camActive = true;
    const env = {
      NotesTotpImport: Imp,
      document: { getElementById: el },
      totpUi: { dialog: { hidden: false }, secret: { addEventListener: (t, fn) => { env.onPaste = fn; } } },
      totpCamera: { active: () => camActive },
      setTotpCamStatus: (t, e) => log.camStatus.push([t, !!e]),
      setTotpAddError: (t) => log.addError.push(t),
      stopTotpQrScan: () => { log.stopped += 1; camActive = false; },
      hideTotpAddDialog: () => { log.hidden += 1; env.totpUi.dialog.hidden = true; camActive = false; },
      showTotpImportDialog: () => {},
      showTotpImportResult: (r) => { log.importShown = r; },
      setTotpImportError: (t) => { log.importError = t; },
      readTotpDialogTags: () => [],
      importTotpQrFile: () => {},
      NotesTotp,
    };
    const names = Object.keys(env).filter((k) => k !== 'onPaste');
    // eslint-disable-next-line no-new-func
    const api = new Function(...names, 'env', `${appJs.slice(from, to)}\n${pasteSrc}\nreturn { addTotpMigrationCode, applyTotpQrPayload, finishTotpMigration, resetTotpMigration, totpMigration };`)(...names.map((k) => env[k]), env);
    return { api, env, els, log, setCam: (v) => { camActive = v; } };
  })();
  // Camera: first code shows progress and keeps scanning
  assert.equal(ui.api.addTotpMigrationCode(batches[0]), true);
  assert.match(ui.els['totp-migration-status'].textContent, /1 of 3 scanned/);
  assert.equal(ui.els['totp-migration'].hidden, false);
  assert.equal(ui.els['totp-cam-migration-import'].hidden, false);
  assert.match(ui.log.camStatus.at(-1)[0], /1 of 3 scanned/);
  assert.equal(ui.log.stopped + ui.log.hidden, 0);
  // Same code again: ignored, no error; another export: refused with a message, nothing lost
  ui.api.addTotpMigrationCode(batches[0]);
  assert.equal(ui.log.camStatus.at(-1)[1], false);
  ui.api.addTotpMigrationCode(other);
  assert.equal(ui.log.camStatus.at(-1)[1], true);
  assert.match(ui.log.camStatus.at(-1)[0], /different export/);
  assert.equal(ui.api.totpMigration.progress().have, 1);
  // Paste in the Secret field (Ctrl+V) with a migration link is caught and collected
  let prevented = 0;
  ui.env.onPaste({ clipboardData: { getData: () => batches[1], files: [] }, preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.match(ui.els['totp-migration-status'].textContent, /2 of 3 scanned/);
  // Import what I have -> preview with incomplete warning
  ui.api.finishTotpMigration();
  assert.deepEqual(ui.log.importShown.incomplete, { have: 2, size: 3 });
  assert.equal(ui.log.importShown.entries.length, 2);
  assert.equal(ui.api.totpMigration.progress().have, 0);
  // All codes (multi-line paste) -> preview opens on its own, complete
  ui.env.totpUi.dialog.hidden = false;
  ui.log.importShown = null;
  assert.equal(ui.api.applyTotpQrPayload(batches.join('\n')), true);
  assert.equal(ui.log.importShown.incomplete, null);
  assert.equal(ui.log.importShown.entries.length, 3);
  // A damaged code with nothing collected is shown as an error
  ui.env.totpUi.dialog.hidden = false;
  ui.setCam(false);
  ui.api.applyTotpQrPayload('otpauth-migration://offline?data=AAAA');
  assert.equal(ui.log.addError.at(-1), Imp.MESSAGES.migration_invalid);

  assert.equal(leaked, 0, 'no console or network use');
  process.stdout.write('totp migration ok\n');
})().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
