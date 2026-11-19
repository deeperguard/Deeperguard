const assert = require('assert');
const crypto = require('crypto');
const Zip = require('../app/static/js/ziplib.js');

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// Replace an ASCII name inside a finished archive (local + central header) with one of equal length.
function renameInZip(zip, from, to) {
  const a = enc(from);
  const b = enc(to);
  assert.strictEqual(a.length, b.length);
  const out = Uint8Array.from(zip);
  let hits = 0;
  for (let i = 0; i + a.length <= out.length; i += 1) {
    if (a.every((v, k) => out[i + k] === v)) { out.set(b, i); hits += 1; }
  }
  assert.strictEqual(hits, 2, 'name must occur in local and central header');
  return out;
}

// Patch a field of the first central directory record.
function patchCentral(zip, offsetInCentral, writer) {
  const out = Uint8Array.from(zip);
  const dv = new DataView(out.buffer);
  for (let i = out.length - 22; i >= 0; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      writer(dv, dv.getUint32(i + 16, true) + offsetInCentral);
      return out;
    }
  }
  throw new Error('no eocd');
}

async function rejects(promise, code) {
  try { await promise; } catch (err) {
    assert.ok(err instanceof Zip.ZipError, `expected ZipError, got ${err && err.stack}`);
    assert.strictEqual(err.code, code, err.message);
    return err;
  }
  return assert.fail(`expected rejection with ${code}`);
}

(async () => {
  // Known CRC-32 value.
  assert.strictEqual(Zip.crc32(enc('123456789')), 0xcbf43926);

  // Round trip: deflate (compressible), stored (incompressible), empty, directory, unicode name.
  const random = new Uint8Array(crypto.randomBytes(3000));
  const text = enc('hello zip '.repeat(500));
  const zip = await Zip.writeZip([
    { name: 'notes/', bytes: new Uint8Array(0) },
    { name: 'notes/Café.md', bytes: text },
    { name: 'attachments/r.bin', bytes: random },
    { name: 'empty.txt', bytes: new Uint8Array(0) },
  ]);
  assert.ok(zip.length < text.length + random.length, 'text entry is deflated');
  const back = await Zip.readZip(zip);
  assert.deepStrictEqual(back.map((e) => e.name), ['notes/Café.md', 'attachments/r.bin', 'empty.txt']);
  assert.strictEqual(dec(back[0].bytes), dec(text));
  assert.deepStrictEqual(Buffer.from(back[1].bytes), Buffer.from(random));
  assert.strictEqual(back[2].bytes.length, 0);

  // compress:false writes stored entries and still reads back.
  const stored = await Zip.writeZip([{ name: 'a.txt', bytes: text }], { compress: false });
  assert.ok(stored.length > text.length);
  assert.strictEqual(dec((await Zip.readZip(stored))[0].bytes), dec(text));

  // Zero entries.
  assert.deepStrictEqual(await Zip.readZip(await Zip.writeZip([])), []);

  // Writer refuses unsafe and duplicate names.
  await rejects(Zip.writeZip([{ name: '../x.txt', bytes: text }]), 'unsafe-name');
  await rejects(Zip.writeZip([{ name: 'A.txt', bytes: text }, { name: 'a.TXT', bytes: text }]), 'duplicate-name');

  // Zip slip: reader refuses traversal, absolute, backslash, drive and NUL names.
  const base = await Zip.writeZip([{ name: 'aa/x.txt', bytes: enc('x') }], { compress: false });
  assert.strictEqual(dec((await Zip.readZip(base))[0].bytes), 'x');
  for (const bad of ['../x.txt', 'a/../x.t', '/etc/pwd', '/aa/x.tx', 'aa\\x.txt', 'C:/aa/xt', 'aa/x\u0000.tx']) {
    await rejects(Zip.readZip(renameInZip(base, 'aa/x.txt', bad)), 'unsafe-name');
  }

  // Mac resource folder and directory entries are skipped silently; the note entry is returned.
  const macos = await Zip.writeZip([
    { name: '__MACOSX/', bytes: new Uint8Array(0) },
    { name: '__MACOSX/notes/._a.md', bytes: enc('resource fork') },
    { name: 'notes/a.md', bytes: enc('# a') },
    { name: '__MACOSX/._b.md', bytes: enc('resource fork') },
  ], { compress: false });
  assert.deepStrictEqual((await Zip.readZip(macos)).map((e) => e.name), ['notes/a.md']);

  // Corrupt CRC (stored data flipped, and header CRC changed on a deflated entry).
  const flipped = Uint8Array.from(stored);
  flipped[30 + 'a.txt'.length + 5] ^= 0xff;
  await rejects(Zip.readZip(flipped), 'crc');
  const badCrc = patchCentral(await Zip.writeZip([{ name: 'd.txt', bytes: text }]), 16, (dv, o) => dv.setUint32(o, dv.getUint32(o, true) ^ 1, true));
  await rejects(Zip.readZip(badCrc), 'crc');

  // Entry count limit.
  await rejects(Zip.readZip(zip, { maxEntries: 3 }), 'too-many-entries');
  assert.strictEqual((await Zip.readZip(zip, { maxEntries: 4 })).length, 3);

  // Zip bomb: 20 MiB of zeros deflates to a few KiB; refused on ratio.
  const zeros = new Uint8Array(20 * 1024 * 1024);
  const lone = await Zip.writeZip([{ name: 'bomb.bin', bytes: zeros }]);
  assert.ok(lone.length < 100 * 1024);
  await rejects(Zip.readZip(lone), 'archive-ratio');
  // Padded with 4 MiB of incompressible data the archive ratio is fine; the entry ratio still stops it.
  const bomb = await Zip.writeZip([
    { name: 'pad.bin', bytes: new Uint8Array(crypto.randomBytes(4 * 1024 * 1024)) },
    { name: 'bomb.bin', bytes: zeros },
  ]);
  await rejects(Zip.readZip(bomb), 'entry-ratio');
  // Header lies about the unpacked size (says 1): still stopped by the real byte count.
  const liar = Uint8Array.from(bomb);
  const dv = new DataView(liar.buffer);
  for (let i = 0; i < liar.length - 4; i += 1) {
    if (dv.getUint32(i, true) === zeros.length) dv.setUint32(i, 1, true);
  }
  await rejects(Zip.readZip(liar, { maxEntryBytes: 1024 * 1024 * 1024 }), 'entry-ratio');
  // Size limit: incompressible 300 KiB entry against a 100 KiB cap (binary and text caps).
  const big = await Zip.writeZip([{ name: 'big.bin', bytes: new Uint8Array(crypto.randomBytes(300 * 1024)) }]);
  await rejects(Zip.readZip(big, { maxEntryBytes: 100 * 1024 }), 'entry-size');
  const bigText = await Zip.writeZip([{ name: 'big.md', bytes: new Uint8Array(crypto.randomBytes(300 * 1024)) }]);
  await rejects(Zip.readZip(bigText, { maxTextEntryBytes: 100 * 1024 }), 'entry-size');
  assert.strictEqual((await Zip.readZip(bigText, { maxEntryBytes: 100 * 1024 })).length, 1);
  // Total size and whole-archive ratio.
  const many = await Zip.writeZip(Array.from({ length: 4 }, (_, i) => ({
    name: `r${i}.bin`, bytes: new Uint8Array(crypto.randomBytes(100 * 1024)),
  })));
  await rejects(Zip.readZip(many, { maxTotalBytes: 250 * 1024 }), 'total-size');
  const small = await Zip.writeZip(Array.from({ length: 10 }, (_, i) => ({ name: `z${i}.bin`, bytes: new Uint8Array(900 * 1024) })));
  await rejects(Zip.readZip(small), 'archive-ratio');
  await rejects(Zip.readZip(zip, { maxZipBytes: 100 }), 'zip-size');

  // Unsupported features give clear errors.
  const encrypted = patchCentral(stored, 8, (dv, o) => dv.setUint16(o, dv.getUint16(o, true) | 1, true));
  const encErr = await rejects(Zip.readZip(encrypted), 'encrypted');
  assert.ok(/Encrypted/.test(encErr.message));
  await rejects(Zip.readZip(patchCentral(stored, 20, (dv, o) => dv.setUint32(o, 0xffffffff, true))), 'zip64');
  await rejects(Zip.readZip(patchCentral(stored, 10, (dv, o) => dv.setUint16(o, 12, true))), 'method');
  const link = patchCentral(stored, 38, (dv, o) => { dv.setUint32(o, 0xa1ff0000, true); dv.setUint16(o - 34, 0x031e, true); });
  await rejects(Zip.readZip(link), 'symlink');
  await rejects(Zip.readZip(enc('not a zip at all, definitely')), 'not-a-zip');
  await rejects(Zip.readZip(zip.subarray(0, zip.length - 10)), 'not-a-zip');

  console.log('ziplib tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
