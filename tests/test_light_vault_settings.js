const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const idb = new Map();
const blobs = new Map();

global.addEventListener = () => {};
global.window = global;
const memStorage = () => ({
  store: {},
  getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null; },
  setItem(key, value) { this.store[key] = String(value); },
  removeItem(key) { delete this.store[key]; },
});
global.localStorage = memStorage();
global.sessionStorage = memStorage();
global.NotesIDB = {
  async putItem(row) { idb.set(row.uuid, JSON.parse(JSON.stringify(row))); },
  async deleteItem(uuid) { idb.delete(uuid); blobs.delete(uuid); },
  async loadItems() { return [...idb.values()]; },
  async iterateItems(onRow) { for (const row of idb.values()) onRow(row); },
  async getItem(uuid) { return idb.get(uuid) || null; },
  async putBlob(uuid, blobCiphertext) { blobs.set(uuid, blobCiphertext); },
  async getBlob(uuid) { return blobs.get(uuid) || ''; },
  async deleteBlob(uuid) { blobs.delete(uuid); },
  async getMeta() { return null; },
  async putMeta() {},
};

const requests = [];
let serverBlob = '';
global.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : {};
  requests.push({ url: String(url), body });
  if (String(url).endsWith('/api/sync/blobs')) {
    return {
      ok: true,
      json: async () => ({ blobs: body.uuids.map((uuid) => ({ item_uuid: uuid, blob_ciphertext: serverBlob })) }),
    };
  }
  return { ok: true, json: async () => ({ items: [], server_time: Date.now() / 1000 }) };
};
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));

vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));
const NotesAiChat = require(path.join(jsRoot, 'ai-chat.js'));

function fakeFile(text, name = 'scan.txt', type = 'text/plain') {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
  await NotesStore.unlock('vault-password', 'salt-1');
  const noteId = NotesStore.newUuid();
  NotesStore.upsert(noteId, { ...NotesStore.defaultNote(), title: 'Invoice', content: 'Pay 42 EUR by Friday' });

  /* ---- light vault: on-demand attachment download ---- */
  const secret = 'light-vault-bytes';
  const attId = await NotesStore.addAttachment(noteId, fakeFile(secret, 'scan.txt'));
  await settle();
  assert.strictEqual(await NotesStore.hasLocalAttachmentBytes(attId), true);
  serverBlob = blobs.get(attId);
  assert.ok(serverBlob, 'blob persisted locally');

  NotesStore.state.dirty.clear();
  const removed = await NotesStore.purgeLocalAttachmentBytes();
  assert.strictEqual(removed, 1, 'purge drops the downloaded file');
  assert.strictEqual(await NotesStore.hasLocalAttachmentBytes(attId), false);
  assert.strictEqual(NotesStore.get(attId).content.file_enc_stored, true, 'metadata still marks the blob as stored remotely');

  NotesStore.setLightVault(true);
  assert.strictEqual(NotesStore.lightVaultEnabled(), true);
  const before = requests.length;
  const fetched = await NotesStore.ensureNoteAttachmentsLocal(noteId);
  assert.strictEqual(fetched, 1, 'opening the note downloads its file');
  assert.ok(requests.slice(before).some((r) => r.url.endsWith('/api/sync/blobs')), 'blob fetched from server');
  assert.strictEqual(await NotesStore.hasLocalAttachmentBytes(attId), true, 'downloaded file is persisted for offline use');
  const bytes = await NotesStore.getAttachmentBytes(attId);
  assert.strictEqual(new TextDecoder().decode(bytes), secret);
  assert.strictEqual(await NotesStore.ensureNoteAttachmentsLocal(noteId), 0, 'second open does not re-download');

  // Pull in light mode must not ask the server to inline blobs.
  requests.length = 0;
  await NotesStore.sync({ quiet: true, full: true }).catch(() => {});
  const pull = requests.find((r) => r.url.endsWith('/api/sync/pull'));
  assert.ok(pull, 'sync pulled');
  assert.strictEqual(Number(pull.body.include_blobs), 0, 'light vault never inlines blobs on pull');

  /* ---- account-wide settings item ---- */
  assert.strictEqual(NotesStore.getGlobalSettings(), null);
  assert.strictEqual(NotesStore.saveGlobalSettings({ hidePreviews: true, sort: 'title' }), true);
  const saved = NotesStore.getGlobalSettings();
  assert.ok(saved && saved.uuid, 'settings item created');
  assert.deepStrictEqual(saved.prefs, { hidePreviews: true, sort: 'title' });
  assert.strictEqual(NotesStore.saveGlobalSettings({ hidePreviews: true, sort: 'title' }), false, 'identical prefs do not create churn');
  assert.strictEqual(NotesStore.saveGlobalSettings({ hidePreviews: false, sort: 'title' }), true);
  assert.strictEqual(NotesStore.getGlobalSettings().uuid, saved.uuid, 'same item is reused');
  assert.strictEqual(NotesStore.getGlobalSettings().prefs.hidePreviews, false);
  assert.ok(!NotesStore.listNotes().some((n) => n.content.type === 'settings'), 'settings never show up as notes');
  await settle();
  const row = idb.get(saved.uuid);
  assert.ok(row && row.ciphertext, 'settings persisted encrypted');
  assert.ok(!JSON.stringify(row).includes('hidePreviews'), 'settings plaintext never hits storage');

  /* ---- AI chat: minimal payload ---- */
  const note = NotesStore.get(noteId);
  const atts = NotesStore.listAttachments(noteId).map((a) => ({ ...a, content: { ...a.content, ocr_text: 'Scanned: total 42 EUR', filename: 'secret-name.pdf' } }));
  const ctx = NotesAiChat.buildContext(note, atts, { includeOcr: true });
  assert.ok(ctx.includes('Invoice') && ctx.includes('Pay 42 EUR'), 'title and body included');
  assert.ok(ctx.includes('Scanned: total 42 EUR'), 'ocr text included when enabled');
  assert.ok(!ctx.includes('secret-name.pdf'), 'file names are not sent');
  assert.ok(!NotesAiChat.buildContext(note, atts, { includeOcr: false }).includes('Scanned:'), 'ocr excluded when disabled');
  const longNote = { content: { title: 't', content: 'x'.repeat(50000) } };
  assert.ok(NotesAiChat.buildContext(longNote, []).length <= NotesAiChat.MAX_CONTEXT_CHARS, 'context is capped');

  const body = NotesAiChat.requestBody({ model: 'gpt-oss:120b', context: ctx, history: [], question: 'How much?' });
  assert.strictEqual(body.model, 'gpt-oss:120b');
  assert.strictEqual(body.stream, false, 'single JSON answer, no streaming');
  assert.strictEqual(body.messages[0].role, 'system');
  assert.strictEqual(body.messages.at(-1).content, 'How much?');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('vault-password') && !serialized.includes(noteId), 'no vault secrets or ids leak');
  assert.ok(!serialized.includes('provider'), 'no OpenRouter-specific fields');

  /* ---- settings normalisation / migration from OpenRouter ---- */
  const cloudCfg = NotesAiChat.normalizeSettings({ apiKey: 'sk-or-v1-old', model: 'openai/gpt-4o-mini' });
  assert.strictEqual(cloudCfg.host, 'https://ollama.com');
  assert.strictEqual(cloudCfg.apiKey, '', 'leftover OpenRouter key is dropped');
  assert.strictEqual(cloudCfg.model, NotesAiChat.DEFAULT_MODEL, 'vendor/model names fall back to the default cloud model');
  assert.strictEqual(NotesAiChat.DEFAULT_MODEL, 'gpt-oss:120b');
  assert.strictEqual(NotesAiChat.normalizeSettings({ model: 'gpt-oss:120b-cloud' }).model, 'gpt-oss:120b', '-cloud suffix stripped for ollama.com');
  const localCfg = NotesAiChat.normalizeSettings({ host: 'ollama.lan:11434/', model: 'gemma4:31b-cloud' });
  assert.strictEqual(localCfg.host, 'https://ollama.lan:11434');
  assert.strictEqual(localCfg.model, 'gemma4:31b-cloud', 'local names untouched');
  assert.ok(!NotesAiChat.isConfigured({}), 'cloud without key is not configured');
  assert.ok(NotesAiChat.isConfigured({ apiKey: 'olk' }));
  assert.ok(NotesAiChat.isConfigured({ host: 'http://localhost:11434' }), 'own server needs no key');

  /* ---- Ollama Cloud goes through the same-origin relay (ollama.com has no CORS) ---- */
  let seen = null;
  const answer = await NotesAiChat.ask({
    apiKey: 'ollama-key',
    model: 'gpt-oss:120b',
    context: ctx,
    history: [],
    question: 'How much?',
    csrf: 'csrf-1',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 200, json: async () => ({ message: { role: 'assistant', content: '42 EUR' } }) };
    },
  });
  assert.strictEqual(answer, '42 EUR');
  assert.strictEqual(seen.url, '/api/ai/ollama/chat');
  assert.strictEqual(seen.options.headers['X-Ollama-Key'], 'ollama-key');
  assert.strictEqual(seen.options.headers['X-CSRF-Token'], 'csrf-1');
  assert.strictEqual(seen.options.headers.Authorization, undefined);
  assert.strictEqual(seen.options.credentials, 'same-origin');
  assert.strictEqual(JSON.parse(seen.options.body).model, 'gpt-oss:120b');
  await assert.rejects(() => NotesAiChat.ask({ apiKey: '', question: 'q' }), /API key/);
  await assert.rejects(
    () => NotesAiChat.ask({ apiKey: 'k', question: 'q', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized', upstream: true }) }) }),
    /Ollama Cloud rejected this API key/,
  );
  await assert.rejects(
    () => NotesAiChat.ask({ apiKey: 'k', question: 'q', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'login required' }) }) }),
    /session expired/,
  );

  /* ---- self-hosted Ollama is called directly ---- */
  seen = null;
  await NotesAiChat.ask({
    host: 'https://ollama.lan',
    apiKey: 'local-key',
    model: 'gemma4:31b',
    context: ctx,
    question: 'q',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 200, json: async () => ({ message: { content: 'ok' } }) };
    },
  });
  assert.strictEqual(seen.url, 'https://ollama.lan/api/chat');
  assert.strictEqual(seen.options.headers.Authorization, 'Bearer local-key');
  assert.strictEqual(seen.options.headers['X-Ollama-Key'], undefined);
  assert.strictEqual(seen.options.credentials, 'omit');
  assert.strictEqual(seen.options.referrerPolicy, 'no-referrer');

  /* ---- connection check (no note content leaves the device) ---- */
  const calls = [];
  const info = await NotesAiChat.checkKey({ apiKey: 'ollama-key', model: 'gpt-oss:120b' }, {
    csrf: 'csrf-1',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/ps')) return { ok: true, status: 200, json: async () => ({ models: [] }) };
      return { ok: true, status: 200, json: async () => ({ models: [{ name: 'gpt-oss:120b' }, { name: 'gemma4:31b' }] }) };
    },
  });
  assert.deepStrictEqual(calls.map((c) => c.url), ['/api/ai/ollama/ps', '/api/ai/ollama/tags']);
  assert.ok(calls.every((c) => c.options.method === 'GET' && c.options.body === undefined), 'check sends no body');
  assert.strictEqual(info.modelAvailable, true);
  assert.ok(NotesAiChat.describeKeyCheck(info).includes('Key accepted by Ollama Cloud'));
  assert.ok(NotesAiChat.describeKeyCheck({ ...info, model: 'nope', modelAvailable: false }).includes('not found'));
  await assert.rejects(
    () => NotesAiChat.checkKey({ apiKey: 'dead' }, {
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized', upstream: true }) }),
    }),
    /Ollama Cloud rejected this API key/,
  );
  await assert.rejects(() => NotesAiChat.checkKey({ apiKey: '' }), /Enter an Ollama API key/);

  console.log('light vault + global settings + ai chat OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
