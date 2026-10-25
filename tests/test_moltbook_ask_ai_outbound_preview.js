/**
 * Moltbook / Ask AI: Ollama Cloud outbound preview before each send.
 *
 * MUST NOT REGRESS: Round 80 one-time relay ack (ensureCloudRelayConsent).
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

const note = {
  content: {
    title: 'Invoice',
    content: 'Amount due: 42 EUR',
  },
};

const attOcr = [{ content: { ocr_text: 'Scan line 1' } }];

async function main() {
  const preview = NotesAiChat.formatOutboundPreview(
    NotesAiChat.requestBody({
      model: 'gpt-oss:120b',
      context: 'Title: Invoice\n\nNote:\nAmount due: 42 EUR',
      history: [],
      question: 'How much?',
    }),
  );
  assert.ok(preview.includes('[user]\nHow much?'));
  assert.ok(preview.includes('Amount due: 42 EUR'));
  assert.ok(preview.includes('--- NOTE ---'));

  const cloudRoute = NotesAiChat.describeOutboundRoute({ host: 'https://ollama.com' });
  assert.ok(cloudRoute.cloud);
  assert.ok(cloudRoute.label.includes('goes through our server to ollama.com'));

  const localRoute = NotesAiChat.describeOutboundRoute({ host: 'http://127.0.0.1:11434' });
  assert.ok(!localRoute.cloud);
  assert.ok(!localRoute.label.includes('ollama.com'));
  assert.ok(localRoute.label.includes('directly'));

  const sens = NotesAiChat.classifyOutboundContent(note, attOcr, { includeOcr: true });
  assert.strictEqual(sens.noteText, true);
  assert.strictEqual(sens.ocrText, true);

  const store = memStorage();
  const prompts = [];
  NotesAiChat.init({
    storage: store,
    promptOutboundSend: async (plan) => {
      prompts.push(plan);
      return true;
    },
    confirm: async () => {
      throw new Error('ensureCloudRelayConsent should not use confirm when promptOutboundSend is set');
    },
  });

  const okLocal = await NotesAiChat.ensureCloudSendConsent({
    cfg: { host: 'http://localhost:11434' },
    note,
    attachments: [],
    includeOcr: true,
    question: 'Hi',
    history: [],
    model: 'llama3',
  });
  assert.strictEqual(okLocal, true);
  assert.strictEqual(prompts.length, 0, 'local host skips outbound preview');

  const okCloud = await NotesAiChat.ensureCloudSendConsent({
    cfg: { host: 'https://ollama.com', apiKey: 'k', model: 'gpt-oss:120b' },
    note,
    attachments: attOcr,
    includeOcr: true,
    question: 'How much?',
    history: [],
    model: 'gpt-oss:120b',
  });
  assert.strictEqual(okCloud, true);
  assert.strictEqual(prompts.length, 1);
  assert.strictEqual(prompts[0].route.label, NotesAiChat.CLOUD_ROUTE_LABEL);
  assert.ok(prompts[0].preview.includes('How much?'));
  assert.ok(prompts[0].preview.includes('Scan line 1'));
  assert.strictEqual(prompts[0].loud, true);
  assert.ok(prompts[0].warnLines.some((l) => l.includes("Deeperguard's server to ollama.com")));
  assert.ok(prompts[0].warnLines.includes(NotesAiChat.CONTENT_WARN_NOTE));
  assert.ok(prompts[0].warnLines.includes(NotesAiChat.CONTENT_WARN_OCR));
  assert.strictEqual(store.getItem(NotesAiChat.CLOUD_RELAY_ACK_KEY), '1');
  const ack = JSON.parse(store.getItem(NotesAiChat.CLOUD_CONTENT_ACK_KEY));
  assert.deepStrictEqual(ack, { note: true, ocr: true });

  const okAgain = await NotesAiChat.ensureCloudSendConsent({
    cfg: { host: 'https://ollama.com', apiKey: 'k', model: 'gpt-oss:120b' },
    note,
    attachments: attOcr,
    includeOcr: true,
    question: 'Again?',
    history: [],
    model: 'gpt-oss:120b',
  });
  assert.strictEqual(okAgain, true);
  assert.strictEqual(prompts.length, 2, 'every cloud send shows preview');
  assert.strictEqual(prompts[1].loud, false, 'acked relay + content is not loud');
  assert.strictEqual(prompts[1].warnLines.length, 0);

  const emptyNote = { content: { title: '', content: '' } };
  const ocrOnlyStore = memStorage({ [NotesAiChat.CLOUD_RELAY_ACK_KEY]: '1', [NotesAiChat.CLOUD_CONTENT_ACK_KEY]: '{}' });
  const ocrPrompts = [];
  NotesAiChat.init({
    storage: ocrOnlyStore,
    promptOutboundSend: async (plan) => {
      ocrPrompts.push(plan);
      return true;
    },
  });
  await NotesAiChat.ensureCloudSendConsent({
    cfg: { host: 'https://ollama.com', apiKey: 'k' },
    note: emptyNote,
    attachments: attOcr,
    includeOcr: true,
    question: 'Read scan',
    history: [],
    model: 'gpt-oss:120b',
  });
  assert.strictEqual(ocrPrompts.length, 1);
  assert.strictEqual(ocrPrompts[0].loud, true);
  assert.ok(ocrPrompts[0].warnLines.includes(NotesAiChat.CONTENT_WARN_OCR));
  assert.ok(!ocrPrompts[0].warnLines.some((l) => l.includes('Send?')));

  console.log('test_moltbook_ask_ai_outbound_preview ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
