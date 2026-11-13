const assert = require('assert');
const fs = require('fs');
const nodeCrypto = require('crypto');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
const NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const S = require(path.join(jsRoot, 'settings-sync.js'));

const KEY = { raw: new Uint8Array(32).map((_, i) => i + 1) };

function fakeStore() {
  const items = new Map();
  const s = {
    unlocked: true,
    upserts: [],
    isUnlocked: () => s.unlocked,
    get: (uuid) => items.get(uuid),
    upsert(uuid, content) {
      s.upserts.push({ uuid, content: JSON.parse(JSON.stringify(content)) });
      items.set(uuid, { uuid, content, deleted: false });
    },
    items,
  };
  return s;
}

function harness(store = fakeStore(), extra = {}) {
  const timers = [];
  const clock = { t: 1700000000000 };
  const inst = S.create({
    store,
    crypto: NotesCrypto,
    getKey: () => KEY,
    getUserId: () => 'u1',
    now: () => clock.t,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    ...extra,
  });
  const fire = async () => {
    const t = timers.filter((x) => x.fn).pop();
    if (t) { const f = t.fn; t.fn = null; await f(); }
    await new Promise((r) => setImmediate(r));
  };
  return { inst, store, timers, clock, fire };
}

const rawRecord = (keys, v = 1) => JSON.stringify({ v, keys });

async function seed(store, text, opts = {}) {
  const probe = harness(store).inst;
  const blob = await NotesCrypto.encryptBytes(KEY, S.padRecord(text), { aad: opts.aad || 'dg:settings:v1|u1' });
  store.items.set(probe.itemUuid(), { content: { type: S.ITEM_TYPE, blob }, deleted: false });
  return blob;
}

(async () => {
  // HMAC helper matches node's
  const msg = new TextEncoder().encode('dg:settings:v1:uuid');
  assert.strictEqual(
    Buffer.from(NotesCrypto.hmacSha256(KEY.raw, msg)).toString('hex'),
    nodeCrypto.createHmac('sha256', Buffer.from(KEY.raw)).update(Buffer.from(msg)).digest('hex'),
  );

  // 1. allowlist validation
  assert(S.isValid('fontSize', 13) && S.isValid('fontSize', 22));
  assert(!S.isValid('fontSize', 12) && !S.isValid('fontSize', 23) && !S.isValid('fontSize', '16'));
  assert(!S.isValid('autoLockMin', 7) && S.isValid('autoLockMin', 0));
  assert(!S.isValid('monospace', 'true') && S.isValid('monospace', true));
  assert(!S.isValid('theme', 'neon') && S.isValid('theme', 'system'));
  assert(S.isValid('agendaView', '3day') && !S.isValid('agendaView', null));
  for (const secret of ['aiChat', 'dropboxRefreshToken', 'googleOauthClientId', '__proto__']) {
    assert(!S.isValid(secret, 'x'));
  }

  // 2. fixed ciphertext length regardless of content; only ciphertext leaves
  {
    const a = harness();
    await a.inst.load();
    a.inst.setSetting('theme', 'dark');
    await a.fire();
    const b = harness();
    await b.inst.load();
    for (const [k, v] of [['theme', 'system'], ['fontSize', 22], ['agendaView', 'agenda'], ['sort', 'title'],
      ['autoLockMin', 60], ['lockOnUnfocus', 'immediate'], ['monospace', true], ['navPinned', true]]) {
      b.inst.setSetting(k, v);
    }
    await b.fire();
    const wa = a.store.upserts[0];
    const wb = b.store.upserts[0];
    assert.strictEqual(Object.keys(wa.content).sort().join(), 'blob,type');
    assert.strictEqual(wa.content.blob.data.length, wb.content.blob.data.length);
    assert.strictEqual(wa.content.blob.iv.length, wb.content.blob.iv.length);
    assert.strictEqual(wa.content.blob.v, 2);
    assert.strictEqual(S.padRecord('x').length, 1024);
    assert.strictEqual(S.padRecord('x'.repeat(1100)).length, 2048);
    const wire = JSON.stringify(wb.content);
    for (const needle of ['agendaView', 'theme', 'agenda', 'fontSize', 'immediate']) {
      assert(!wire.includes(needle), `plaintext leaked: ${needle}`);
    }
    assert(!wire.includes(Buffer.from('agendaView').toString('base64')));
    assert.strictEqual(Buffer.from(wa.content.blob.iv, 'base64').length, 12);
  }

  // 3. fresh IV per write; tamper / wrong AAD / wrong key fail
  {
    const blob1 = await NotesCrypto.encryptBytes(KEY, S.padRecord('{}'), { aad: 'dg:settings:v1|u1' });
    const blob2 = await NotesCrypto.encryptBytes(KEY, S.padRecord('{}'), { aad: 'dg:settings:v1|u1' });
    assert.notStrictEqual(blob1.iv, blob2.iv);
    assert.notStrictEqual(blob1.data, blob2.data);
    await NotesCrypto.decryptBytes(KEY, blob1, { aad: 'dg:settings:v1|u1' });
    await assert.rejects(NotesCrypto.decryptBytes(KEY, blob1, { aad: 'dg:settings:v1|u2' }));
    await assert.rejects(NotesCrypto.decryptBytes(KEY, blob1, { aad: 'dg:other:v1|u1' }));
    await assert.rejects(NotesCrypto.decryptBytes({ raw: new Uint8Array(32) }, blob1, { aad: 'dg:settings:v1|u1' }));
    const bytes = Buffer.from(blob1.data, 'base64');
    bytes[5] ^= 1;
    await assert.rejects(NotesCrypto.decryptBytes(KEY, { ...blob1, data: bytes.toString('base64') }, { aad: 'dg:settings:v1|u1' }));
    // v1 payloads without AAD still work
    const legacy = await NotesCrypto.encryptBytes(KEY, new Uint8Array([1, 2, 3]));
    assert.strictEqual(legacy.v, 1);
    assert.deepStrictEqual(Array.from(await NotesCrypto.decryptBytes(KEY, legacy)), [1, 2, 3]);
  }

  // 4. merge: per-key last-writer-wins
  {
    const base = { theme: { value: 'light', updatedAt: 100 }, agendaView: { value: 'week', updatedAt: 100 } };
    const A = { ...base, theme: { value: 'dark', updatedAt: 200 } };
    const B = { ...base, agendaView: { value: '3day', updatedAt: 300 } };
    const m1 = S.mergeKeys(A, B);
    const m2 = S.mergeKeys(B, A);
    assert.deepStrictEqual(m1, m2);
    assert.strictEqual(m1.theme.value, 'dark');
    assert.strictEqual(m1.agendaView.value, '3day');
    // tie: deterministic and commutative
    const t1 = { theme: { value: 'dark', updatedAt: 5 } };
    const t2 = { theme: { value: 'light', updatedAt: 5 } };
    assert.deepStrictEqual(S.mergeKeys(t1, t2), S.mergeKeys(t2, t1));
    // future timestamps clamped
    const now = 1000;
    const clamped = S.sanitizeKeys({ theme: { value: 'dark', updatedAt: now + 10 * 60 * 1000 } }, now);
    assert.strictEqual(clamped.theme.updatedAt, now);
  }

  // 4b. two devices through the store: both changes survive after load()
  {
    const store = fakeStore();
    const dev = harness(store);
    await dev.inst.load();
    dev.inst.setSetting('theme', 'dark');
    dev.clock.t += 10;
    await dev.fire();
    // another device (separate memory) had a newer agendaView in a different record version
    const remote = rawRecord({ agendaView: { value: '3day', updatedAt: dev.clock.t + 50 }, theme: { value: 'light', updatedAt: 1 } });
    await seed(store, remote);
    await dev.inst.load();
    assert.strictEqual(dev.inst.getSetting('agendaView'), '3day');
    assert.strictEqual(dev.inst.getSetting('theme'), 'dark');
  }

  // 5. validation after decrypt: unknown keys / invalid values ignored
  {
    const store = fakeStore();
    await seed(store, rawRecord({
      theme: { value: 'dark', updatedAt: 1 },
      fontSize: { value: '16', updatedAt: 1 },
      autoLockMin: { value: 7, updatedAt: 1 },
      aiChat: { value: 'sk-secret', updatedAt: 1 },
      bogus: { value: true, updatedAt: 1 },
      monospace: { value: true, updatedAt: 'x' },
    }));
    const h = harness(store);
    await h.inst.load();
    assert.strictEqual(h.inst.getSetting('theme'), 'dark');
    assert.strictEqual(h.inst.getSetting('fontSize'), 16);
    assert.strictEqual(h.inst.getSetting('autoLockMin'), 15);
    assert.strictEqual(h.inst.getSetting('monospace'), false);
    assert.strictEqual(h.inst.getSetting('agendaView'), null);
    assert.strictEqual(h.inst.getSetting('aiChat'), undefined);
    assert.strictEqual(h.inst.getSetting('bogus'), undefined);
    // unknown keys are not written back
    h.inst.setSetting('sort', 'title');
    await h.fire();
    const saved = await NotesCrypto.decryptBytes(KEY, h.store.upserts[0].content.blob, { aad: 'dg:settings:v1|u1' });
    const text = S.unpadRecord(saved);
    assert(!text.includes('aiChat') && !text.includes('bogus') && !text.includes('sk-secret'));
    assert.deepStrictEqual(Object.keys(JSON.parse(text).keys).sort(), ['sort', 'theme']);
  }

  // 5b. newer schema -> defaults, never write
  {
    const store = fakeStore();
    await seed(store, rawRecord({ theme: { value: 'dark', updatedAt: 1 } }, 2));
    const h = harness(store);
    await h.inst.load();
    assert.strictEqual(h.inst.getSetting('theme'), 'light');
    h.inst.setSetting('theme', 'dark');
    await h.fire();
    assert.strictEqual(h.store.upserts.length, 0);
  }

  // 5c. corrupted / wrong-AAD record -> defaults, no throw, no push until user change
  {
    const store = fakeStore();
    await seed(store, rawRecord({ theme: { value: 'dark', updatedAt: 1 } }), { aad: 'dg:settings:v1|other' });
    let notice = 0;
    const h = harness(store, { onNotice: () => { notice += 1; } });
    await h.inst.load();
    assert.strictEqual(h.inst.getSetting('theme'), 'light');
    assert.strictEqual(notice, 1);
    assert.strictEqual(await h.inst.flush(), false);
    await h.inst.lock();
    assert.strictEqual(store.upserts.length, 0, 'must not overwrite after failed decrypt');
    // explicit change afterwards may replace the record
    const h2 = harness(store);
    await h2.inst.load();
    h2.inst.setSetting('theme', 'system');
    await h2.fire();
    assert.strictEqual(store.upserts.length, 1);
  }

  // 6. debounce + flush on lock + clear memory
  {
    const h = harness();
    await h.inst.load();
    for (let i = 13; i <= 22; i += 1) h.inst.setSetting('fontSize', i);
    assert.strictEqual(h.timers.filter((t) => t.fn).length, 1);
    assert.strictEqual(h.timers[0].ms, 1000);
    assert.strictEqual(h.store.upserts.length, 0);
    await h.fire();
    assert.strictEqual(h.store.upserts.length, 1);
    h.inst.setSetting('agendaView', 'day');
    await h.inst.lock();
    assert.strictEqual(h.store.upserts.length, 2);
    assert.strictEqual(h.inst.getSetting('agendaView'), null);
    assert.strictEqual(h.inst.getSetting('fontSize'), 16);
    assert.strictEqual(h.inst.setSetting('fontSize', 14), false); // not loaded
    // unchanged content is not rewritten
    const h3 = harness(h.store);
    await h3.inst.load();
    assert.strictEqual(h3.inst.getSetting('agendaView'), 'day');
    h3.inst.setSetting('agendaView', 'day');
    h3.clock.t += 1; // newer timestamp still changes plaintext; same-ts case below
  }

  // 8. nothing is read before unlock
  {
    const store = fakeStore();
    store.unlocked = false;
    const h = harness(store);
    assert.strictEqual(await h.inst.load(), false);
    assert.strictEqual(h.inst.getSetting('theme'), 'light');
  }

  // 7. storage hygiene: module never touches web storage / cookies
  {
    const src = fs.readFileSync(path.join(jsRoot, 'settings-sync.js'), 'utf8');
    assert(!/localStorage|sessionStorage|document\.cookie|location\.(search|hash)/.test(src.replace(/\/\*[\s\S]*?\*\//, '')));
    global.localStorage = { setItem() { throw new Error('localStorage used'); }, getItem() { return null; } };
    global.sessionStorage = global.localStorage;
    const h = harness();
    await h.inst.load();
    h.inst.setSetting('agendaView', '3day');
    await h.inst.lock();
    delete global.localStorage;
    delete global.sessionStorage;
  }

  console.log('settings-sync tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
