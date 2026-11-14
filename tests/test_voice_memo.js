const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const idb = new Map();
const blobs = new Map();
global.addEventListener = () => {};
global.window = global;
const mem = () => ({
  store: {},
  getItem(k) { return k in this.store ? this.store[k] : null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
});
global.localStorage = mem();
global.sessionStorage = mem();
global.NotesIDB = {
  async putItem(row) { idb.set(row.uuid, JSON.parse(JSON.stringify(row))); },
  async deleteItem(u) { idb.delete(u); blobs.delete(u); },
  async loadItems() { return [...idb.values()]; },
  async iterateItems(cb) { for (const r of idb.values()) cb(r); },
  async getItem(u) { return idb.get(u) || null; },
  async putBlob(u, c) { blobs.set(u, c); },
  async getBlob(u) { return blobs.get(u) || ''; },
  async deleteBlob(u) { blobs.delete(u); },
  async getMeta() { return null; },
  async putMeta() {},
};
const syncBodies = [];
global.fetch = async (url, options = {}) => {
  if (options.body) syncBodies.push(options.body);
  return { ok: true, json: async () => ({ items: [], server_time: Date.now() / 1000 }) };
};
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));
const NotesVoiceMemo = require(path.join(jsRoot, 'voicememo.js'));
const NotesPreview = require(path.join(jsRoot, 'preview.js'));

function makeEnv({ types = ['audio/webm;codecs=opus'], deny = null } = {}) {
  const env = { stops: 0, intervals: [], recorders: [] };
  class MR {
    constructor(stream, opts) {
      this.opts = opts;
      this.state = 'inactive';
      this.mimeType = opts.mimeType;
      env.recorders.push(this);
    }
    start() { this.state = 'recording'; }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      this.onstop();
    }
    static isTypeSupported(t) { return types.includes(t); }
  }
  env.MediaRecorder = MR;
  env.navigator = {
    mediaDevices: {
      async getUserMedia(c) {
        assert.deepStrictEqual(c, { audio: true });
        if (deny) throw Object.assign(new Error('x'), { name: deny });
        const track = { stop() { env.stops += 1; } };
        return { getTracks: () => [track] };
      },
    },
  };
  env.setInterval = (f) => { env.intervals.push(f); return env.intervals.length; };
  env.clearInterval = () => {};
  env.now = () => new Date(2026, 10, 14, 9, 5).getTime();
  return env;
}

(async () => {
  assert.strictEqual(NotesVoiceMemo.pickFormat(makeEnv({ types: ['audio/mp4'] }).MediaRecorder).ext, 'm4a');
  assert.strictEqual(NotesVoiceMemo.pickFormat(makeEnv({ types: [] }).MediaRecorder), null);
  assert.ok(NotesVoiceMemo.supportError({ navigator: {}, MediaRecorder: null }));
  assert.ok(NotesVoiceMemo.supportError(makeEnv({ types: [] })));

  {
    const env = makeEnv({ deny: 'NotAllowedError' });
    let msg = '';
    const rec = NotesVoiceMemo.createRecorder(env, { onError: (m) => { msg = m; } });
    assert.strictEqual(await rec.start(), false);
    assert.match(msg, /geweigerd/);
    assert.strictEqual(rec.isRecording(), false);
  }

  let saved = null;
  {
    const env = makeEnv();
    let warns = 0;
    const rec = NotesVoiceMemo.createRecorder(env, {
      onWarn: () => { warns += 1; },
      onSave: (f) => { saved = f; },
    });
    assert.strictEqual(await rec.start(), true);
    env.recorders[0].ondataavailable({ data: new Blob([Buffer.from('RIFF-secret-audio-bytes')]) });
    const tick = env.intervals[0];
    for (let i = 0; i < NotesVoiceMemo.MAX_SECONDS - 1; i += 1) tick();
    assert.strictEqual(rec.isRecording(), true);
    assert.strictEqual(warns, 1);
    tick();
    assert.strictEqual(rec.isRecording(), false, 'stops at max duration');
    assert.strictEqual(env.stops, 1, 'mic tracks stopped');
    assert.strictEqual(warns, 1);
    assert.strictEqual(saved.name, 'spraakmemo-2026-11-14-0905.webm');
    assert.strictEqual(saved.type, 'audio/webm');
  }

  {
    const env = makeEnv();
    let got = false;
    const rec = NotesVoiceMemo.createRecorder(env, { onSave: () => { got = true; } });
    await rec.start();
    env.recorders[0].ondataavailable({ data: new Blob(['x']) });
    rec.cancel();
    assert.strictEqual(env.stops, 1);
    assert.strictEqual(got, false);
  }

  {
    const env = makeEnv();
    const rec = NotesVoiceMemo.createRecorder(env, { onSave() {} });
    await rec.start();
    env.recorders[0].ondataavailable({ data: { size: NotesVoiceMemo.MAX_BYTES } });
    assert.strictEqual(rec.isRecording(), false);
  }

  assert.strictEqual(NotesPreview.kindFromMeta('audio/webm', 'a.webm'), 'audio');
  assert.strictEqual(NotesPreview.kindFromMeta('video/webm', 'a.webm'), 'other');

  await NotesStore.unlock('vault-password', 'salt-1');
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, NotesStore.defaultNote());
  const attId = await NotesStore.addAttachment(noteId, saved, { displayName: saved.name });
  try { await NotesStore.flush(); } catch (_) { /* sync stub */ }
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
  const marker = 'RIFF-secret-audio-bytes';
  const b64 = Buffer.from(marker).toString('base64');
  const everything = JSON.stringify([...idb.values()]) + [...blobs.values()].join('') + syncBodies.join('');
  assert.ok(!everything.includes(marker) && !everything.includes(b64.slice(0, 16)), 'no plaintext audio stored or sent');
  assert.ok(blobs.size >= 1);
  const back = await NotesStore.getAttachmentBytes(attId);
  assert.strictEqual(Buffer.from(back).toString(), marker);
  console.log('voice memo tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
