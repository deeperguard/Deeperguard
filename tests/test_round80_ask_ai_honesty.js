/**
 * Round 80: Ask AI honesty — marketing/verify copy + one-time Ollama Cloud confirm.
 *
 * MUST NOT REGRESS:
 * - SRP sign-in / R73 no-plaintext for auth_method=srp
 * - Auto-unlock
 * - Sync
 * - Attachments
 * - 2FA tab
 * - Lock settings
 * - Device phrase (R74 / R75 / R75.1)
 * - Local Ollama Ask AI (destination consent; no cloud relay warning or ack)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const marketing = fs.readFileSync(path.join(root, 'app/templates/marketing.html'), 'utf8');
const compare = fs.readFileSync(path.join(root, 'app/templates/compare-standard-notes.html'), 'utf8');
const verify = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
const legal = fs.readFileSync(path.join(root, 'app/templates/legal.html'), 'utf8');
const zkPlain = fs.readFileSync(path.join(root, 'app/templates/partials/zk-plain.html'), 'utf8');
const aiChatJs = fs.readFileSync(path.join(root, 'app/static/js/ai-chat.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');

const EXCEPTION = 'except text you choose to send to Ask AI with Ollama Cloud, which passes through our server to ollama.com without being stored';

assert.ok(marketing.includes('<strong>The server cannot read your notes</strong>'));
assert.ok(marketing.includes(EXCEPTION));
assert.ok(
  marketing.includes(
    'The server never receives a readable copy unless you send text to Ask AI with Ollama Cloud.',
  ),
);
assert.ok(marketing.includes('stay unreadable to the host unless sent to Ask AI'));
assert.ok(marketing.includes('Plaintext never touches the server, unless you send text to Ask AI with Ollama Cloud'));
assert.ok(marketing.includes('no server-side copy of the text, unless you send text to Ask AI with Ollama Cloud'));
assert.ok(marketing.includes('Stored notes: no.'));
assert.ok(!marketing.includes('unstored'));
assert.ok(marketing.includes('Can Deeperguard or its host read my notes?'));

assert.ok(compare.includes('Stored notes: no.'));
assert.ok(compare.includes(EXCEPTION));
assert.ok(!compare.includes('unstored'));

assert.ok(verify.includes('never leave your device in plaintext, except text you choose to send to Ask AI with Ollama Cloud'));
assert.ok(verify.includes(EXCEPTION));
assert.ok(!verify.includes('unstored'));
assert.ok(verify.includes('data-claim-version="2"'));

assert.ok(
  zkPlain.includes(
    'we cannot read your notes (unless you send text to Ask AI with Ollama Cloud).',
  ),
);

assert.ok(
  legal.includes(
    'we cannot read note titles, body text, or attachment contents (unless you send text to Ask AI with Ollama Cloud)',
  ),
);

assert.ok(aiChatJs.includes('CLOUD_RELAY_ACK_KEY'));
assert.ok(aiChatJs.includes('ensureCloudRelayConsent'));
assert.ok(
  aiChatJs.includes(
    "Our server doesn't store your API key, the prompt or the answer. Ollama has its own terms.",
  ),
);
assert.ok(aiChatJs.includes("confirmLabel: 'Send'"));
assert.ok(aiChatJs.includes("cancelLabel: 'Cancel'"));
assert.ok(appJs.includes('confirm: (message, options) => confirmAction(message, options)'));

const NotesAiChat = require(path.join(root, 'app/static/js/ai-chat.js'));

function memStorage(seed = {}) {
  const data = { ...seed };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _data: data,
  };
}

async function main() {
  assert.ok(NotesAiChat.isCloudHost('https://ollama.com'));
  assert.ok(!NotesAiChat.isCloudHost('http://127.0.0.1:11434'));

  const prevConfirm = global.confirm;
  global.confirm = () => true;

  const store = memStorage();
  let localConfirms = 0;
  NotesAiChat.init({
    storage: store,
    confirm: async (msg) => {
      localConfirms += 1;
      assert.ok(!/our server to ollama\.com/i.test(msg), 'local consent text has no cloud relay warning');
      return true;
    },
  });
  assert.strictEqual(store.getItem(NotesAiChat.CONSENT_RECORD_KEY), null, 'local starts without consent');
  assert.strictEqual(await NotesAiChat.ensureCloudRelayConsent({ host: 'http://localhost:11434' }), true);
  assert.ok(localConfirms >= 1, 'local Ollama prompts for destination consent');
  assert.ok(store.getItem(NotesAiChat.CONSENT_RECORD_KEY), 'local consent is recorded');
  assert.strictEqual(store.getItem(NotesAiChat.CLOUD_RELAY_ACK_KEY), null, 'local settings check does not cloud-ack');

  const cloudStore = memStorage();
  NotesAiChat.init({
    storage: cloudStore,
    confirm: async () => true,
    promptOutboundSend: async () => true,
  });
  assert.strictEqual(await NotesAiChat.ensureCloudRelayConsent({ host: 'https://ollama.com' }), true);
  const cloudRecord = JSON.parse(cloudStore.getItem(NotesAiChat.CONSENT_RECORD_KEY));
  assert.strictEqual(cloudRecord.destination, 'cloud:https://ollama.com');

  assert.strictEqual(await NotesAiChat.ensureCloudRelayConsent({ host: 'https://ollama.com' }), true);

  const cancelStore = memStorage();
  NotesAiChat.init({ storage: cancelStore, promptOutboundSend: async () => false });
  global.confirm = () => false;
  assert.strictEqual(await NotesAiChat.ensureCloudRelayConsent({ host: 'https://ollama.com' }), false);
  assert.strictEqual(cancelStore.getItem(NotesAiChat.CONSENT_RECORD_KEY), null, 'cancel does not persist consent');

  global.confirm = prevConfirm;

  console.log('test_round80_ask_ai_honesty ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
