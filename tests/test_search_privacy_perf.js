// Client-side search across notes and attachment OCR, run through the real
// store (encrypted vault, attachment items) and the real search module:
// - a word that only exists in an attachment's own OCR text is found and the
//   hit is labelled as coming from the attachment, not from the note;
// - result snippets are built from text nodes + <mark> (never innerHTML);
// - opening a note marks the query in the note preview;
// - indexing/searching writes no plaintext to localStorage, sessionStorage or
//   IndexedDB and sends nothing with the query to the network;
// - lock() (also the first step of sign-out) empties the in-memory index;
// - 1000 notes are indexed and searched within a fixed time budget.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const vendorRoot = path.join(jsRoot, 'vendor');
const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
const searchJs = fs.readFileSync(path.join(jsRoot, 'search.js'), 'utf8');

// ---- recording platform stubs ------------------------------------------------
const idb = new Map();
const blobs = new Map();
const idbMeta = new Map();
const network = [];

function memoryStorage() {
  return {
    store: {},
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
    },
    setItem(key, value) {
      this.store[key] = String(value);
    },
    removeItem(key) {
      delete this.store[key];
    },
    clear() {
      this.store = {};
    },
  };
}

global.addEventListener = () => {};
global.window = global;
global.localStorage = memoryStorage();
global.sessionStorage = memoryStorage();
global.NotesIDB = {
  async putItem(row) {
    idb.set(row.uuid, JSON.parse(JSON.stringify(row)));
  },
  async deleteItem(uuid) {
    idb.delete(uuid);
    blobs.delete(uuid);
  },
  async loadItems() {
    return [...idb.values()];
  },
  async iterateItems(onRow) {
    for (const row of idb.values()) onRow(row);
  },
  async getItem(uuid) {
    return idb.get(uuid) || null;
  },
  async putBlob(uuid, blobCiphertext) {
    blobs.set(uuid, blobCiphertext);
  },
  async getBlob(uuid) {
    return blobs.get(uuid) || '';
  },
  async deleteBlob(uuid) {
    blobs.delete(uuid);
  },
  async getMeta(key) {
    return idbMeta.has(key) ? idbMeta.get(key) : null;
  },
  async putMeta(key, value) {
    idbMeta.set(key, JSON.parse(JSON.stringify(value ?? null)));
  },
};
global.fetch = async (url, init = {}) => {
  network.push({ kind: 'fetch', url: String(url), body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body || '') });
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ items: [], server_time: Date.now() / 1000 }) };
};
global.XMLHttpRequest = function XMLHttpRequest() {
  this.open = (method, url) => network.push({ kind: 'xhr', url: String(url), body: '' });
  this.send = (body) => network.push({ kind: 'xhr', url: '', body: String(body || '') });
  this.setRequestHeader = () => {};
};
global.navigator = global.navigator || {};
try {
  global.navigator.sendBeacon = (url, body) => {
    network.push({ kind: 'beacon', url: String(url), body: String(body || '') });
    return true;
  };
} catch (err) {
  /* read-only navigator on some node versions */
}
global.WebSocket = function WebSocket(url) {
  network.push({ kind: 'ws', url: String(url), body: '' });
  this.send = (body) => network.push({ kind: 'ws', url: String(url), body: String(body || '') });
};
global.indexedDB = {
  open() {
    throw new Error('search must not open IndexedDB directly');
  },
};

global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
vm.runInThisContext(fs.readFileSync(path.join(vendorRoot, 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const NotesStore = require(path.join(jsRoot, 'store.js'));
global.NotesStore = NotesStore;
const NotesSearch = require(path.join(jsRoot, 'search.js'));
global.NotesSearch = NotesSearch;

// ---- minimal DOM for snippet and preview highlighting -----------------------
class FakeNode {
  constructor(doc, nodeType) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  appendChild(child) {
    if (child.nodeType === 11) {
      [...child.childNodes].forEach((c) => this.appendChild(c));
      child.childNodes = [];
      return child;
    }
    if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter((c) => c !== child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  replaceChild(next, old) {
    const at = this.childNodes.indexOf(old);
    assert.ok(at >= 0, 'replaceChild: old node is not a child');
    const incoming = next.nodeType === 11 ? [...next.childNodes] : [next];
    incoming.forEach((c) => { c.parentNode = this; });
    this.childNodes.splice(at, 1, ...incoming);
    old.parentNode = null;
    return old;
  }

  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    const text = String(value ?? '');
    if (text) this.appendChild(this.ownerDocument.createTextNode(text));
  }
}

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc, 1);
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this.attrs = {};
    this.dataset = {};
  }

  set innerHTML(value) {
    doc.innerHtmlWrites.push(String(value));
    throw new Error('innerHTML must not be used for search snippets or highlights');
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    }
  }

  removeAttribute(name) {
    delete this.attrs[name];
    if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
  }

  matches(selector) {
    const m = /^([a-z]*)((?:\.[A-Za-z0-9_-]+)*)(?:\[([a-z-]+)\])?$/.exec(selector.trim());
    assert.ok(m, `unsupported selector ${selector}`);
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    const classes = String(this.className).split(/\s+/);
    if (m[2] && !m[2].split('.').filter(Boolean).every((c) => classes.includes(c))) return false;
    if (m[3] && !Object.prototype.hasOwnProperty.call(this.attrs, m[3])) return false;
    return true;
  }

  closest(selector) {
    let el = this;
    while (el && el.nodeType === 1) {
      if (el.matches(selector)) return el;
      el = el.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

const doc = {
  innerHtmlWrites: [],
  created: [],
  createElement(tag) {
    const el = new FakeElement(doc, tag);
    doc.created.push(el.tagName);
    return el;
  },
  createTextNode(text) {
    const node = new FakeNode(doc, 3);
    node.nodeValue = String(text);
    return node;
  },
  createDocumentFragment() {
    return new FakeNode(doc, 11);
  },
  createTreeWalker(root, whatToShow) {
    assert.strictEqual(whatToShow, 4, 'only text nodes are walked');
    const nodes = [];
    const walk = (node) => node.childNodes.forEach((c) => (c.nodeType === 3 ? nodes.push(c) : walk(c)));
    walk(root);
    let i = -1;
    return {
      currentNode: null,
      nextNode() {
        i += 1;
        this.currentNode = nodes[i] || null;
        return this.currentNode;
      },
    };
  },
};

function el(tag, className = '', attrs = {}) {
  const node = doc.createElement(tag);
  node.className = className;
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}

// The real list helpers from app.js (snippet hand-off + text-node fill).
function loadSnippetHelpers() {
  const start = appJs.indexOf('  const pendingSearchSnippets = new Map();');
  const end = appJs.indexOf('  function noteListPreview(', start);
  assert.ok(start >= 0 && end > start, 'app.js must define pendingSearchSnippets/fillSearchSnippets');
  const sandbox = { NotesSearch, result: null };
  vm.createContext(sandbox);
  vm.runInContext(`${appJs.slice(start, end)}\nresult = { pendingSearchSnippets, fillSearchSnippets };`, sandbox);
  return sandbox.result;
}

// ---- helpers ---------------------------------------------------------------
const OCR_WORD = 'Zwavelkwartsiet';
const TEXT_ATT_WORD = 'Pimpelmeesboek';
const BODY_WORD = 'Kwartelkoning';
const SECRET_WORDS = [OCR_WORD, TEXT_ATT_WORD, BODY_WORD];

function persistedDump() {
  return JSON.stringify({
    local: global.localStorage.store,
    session: global.sessionStorage.store,
    idb: [...idb.values()],
    blobs: [...blobs.values()],
    meta: [...idbMeta.entries()],
  }).toLowerCase();
}

function assertNoPlaintextPersisted(context) {
  const dump = persistedDump();
  for (const word of SECRET_WORDS) {
    assert.ok(!dump.includes(word.toLowerCase()), `${context}: "${word}" must not be stored in plaintext`);
  }
}

function assertNothingOnTheWire(context) {
  for (const req of network) {
    const text = `${req.url}\n${req.body}`.toLowerCase();
    for (const word of SECRET_WORDS) {
      assert.ok(!text.includes(word.toLowerCase()), `${context}: "${word}" leaked in a ${req.kind} request to ${req.url}`);
    }
    assert.ok(!/search|query=|\bq=/.test(req.url.toLowerCase()), `${context}: unexpected search request ${req.url}`);
  }
}

function search(query) {
  const notes = NotesStore.listNotes();
  return NotesSearch.filterNotes(notes, { query, filter: 'all', tagMap: new Map() });
}

async function addNote(title, body) {
  const id = NotesStore.newUuid();
  const content = NotesStore.defaultNote();
  content.title = title;
  content.content = body;
  NotesStore.upsert(id, content);
  return id;
}

async function addAttachment(noteId, { filename, mime, bytes, ocr }) {
  const imported = await NotesStore.importAttachment({
    uuid: NotesStore.newUuid(),
    noteId,
    bytes: new TextEncoder().encode(bytes),
    filename,
    mime,
  });
  assert.ok(imported && imported.uuid, 'attachment import');
  assert.strictEqual(NotesStore.setAttachmentOcr(imported.uuid, ocr, 'tesseract'), true);
  NotesStore.refreshNoteSearchText(noteId);
  return imported.uuid;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

(async () => {
  // Static guard: the search module itself never touches storage or network.
  for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'NotesIDB', 'fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket']) {
    assert.ok(!searchJs.includes(api), `search.js must not use ${api}`);
  }

  await NotesStore.unlock('vault-password', 'salt-search');

  // ---- attachment OCR hits, through real attachment items -------------------
  const scanNote = await addNote('Geologie excursie', 'Verslag van de dag, zie de scan.');
  const scanAtt = await addAttachment(scanNote, {
    filename: 'veldwerk.png',
    mime: 'image/png',
    bytes: 'fake-png-bytes-1',
    ocr: `Monster 14: ${OCR_WORD} uit groeve Noord`,
  });
  const textNote = await addNote('Leeslijst', 'Boeken voor de zomer.');
  await addAttachment(textNote, {
    filename: 'boeken.txt',
    mime: 'text/plain',
    bytes: 'fake-text-bytes-2',
    ocr: `Hoofdstuk 3 van het ${TEXT_ATT_WORD} gaat over vogels`,
  });
  const bodyNote = await addNote('Vogels', `Vanochtend een ${BODY_WORD} gehoord bij de dijk.`);

  assert.deepStrictEqual(NotesStore.listAttachments(scanNote).map((a) => a.uuid), [scanAtt]);
  // The note's own fields do not contain the word; only the attachment item does.
  const scanNoteItem = NotesStore.get(scanNote);
  assert.ok(!scanNoteItem.content.title.includes(OCR_WORD));
  assert.ok(!scanNoteItem.content.content.includes(OCR_WORD));
  assert.ok(NotesStore.get(scanAtt).content.ocr_text.includes(OCR_WORD));
  // Drop the note's legacy copy so only the attachment item can produce the hit.
  scanNoteItem.content.ocr_text = '';
  NotesStore.get(textNote).content.ocr_text = '';

  NotesSearch.indexNotes(NotesStore.listNotes(), new Map());

  const ocrHits = search(OCR_WORD.toLowerCase());
  assert.deepStrictEqual(ocrHits.map((n) => n.uuid), [scanNote], 'OCR-only word finds exactly the scanned note');
  const ocrMatch = NotesSearch.describeMatch(ocrHits[0], OCR_WORD, new Map());
  assert.strictEqual(ocrMatch.field, 'ocr');
  assert.strictEqual(ocrMatch.label, 'Scanned document');
  assert.ok(ocrMatch.snippet.includes(OCR_WORD), 'snippet shows the OCR hit');

  const textHits = search(TEXT_ATT_WORD);
  assert.deepStrictEqual(textHits.map((n) => n.uuid), [textNote]);
  const textMatch = NotesSearch.describeMatch(textHits[0], TEXT_ATT_WORD, new Map());
  assert.strictEqual(textMatch.field, 'ocr');
  assert.strictEqual(textMatch.label, 'Attachment text');
  assert.ok(textMatch.snippet.includes(TEXT_ATT_WORD));

  const bodyHits = search(BODY_WORD);
  assert.deepStrictEqual(bodyHits.map((n) => n.uuid), [bodyNote]);
  const bodyMatch = NotesSearch.describeMatch(bodyHits[0], BODY_WORD, new Map());
  assert.strictEqual(bodyMatch.field, 'body');
  assert.strictEqual(bodyMatch.label, 'Note');

  // ---- snippet in the result list: text nodes only ---------------------------
  const helpers = loadSnippetHelpers();
  const evil = `<img src=x onerror="alert(1)"> ${BODY_WORD} </p><script>x()</script>`;
  const list = el('div', 'note-list');
  const row = el('div', 'note-row', { 'data-id': bodyNote });
  const preview = el('p', 'note-preview', { 'data-search-snippet': '1' });
  row.appendChild(preview);
  list.appendChild(row);
  helpers.pendingSearchSnippets.set(bodyNote, evil);
  helpers.fillSearchSnippets(list, BODY_WORD);
  assert.strictEqual(preview.textContent, evil, 'snippet text is shown verbatim, not parsed');
  assert.deepStrictEqual(preview.childNodes.map((n) => n.nodeType === 3 ? '#text' : n.tagName), ['#text', 'MARK', '#text']);
  assert.strictEqual(preview.childNodes[1].className, 'search-hit');
  assert.strictEqual(preview.childNodes[1].textContent, BODY_WORD);
  assert.ok(!doc.created.includes('IMG') && !doc.created.includes('SCRIPT'), 'no element from the data is created');
  assert.strictEqual(doc.innerHtmlWrites.length, 0);
  assert.strictEqual(helpers.pendingSearchSnippets.size, 0, 'pending snippet text is dropped after painting');
  assert.ok(!('searchSnippet' in preview.dataset));
  // The list hands search snippets to fillSearchSnippets instead of HTML.
  const previewFn = appJs.slice(appJs.indexOf('  function noteListPreview('), appJs.indexOf('  function noteKindMeta('));
  assert.ok(/if \(query\) \{[\s\S]*?pendingSearchSnippets\.set\(note\.uuid[\s\S]*?data-search-snippet="1"><\/p>'/.test(previewFn));
  assert.ok(appJs.includes('fillSearchSnippets(ui.noteList, query);'));
  assert.ok(appJs.includes('fillSearchSnippets(next, query);'));

  // ---- opening a note: the query is marked in its preview -------------------
  const notePreview = el('div', 'preview');
  const para = el('p');
  para.appendChild(doc.createTextNode(NotesStore.get(bodyNote).content.content));
  notePreview.appendChild(para);
  const marked = NotesSearch.applyHighlights(notePreview, BODY_WORD);
  assert.strictEqual(marked, 1);
  const mark = notePreview.querySelector('mark.search-hit');
  assert.ok(mark && mark.textContent === BODY_WORD, 'opened note shows the term marked');
  assert.strictEqual(para.textContent, NotesStore.get(bodyNote).content.content, 'marking keeps the text intact');
  // The note preview runs highlightPreview with the sidebar query on open.
  const hp = appJs.slice(appJs.indexOf('  function highlightPreview()'), appJs.indexOf('  function highlightPreview()') + 600);
  assert.ok(hp.includes('const query = ui.search.value.trim();') && hp.includes('NotesSearch.applyHighlights(ui.preview, query)'));
  assert.ok(/ui\.preview\.innerHTML = renderNoteBodyPreview\(ui\.body\.value, editor\);\s*markAutoDir\(ui\.preview\);\s*highlightPreview\(\);/.test(appJs));

  // ---- 1000 notes: index and search time ------------------------------------
  const words = ['agenda', 'factuur', 'recept', 'vakantie', 'project', 'boodschappen', 'tuin', 'fiets', 'school', 'werk'];
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ';
  for (let i = 0; i < 1000; i += 1) {
    await addNote(`Notitie ${i} ${words[i % words.length]}`, `${filler.repeat(6 + (i % 10))} nummer ${i} ${words[(i * 7) % words.length]}`);
  }
  // Scanned attachments on 50 of them; one carries a unique word.
  const bulk = NotesStore.listNotes().filter((n) => /^Notitie \d+/.test(n.content.title)).slice(0, 50);
  for (let i = 0; i < bulk.length; i += 1) {
    await addAttachment(bulk[i].uuid, {
      filename: `scan-${i}.jpg`,
      mime: 'image/jpeg',
      bytes: `fake-jpeg-${i}`,
      ocr: `${filler.repeat(20)} bon ${i}${i === 42 ? ` ${OCR_WORD}groeve` : ''}`,
    });
  }
  const allNotes = NotesStore.listNotes();
  assert.ok(allNotes.length >= 1003, `expected 1003 notes, got ${allNotes.length}`);

  const t0 = process.hrtime.bigint();
  NotesSearch.indexNotes(allNotes, new Map());
  const indexMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(NotesSearch.memoryIndexNoteCount(), allNotes.length);

  const queries = ['factuur', 'nummer 999', `${OCR_WORD.toLowerCase()}groeve`, 'tempor', 'bestaatnietwoord', '"sed do"'];
  const timings = [];
  let bulkOcrHits = null;
  for (let round = 0; round < 5; round += 1) {
    for (const q of queries) {
      const t = process.hrtime.bigint();
      const hits = NotesSearch.filterNotes(allNotes, { query: q, filter: 'all', tagMap: new Map() });
      // Painting the first page of results also asks for each row's match.
      hits.slice(0, 50).forEach((n) => NotesSearch.describeMatch(n, q, new Map()));
      timings.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (q.startsWith(OCR_WORD.toLowerCase())) bulkOcrHits = hits;
    }
  }
  assert.deepStrictEqual(bulkOcrHits.map((n) => n.uuid), [bulk[42].uuid]);
  assert.strictEqual(NotesSearch.describeMatch(bulkOcrHits[0], `${OCR_WORD}groeve`, new Map()).label, 'Scanned document');
  const medianMs = median(timings);
  const maxMs = Math.max(...timings);
  console.log(`search over ${allNotes.length} notes: index ${indexMs.toFixed(1)} ms, query median ${medianMs.toFixed(1)} ms, max ${maxMs.toFixed(1)} ms`);
  const slack = Number(process.env.SEARCH_PERF_SLACK || 1);
  assert.ok(indexMs < 3000 * slack, `indexing 1000 notes took ${indexMs.toFixed(1)} ms`);
  assert.ok(medianMs < 250 * slack, `median query took ${medianMs.toFixed(1)} ms`);
  assert.ok(maxMs < 1000 * slack, `slowest query took ${maxMs.toFixed(1)} ms`);

  // ---- nothing persisted in plaintext, nothing sent -------------------------
  try {
    await NotesStore.flush();
  } catch (err) {
    /* a refused push still must not carry plaintext */
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(idb.size > 0, 'the vault did persist (encrypted) items, so the check is meaningful');
  assertNoPlaintextPersisted('after indexing and searching');
  assertNothingOnTheWire('after indexing and searching');

  // ---- lock / sign-out wipe the index ----------------------------------------
  assert.ok(NotesSearch.memoryIndexActive());
  NotesStore.lock();
  assert.strictEqual(NotesSearch.memoryIndexActive(), false, 'index is gone after lock');
  assert.strictEqual(NotesSearch.memoryIndexNoteCount(), 0);
  assert.deepStrictEqual(NotesStore.listNotes(), [], 'no decrypted notes remain to rebuild it from');
  assert.deepStrictEqual(search(OCR_WORD), []);
  assertNoPlaintextPersisted('after lock');
  // Sign-out runs NotesStore.lock() before wiping device data.
  const leave = appJs.slice(appJs.indexOf('  async function clearLocalVaultAndLeave('), appJs.indexOf('  async function signOutCompletely('));
  assert.ok(/NotesStore\.lock\(\);[\s\S]*NotesStore\.clearDeviceData\(\)/.test(leave), 'sign-out locks (clearing the index) before wiping');
  assert.ok(appJs.slice(appJs.indexOf('  async function signOutCompletely('), appJs.indexOf('  let remoteWipeStarted')).includes("await clearLocalVaultAndLeave('/login')"));
  global.NotesIDB.clearAll = async () => {
    idb.clear();
    blobs.clear();
    idbMeta.clear();
  };
  await NotesStore.clearDeviceData();
  assert.strictEqual(NotesSearch.memoryIndexNoteCount(), 0);
  assertNoPlaintextPersisted('after sign-out wipe');
  assertNothingOnTheWire('after lock and sign-out');

  console.log(`ok - search privacy/perf (${network.length} network calls observed, none with search text)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
