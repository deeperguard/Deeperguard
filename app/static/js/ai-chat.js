// Chat with the open note through Ollama (ollama.com cloud models by default,
// or a self-hosted Ollama server) using the user's own API key.
//
// Privacy model (deliberately narrow):
//   * Only the note the user is looking at is sent: its title, body and — if
//     enabled — the scanned text of its attachments. Never other notes, tags,
//     filenames, e-mail address, or the vault password.
//   * Self-hosted Ollama: the request goes straight from the browser to that
//     server (Ollama answers CORS when OLLAMA_ORIGINS allows this origin).
//   * Ollama Cloud: ollama.com sends no CORS headers, so the Deeperguard
//     server relays the request (/api/ai/ollama/*) with the user's key. The
//     relay forwards and forgets; it stores neither key, prompt nor answer.
//   * The API key is kept in the encrypted vault settings item (synced like a
//     note) and in memory while unlocked. It is never written to localStorage.
//   * Chat history lives in memory only and is dropped on lock / note switch.
//   * Ollama's cloud states prompts and responses are processed transiently,
//     never logged or trained on; a self-hosted server keeps everything at home.
const NotesAiChat = (() => {
  const CLOUD_HOST = 'https://ollama.com';
  const RELAY_BASE = '/api/ai/ollama';
  const DEFAULT_MODEL = 'gpt-oss:120b';
  const MAX_CONTEXT_CHARS = 24000;
  const MAX_HISTORY = 12;
  // Ollama cloud models (https://ollama.com/api/tags) suited to Q&A over a note.
  const SUGGESTED_MODELS = [
    'gpt-oss:120b',
    'gpt-oss:20b',
    'glm-5.3-flash',
    'gemma4:31b',
    'nemotron-3-nano:30b',
    'kimi-k2.6',
    'deepseek-v4-flash',
    'qwen3.5:397b',
  ];
  const SYSTEM_PROMPT = 'You answer questions about one personal note the user is viewing. '
    + 'Use only the note text below. If the answer is not in the note, say so briefly. '
    + 'Be concise. Never ask for or repeat secrets such as passwords or one-time codes.';

  const state = {
    noteId: null,
    messages: [],
    busy: false,
  };
  let deps = {};
  let ui = {};

  function normalizeHost(raw) {
    let host = String(raw || '').trim().replace(/\/+$/, '');
    if (!host) return CLOUD_HOST;
    if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
    return host.replace(/\/(api|v1)$/i, '');
  }

  function isCloudHost(host) {
    try {
      return new URL(normalizeHost(host)).hostname.replace(/^www\./, '') === 'ollama.com';
    } catch (err) {
      return false;
    }
  }

  function normalizeModel(raw, host) {
    let model = String(raw || '').trim();
    // Settings saved by the earlier OpenRouter integration ("vendor/model") do
    // not exist on Ollama; fall back to the default cloud model.
    if (!model || model.includes('/')) return DEFAULT_MODEL;
    // "name-cloud" is how a local Ollama names cloud models; ollama.com itself
    // wants the plain name.
    if (isCloudHost(host)) model = model.replace(/-cloud$/i, '');
    return model;
  }

  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const host = normalizeHost(src.host);
    let apiKey = String(src.apiKey || '').trim();
    if (/^sk-or-/.test(apiKey)) apiKey = ''; // leftover OpenRouter key
    return {
      host,
      apiKey,
      model: normalizeModel(src.model, host),
      includeOcr: src.includeOcr !== false,
    };
  }

  function isConfigured(cfg) {
    const c = normalizeSettings(cfg);
    return isCloudHost(c.host) ? !!c.apiKey : true;
  }

  function truncate(text, max) {
    const clean = String(text || '');
    if (clean.length <= max) return clean;
    return `${clean.slice(0, Math.max(0, max - 24))}\n…[truncated]`;
  }

  // Builds the only payload that leaves the device: title, body, scanned text.
  function buildContext(note, attachments = [], { includeOcr = true, maxChars = MAX_CONTEXT_CHARS } = {}) {
    if (!note || !note.content) return '';
    const parts = [];
    const title = String(note.content.title || '').trim();
    if (title) parts.push(`Title: ${title}`);
    const body = String(note.content.content || '').trim();
    if (body) parts.push(`Note:\n${body}`);
    if (includeOcr) {
      const scans = (attachments || [])
        .map((att) => String(att?.content?.ocr_text || '').trim())
        .filter(Boolean);
      scans.forEach((text, index) => {
        parts.push(`Scanned document ${index + 1}:\n${text}`);
      });
    }
    return truncate(parts.join('\n\n'), maxChars);
  }

  function requestBody({ model, context, history = [], question }) {
    const messages = [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\n--- NOTE ---\n${context || '(empty note)'}\n--- END NOTE ---` },
      ...history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: String(m.content || '') })),
      { role: 'user', content: String(question || '') },
    ];
    return {
      model: model || DEFAULT_MODEL,
      messages,
      stream: false,
      options: { temperature: 0.2, num_predict: 1024 },
    };
  }

  function endpoints(cfg) {
    if (isCloudHost(cfg.host)) {
      return { relay: true, chat: `${RELAY_BASE}/chat`, ps: `${RELAY_BASE}/ps`, tags: `${RELAY_BASE}/tags` };
    }
    return { relay: false, chat: `${cfg.host}/api/chat`, ps: `${cfg.host}/api/ps`, tags: `${cfg.host}/api/tags` };
  }

  function requestInit(cfg, ep, { method, body, csrf, signal } = {}) {
    const h = {};
    if (ep.relay) {
      if (cfg.apiKey) h['X-Ollama-Key'] = cfg.apiKey;
      if (csrf) h['X-CSRF-Token'] = csrf;
    } else if (cfg.apiKey) {
      h.Authorization = `Bearer ${cfg.apiKey}`;
    }
    if (body !== undefined) h['Content-Type'] = 'application/json';
    return {
      method,
      headers: h,
      body,
      signal,
      credentials: ep.relay ? 'same-origin' : 'omit',
      referrerPolicy: 'no-referrer',
    };
  }

  // The relay answers 401 itself when the app session expired; upstream key
  // rejections carry `upstream: true`.
  function sessionExpired(ep, res, data) {
    return ep.relay && res.status === 401 && !data?.upstream;
  }

  function serverLabel(host) {
    return isCloudHost(host) ? 'Ollama Cloud' : 'the Ollama server';
  }

  function keyRejectedMessage(host) {
    return isCloudHost(host)
      ? 'Ollama Cloud rejected this API key. Create a new key at ollama.com/settings/keys.'
      : 'The Ollama server rejected the API key.';
  }

  function unreachableMessage(host) {
    return isCloudHost(host)
      ? 'Could not reach ollama.com'
      : 'Could not reach the Ollama server (check the URL, HTTPS and OLLAMA_ORIGINS)';
  }

  async function readJson(res) {
    try { return await res.json(); } catch (err) { return null; }
  }

  function errorDetail(data, res) {
    if (typeof data?.error === 'string') return data.error;
    if (data?.error?.message) return data.error.message;
    return `${res.status}`;
  }

  // Verifies host + key without sending any note content: /api/ps needs a
  // valid key on ollama.com, /api/tags tells us whether the model exists.
  async function checkKey(settingsLike, { fetchImpl, csrf } = {}) {
    const cfg = normalizeSettings(settingsLike);
    const cloud = isCloudHost(cfg.host);
    if (cloud && !cfg.apiKey) throw new Error('Enter an Ollama API key first');
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!doFetch) throw new Error('Network unavailable');
    const ep = endpoints(cfg);
    const get = async (url) => {
      try {
        return await doFetch(url, requestInit(cfg, ep, { method: 'GET', csrf }));
      } catch (err) {
        throw new Error(unreachableMessage(cfg.host));
      }
    };
    const ps = await get(ep.ps);
    if (!ps.ok) {
      const data = await readJson(ps);
      if (sessionExpired(ep, ps, data)) throw new Error('Your session expired. Sign in again and retry.');
      if (ps.status === 401 || ps.status === 403) throw new Error(keyRejectedMessage(cfg.host));
      throw new Error(`${serverLabel(cfg.host)} error: ${errorDetail(data, ps)}`);
    }
    let models = [];
    const tags = await get(ep.tags);
    if (tags.ok) {
      const data = await readJson(tags);
      models = (data?.models || []).map((m) => String(m.name || m.model || '')).filter(Boolean);
    }
    const wanted = cfg.model.toLowerCase();
    const modelAvailable = models.length
      ? models.some((name) => {
        const n = name.toLowerCase();
        return n === wanted || n === `${wanted}:latest` || n === `${wanted}-cloud` || n.replace(/-cloud$/, '') === wanted;
      })
      : null;
    return { host: cfg.host, cloud, model: cfg.model, models, modelAvailable };
  }

  function describeKeyCheck(info) {
    const parts = [info.cloud ? 'Key accepted by Ollama Cloud' : 'Ollama server reachable'];
    if (info.modelAvailable === true) parts.push(`model ${info.model} available`);
    else if (info.modelAvailable === false) parts.push(`model ${info.model} not found on this server`);
    else parts.push(`model ${info.model}`);
    return parts.join(' · ');
  }

  async function ask({ host, apiKey, model, context, history, question, fetchImpl, csrf }) {
    const cfg = normalizeSettings({ host, apiKey, model });
    if (isCloudHost(cfg.host) && !cfg.apiKey) throw new Error('Add an Ollama API key in Settings first');
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!doFetch) throw new Error('Network unavailable');
    const ep = endpoints(cfg);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 130000) : null;
    let res;
    try {
      res = await doFetch(ep.chat, requestInit(cfg, ep, {
        method: 'POST',
        body: JSON.stringify(requestBody({ model: cfg.model, context, history, question })),
        csrf,
        signal: controller?.signal,
      }));
    } catch (err) {
      throw new Error(err?.name === 'AbortError' ? 'The model took too long to answer' : unreachableMessage(cfg.host));
    } finally {
      if (timer) clearTimeout(timer);
    }
    const data = await readJson(res);
    if (!res.ok) {
      const detail = errorDetail(data, res);
      if (sessionExpired(ep, res, data)) throw new Error('Your session expired. Sign in again and retry.');
      if (res.status === 401 || res.status === 403) throw new Error(keyRejectedMessage(cfg.host));
      if (res.status === 402 || res.status === 429) {
        throw new Error(`${serverLabel(cfg.host)}: usage limit reached (${detail})`);
      }
      if (res.status === 404 || /not found|does not exist/i.test(detail)) {
        throw new Error(`Model ${cfg.model} is not available on ${serverLabel(cfg.host)}. Pick another model in Settings.`);
      }
      throw new Error(`${serverLabel(cfg.host)} error: ${detail}`);
    }
    const text = data?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('The model returned an empty answer');
    return text.trim();
  }

  /* ---------------- UI ---------------- */

  function el(id) {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
  }

  function settings() {
    return normalizeSettings(deps.getSettings ? deps.getSettings() : null);
  }

  function formatMsgTime(ts) {
    const date = new Date(typeof ts === 'number' ? ts : Date.now());
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const hm = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    if (sameDay) return hm;
    const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${day} ${hm}`;
  }

  function renderMessages() {
    if (!ui.messages) return;
    ui.messages.replaceChildren();
    if (!state.messages.length) {
      const empty = document.createElement('p');
      empty.className = 'ai-chat-empty settings-hint';
      empty.textContent = 'Ask something about this note, e.g. "Summarize this" or "What amount is due?"';
      ui.messages.appendChild(empty);
      return;
    }
    for (const msg of state.messages) {
      const wrap = document.createElement('div');
      wrap.className = `ai-msg-wrap ai-msg-wrap-${msg.role}`;
      const when = document.createElement('time');
      when.className = 'ai-msg-time';
      const stamp = msg.ts || Date.now();
      when.dateTime = new Date(stamp).toISOString();
      when.textContent = formatMsgTime(stamp);
      const row = document.createElement('div');
      row.className = `ai-msg ai-msg-${msg.role}${msg.error ? ' ai-msg-error' : ''}`;
      row.textContent = msg.content;
      wrap.appendChild(when);
      wrap.appendChild(row);
      ui.messages.appendChild(wrap);
    }
    if (state.busy) {
      const wrap = document.createElement('div');
      wrap.className = 'ai-msg-wrap ai-msg-wrap-assistant';
      const row = document.createElement('div');
      row.className = 'ai-msg ai-msg-assistant ai-msg-busy';
      row.textContent = 'Thinking…';
      wrap.appendChild(row);
      ui.messages.appendChild(wrap);
    }
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  function renderState() {
    const cfg = settings();
    const note = deps.getNote ? deps.getNote(state.noteId) : null;
    const ready = isConfigured(cfg);
    if (ui.setup) ui.setup.hidden = ready;
    if (ui.form) ui.form.hidden = !ready || !note;
    if (ui.meta) {
      const ctx = note ? buildContext(note, deps.getAttachments ? deps.getAttachments(state.noteId) : [], { includeOcr: cfg.includeOcr }) : '';
      const kb = Math.round(ctx.length / 100) / 10;
      ui.meta.textContent = note
        ? `Sends ${kb} kB of this note to ${cfg.model} on ${isCloudHost(cfg.host) ? 'Ollama Cloud' : cfg.host}`
        : 'Open a note first';
    }
    if (ui.send) ui.send.disabled = state.busy;
    renderMessages();
  }

  function open() {
    if (!ui.panel) return;
    ui.panel.hidden = false;
    ui.panel.removeAttribute('hidden');
    if (ui.backdrop) {
      ui.backdrop.hidden = false;
      ui.backdrop.removeAttribute('hidden');
    }
    document.body.classList.add('ai-chat-open');
    renderState();
    if (isConfigured(settings())) ui.input?.focus();
  }

  function close() {
    if (ui.panel) ui.panel.hidden = true;
    if (ui.backdrop) ui.backdrop.hidden = true;
    document.body.classList.remove('ai-chat-open');
  }

  function isOpen() {
    return !!ui.panel && !ui.panel.hidden;
  }

  function reset() {
    state.messages = [];
    state.noteId = null;
    state.busy = false;
    close();
    if (ui.input) ui.input.value = '';
    if (ui.messages) ui.messages.replaceChildren();
  }

  function onNoteChanged(noteId) {
    if (noteId === state.noteId) return;
    state.noteId = noteId || null;
    state.messages = [];
    state.busy = false;
    if (isOpen()) renderState();
  }

  async function submit() {
    const question = String(ui.input?.value || '').trim();
    if (!question || state.busy) return;
    const cfg = settings();
    const note = deps.getNote ? deps.getNote(state.noteId) : null;
    if (!note) {
      deps.toast?.('Open a note first', true);
      return;
    }
    if (!isConfigured(cfg)) {
      renderState();
      return;
    }
    const context = buildContext(note, deps.getAttachments ? deps.getAttachments(state.noteId) : [], { includeOcr: cfg.includeOcr });
    const history = state.messages.filter((m) => !m.error);
    state.messages.push({ role: 'user', content: question, ts: Date.now() });
    state.busy = true;
    if (ui.input) ui.input.value = '';
    renderState();
    try {
      const csrf = deps.getCsrf ? await deps.getCsrf() : '';
      const answer = await ask({
        host: cfg.host,
        apiKey: cfg.apiKey,
        model: cfg.model,
        context,
        history,
        question,
        csrf,
      });
      state.messages.push({ role: 'assistant', content: answer, ts: Date.now() });
    } catch (err) {
      state.messages.push({
        role: 'assistant',
        content: err?.message || 'Request failed',
        error: true,
        ts: Date.now(),
      });
    } finally {
      state.busy = false;
      renderState();
    }
  }

  function init(options = {}) {
    deps = options;
    ui = {
      panel: el('ai-chat-panel'),
      backdrop: el('ai-chat-backdrop'),
      messages: el('ai-chat-messages'),
      form: el('ai-chat-form'),
      input: el('ai-chat-input'),
      send: el('ai-chat-send'),
      meta: el('ai-chat-meta'),
      setup: el('ai-chat-setup'),
    };
    if (!ui.panel) return;
    el('ai-chat-close')?.addEventListener('click', close);
    ui.backdrop?.addEventListener('click', close);
    el('ai-chat-open-settings')?.addEventListener('click', () => {
      close();
      deps.openSettings?.();
    });
    el('ai-chat-clear-history')?.addEventListener('click', () => {
      state.messages = [];
      renderState();
    });
    ui.form?.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    ui.input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    });
    const list = el('ai-chat-models');
    if (list && !list.children.length) {
      for (const model of SUGGESTED_MODELS) {
        const opt = document.createElement('option');
        opt.value = model;
        list.appendChild(opt);
      }
    }
  }

  return {
    CLOUD_HOST,
    RELAY_BASE,
    DEFAULT_MODEL,
    MAX_CONTEXT_CHARS,
    SUGGESTED_MODELS,
    normalizeSettings,
    isCloudHost,
    isConfigured,
    buildContext,
    requestBody,
    ask,
    checkKey,
    describeKeyCheck,
    init,
    open,
    close,
    isOpen,
    reset,
    onNoteChanged,
    refresh: renderState,
  };
})();

if (typeof window !== 'undefined') window.NotesAiChat = NotesAiChat;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesAiChat;
