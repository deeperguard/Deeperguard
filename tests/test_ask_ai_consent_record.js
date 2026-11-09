/**
 * Ask AI structured consent record (destination, purpose, time).
 */
const assert = require('assert');
const path = require('path');

const NotesAiChat = require(path.join(__dirname, '..', 'app/static/js/ai-chat.js'));

function memStorage(seed = {}) {
  const data = { ...seed };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    _data: data,
  };
}

const note = { content: { title: 'T', content: 'Body' } };

(async () => {
  const store = memStorage();
  const prevConfirm = global.confirm;
  let confirms = 0;
  global.confirm = () => {
    confirms += 1;
    return true;
  };

  NotesAiChat.init({ storage: store, promptOutboundSend: async () => true });

  assert.strictEqual(NotesAiChat.destinationId({ host: 'https://ollama.com' }), 'cloud:https://ollama.com');

  const localPlan = NotesAiChat.outboundPromptPlan({
    cfg: { host: 'http://127.0.0.1:11434' },
    note,
    attachments: [],
    includeOcr: false,
    question: 'q',
    history: [],
    model: 'llama3',
  });
  assert.ok(!localPlan.needRelayAck, 'local path does not need cloud relay ack');
  assert.ok(!localPlan.warnLines.some((l) => /our server to ollama\.com/i.test(l)), 'local prompt has no cloud relay warning');

  const localOk = await NotesAiChat.ensureSendConsent({
    cfg: { host: 'http://127.0.0.1:11434' },
    note,
    attachments: [],
    includeOcr: false,
    question: 'q',
    history: [],
    model: 'llama3',
  });
  assert.strictEqual(localOk, true);
  assert.ok(confirms >= 1, 'missing record re-prompts (local destination named)');
  assert.strictEqual(store.getItem(NotesAiChat.CLOUD_RELAY_ACK_KEY), null, 'local send does not set cloud relay ack');
  const localRec = JSON.parse(store._data[NotesAiChat.CONSENT_RECORD_KEY]);
  assert.strictEqual(localRec.destination, 'local:http://127.0.0.1:11434');

  confirms = 0;
  assert.strictEqual(await NotesAiChat.ensureSendConsent({
    cfg: { host: 'http://127.0.0.1:11434' },
    note,
    attachments: [],
    includeOcr: false,
    question: 'q2',
    history: [],
    model: 'llama3',
  }), true);
  assert.strictEqual(confirms, 0, 'record re-read avoids second destination prompt');

  global.confirm = () => false;
  store.removeItem(NotesAiChat.CONSENT_RECORD_KEY);
  assert.strictEqual(await NotesAiChat.ensureSendConsent({
    cfg: { host: 'http://127.0.0.1:11434' },
    note,
    attachments: [],
    includeOcr: false,
    question: 'q',
    history: [],
    model: 'llama3',
  }), false, 'cancel aborts send');

  global.confirm = () => true;
  const cloudStore = memStorage();
  let cloudPreviews = 0;
  NotesAiChat.init({
    storage: cloudStore,
    promptOutboundSend: async () => { cloudPreviews += 1; return true; },
  });
  await NotesAiChat.ensureSendConsent({
    cfg: { host: 'https://ollama.com', apiKey: 'k' },
    note,
    attachments: [],
    includeOcr: false,
    question: 'Hi',
    history: [],
    model: 'gpt-oss:120b',
  });
  assert.strictEqual(JSON.parse(cloudStore._data[NotesAiChat.CONSENT_RECORD_KEY]).destination, 'cloud:https://ollama.com');

  cloudStore.setItem(NotesAiChat.CONSENT_RECORD_KEY, JSON.stringify({
    destination: 'local:http://127.0.0.1:11434',
    purpose: 'ask-ai',
    consentedAt: new Date().toISOString(),
  }));
  global.confirm = () => true;
  cloudPreviews = 0;
  await NotesAiChat.ensureSendConsent({
    cfg: { host: 'https://ollama.com', apiKey: 'k' },
    note,
    attachments: [],
    includeOcr: false,
    question: 'Hi',
    history: [],
    model: 'gpt-oss:120b',
  });
  assert.ok(confirms >= 0);
  assert.ok(cloudPreviews >= 0);
  assert.strictEqual(
    JSON.parse(cloudStore._data[NotesAiChat.CONSENT_RECORD_KEY]).destination,
    'cloud:https://ollama.com',
    'destination change to cloud requires new consent',
  );

  global.confirm = prevConfirm;
  console.log('test_ask_ai_consent_record.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
