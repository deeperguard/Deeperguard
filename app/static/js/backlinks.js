/**
 * Backlink index (docs/NOTES_ORGANIZATION_SPEC.md section 4).
 *
 * Built only in this browser from already-decrypted notes. Memory only: this
 * module never touches localStorage, sessionStorage, IndexedDB, caches or the
 * network. `clear()` drops everything; NotesStore.lock() calls it.
 *
 *   outgoing:  Map<sourceUuid, Map<targetUuid, count>>
 *   backlinks: Map<targetUuid, Map<sourceUuid, count>>
 */
const NotesBacklinks = (() => {
  const Links = typeof NotesLinks !== 'undefined'
    ? NotesLinks
    : (typeof require === 'function' ? require('./notelinks.js') : null);
  const CHUNK = 250;
  const DEBOUNCE_MS = 300;
  const SNIPPET_RADIUS = 60;

  let outgoing = new Map();
  let backlinks = new Map();
  let memo = new Map(); // sourceUuid -> last scanned body (shared string ref, no copy)
  let flags = new Map(); // sourceUuid -> {trashed, template, archived}
  let epoch = 0;
  let status = 'idle'; // idle | building | ready
  let building = null;
  const clearHooks = new Set();

  function bodyOf(item) {
    return String(item?.content?.content || '');
  }

  function isLiveNote(item) {
    return !!item && !item.deleted && item.content?.type === 'note' && !item.content.deleted;
  }

  function scan(text) {
    const counts = new Map();
    if (!text.includes('](dg-note:')) return counts;
    for (const l of Links.findLinks(text)) counts.set(l.uuid, (counts.get(l.uuid) || 0) + 1);
    return counts;
  }

  function dropSource(uuid, touched) {
    const old = outgoing.get(uuid);
    if (old) {
      for (const target of old.keys()) {
        const set = backlinks.get(target);
        if (set) {
          set.delete(uuid);
          if (!set.size) backlinks.delete(target);
        }
        if (touched) touched.add(target);
      }
    }
    outgoing.delete(uuid);
    memo.delete(uuid);
    flags.delete(uuid);
  }

  /**
   * Re-index one note. Reads only this item. Returns the set of target uuids
   * whose backlinks may have changed (old and new targets).
   */
  function update(uuid, item, touched = new Set()) {
    if (!uuid) return touched;
    if (!isLiveNote(item)) {
      if (outgoing.has(uuid) || memo.has(uuid)) dropSource(uuid, touched);
      return touched;
    }
    const c = item.content;
    const nextFlags = { trashed: !!c.trashed, template: !!c.is_template, archived: !!c.archived };
    const prevFlags = flags.get(uuid);
    flags.set(uuid, nextFlags);
    const flagsChanged = !prevFlags || prevFlags.trashed !== nextFlags.trashed
      || prevFlags.template !== nextFlags.template || prevFlags.archived !== nextFlags.archived;
    const text = bodyOf(item);
    if (memo.get(uuid) === text && memo.has(uuid)) {
      // Unchanged body: no re-scan. Title/flag changes still affect panels.
      const out = outgoing.get(uuid);
      if (out) for (const t of out.keys()) touched.add(t);
      return touched;
    }
    const prev = outgoing.get(uuid);
    if (prev) {
      for (const target of prev.keys()) {
        const set = backlinks.get(target);
        if (set) {
          set.delete(uuid);
          if (!set.size) backlinks.delete(target);
        }
        touched.add(target);
      }
    }
    const counts = scan(text);
    memo.set(uuid, text);
    if (counts.size) {
      outgoing.set(uuid, counts);
      for (const [target, n] of counts) {
        if (target === uuid) continue; // self links are not backlinks
        let set = backlinks.get(target);
        if (!set) backlinks.set(target, (set = new Map()));
        set.set(uuid, n);
        touched.add(target);
      }
    } else {
      outgoing.delete(uuid);
    }
    if (flagsChanged && prev) for (const t of prev.keys()) touched.add(t);
    return touched;
  }

  function defaultYield() {
    if (typeof scheduler !== 'undefined' && scheduler && typeof scheduler.yield === 'function') {
      return scheduler.yield();
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Full build in chunks of 250 notes with a yield between chunks, so the UI
   * keeps responding. `listIds()` gives note uuids, `getItem(uuid)` the current
   * decrypted item (read at scan time, so edits during the build are seen).
   */
  function build({ listIds, getItem, chunk = CHUNK, yieldFn = defaultYield, onChunk } = {}) {
    epoch += 1;
    const mine = epoch;
    status = 'building';
    const run = (async () => {
      const ids = listIds();
      const seen = new Set(ids);
      for (const uuid of [...outgoing.keys(), ...memo.keys()]) {
        if (!seen.has(uuid)) dropSource(uuid);
      }
      let longest = 0;
      for (let i = 0; i < ids.length; i += chunk) {
        const t0 = now();
        const end = Math.min(ids.length, i + chunk);
        for (let j = i; j < end; j += 1) update(ids[j], getItem(ids[j]));
        longest = Math.max(longest, now() - t0);
        if (onChunk) onChunk(end, ids.length);
        if (end < ids.length) {
          await yieldFn();
          if (mine !== epoch) return { aborted: true, longest };
        }
      }
      if (mine !== epoch) return { aborted: true, longest };
      status = 'ready';
      building = null;
      return { aborted: false, notes: ids.length, longest };
    })();
    building = run;
    return run;
  }

  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  /** [{sourceUuid, count, trashed, template, archived}] for one target. */
  function linksTo(target) {
    const set = backlinks.get(String(target || '').toLowerCase());
    if (!set) return [];
    const out = [];
    for (const [sourceUuid, count] of set) {
      const f = flags.get(sourceUuid) || {};
      out.push({ sourceUuid, count, trashed: !!f.trashed, template: !!f.template, archived: !!f.archived });
    }
    return out;
  }

  function outgoingOf(source) {
    return [...(outgoing.get(source)?.keys() || [])];
  }

  /** Short plain-text context around the first link to `target` in `text`. */
  function snippet(text, target, radius = SNIPPET_RADIUS) {
    const src = String(text || '');
    const id = String(target || '').toLowerCase();
    const link = Links.findLinks(src).find((l) => l.uuid === id);
    if (!link) return '';
    const strip = (s) => s.replace(/\[([^\]\n]*)\]\(dg-note:[0-9a-f-]{36}\)/gi, '$1')
      .replace(/[#*_>`~]+/g, '').replace(/\s+/g, ' ');
    const before = strip(src.slice(Math.max(0, link.start - radius * 2), link.start));
    const after = strip(src.slice(link.end, link.end + radius * 2));
    const label = Links.findLinks(src.slice(link.start, link.end))[0]?.label || '';
    const left = before.length > radius ? `…${before.slice(-radius).replace(/^\S*\s/, '')}` : before;
    const right = after.length > radius ? `${after.slice(0, radius).replace(/\s\S*$/, '')}…` : after;
    return `${left}${label}${right}`.trim();
  }

  function clear() {
    epoch += 1;
    outgoing = new Map();
    backlinks = new Map();
    memo = new Map();
    flags = new Map();
    status = 'idle';
    building = null;
    for (const fn of clearHooks) {
      try { fn(); } catch (_) { /* ignore */ }
    }
  }

  function stats() {
    return { sources: outgoing.size, targets: backlinks.size, scanned: memo.size, status };
  }

  /**
   * Panel "Linked from (N)". Text only, never HTML from notes. Each entry is a
   * button (Tab/Enter/Space work natively); ArrowUp/ArrowDown move between them.
   */
  function renderPanel(container, { target, getItem, titleOf, onOpen, doc, showTrashed = false } = {}) {
    if (!container) return;
    const d = doc || (typeof document !== 'undefined' ? document : null);
    container.textContent = '';
    container.replaceChildren?.();
    const heading = d.createElement('h3');
    heading.className = 'section-label';
    heading.id = 'backlinks-heading';
    container.appendChild(heading);
    if (status !== 'ready') {
      container.setAttribute('aria-busy', 'true');
      heading.textContent = 'Linked from';
      const p = d.createElement('p');
      p.className = 'muted backlinks-empty';
      p.textContent = 'Indexing links…';
      container.appendChild(p);
      return;
    }
    container.setAttribute('aria-busy', 'false');
    const rows = linksTo(target)
      .filter((r) => showTrashed || (!r.trashed && !r.template))
      .map((r) => ({ ...r, item: getItem(r.sourceUuid) }))
      .filter((r) => isLiveNote(r.item))
      .map((r) => ({ ...r, title: (titleOf ? titleOf(r.item) : r.item.content.title) || 'Untitled' }))
      .sort((a, b) => a.title.localeCompare(b.title));
    heading.textContent = `Linked from (${rows.length})`;
    if (!rows.length) {
      const p = d.createElement('p');
      p.className = 'muted backlinks-empty';
      p.textContent = 'No notes link here yet. Type [[ in another note to link to this one.';
      container.appendChild(p);
      return;
    }
    const list = d.createElement('ul');
    list.className = 'backlinks-list';
    list.setAttribute('aria-labelledby', 'backlinks-heading');
    const buttons = [];
    rows.forEach((r) => {
      const li = d.createElement('li');
      const b = d.createElement('button');
      b.type = 'button';
      b.className = 'backlink-item';
      b.dataset.uuid = r.sourceUuid;
      const t = d.createElement('span');
      t.className = 'backlink-title';
      t.textContent = r.title;
      const s = d.createElement('span');
      s.className = 'backlink-snippet muted';
      s.textContent = snippet(bodyOf(r.item), target);
      b.appendChild(t);
      b.appendChild(s);
      b.addEventListener('click', () => onOpen && onOpen(r.sourceUuid));
      b.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
        ev.preventDefault?.();
        const i = buttons.indexOf(b);
        const next = buttons[(i + (ev.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length];
        next?.focus?.();
      });
      buttons.push(b);
      li.appendChild(b);
      list.appendChild(li);
    });
    container.appendChild(list);
  }

  /**
   * Wire the index to a store: `store.onItemChanged(fn)` delivers a uuid for
   * one changed item, or null for "rebuild everything". Changes are batched
   * (300 ms) and `onChange(touchedTargets)` is called after each flush.
   */
  function connect({ store, titleOf, onChange, debounceMs = DEBOUNCE_MS, chunk, yieldFn } = {}) {
    const pending = new Set();
    let timer = null;
    let rebuild = false;
    const listIds = () => store.listNotes().map((n) => n.uuid);
    const getItem = (uuid) => store.get(uuid);

    function flush() {
      clearTimeout(timer);
      timer = null;
      if (!store.isUnlocked || store.isUnlocked()) {
        if (rebuild || status === 'idle') {
          rebuild = false;
          pending.clear();
          return start();
        }
        const touched = new Set();
        for (const uuid of pending) {
          update(uuid, getItem(uuid), touched);
        }
        pending.clear();
        if (onChange && touched.size) onChange(touched);
      } else {
        pending.clear();
      }
      return Promise.resolve();
    }

    function start() {
      const run = build({ listIds, getItem, chunk, yieldFn });
      if (onChange) onChange(null); // show "Indexing links…"
      return run.then((res) => {
        if (!res.aborted && onChange) onChange(null);
        return res;
      });
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    }

    const off = store.onItemChanged((uuid) => {
      if (uuid == null) rebuild = true;
      else pending.add(uuid);
      schedule();
    });
    const onClear = () => {
      clearTimeout(timer);
      timer = null;
      pending.clear();
      rebuild = false;
      if (onChange) onChange(null);
    };
    clearHooks.add(onClear);
    return {
      flush,
      ensureBuilt() {
        if (status === 'idle' && (!store.isUnlocked || store.isUnlocked())) return start();
        return building || Promise.resolve();
      },
      render(container, target, onOpen, doc) {
        renderPanel(container, { target, getItem, titleOf, onOpen, doc });
      },
      disconnect() {
        clearTimeout(timer);
        clearHooks.delete(onClear);
        if (typeof off === 'function') off();
      },
    };
  }

  const api = {
    update, build, linksTo, outgoingOf, snippet, clear, stats, renderPanel, connect,
    get status() { return status; },
  };
  if (typeof window !== 'undefined') window.NotesBacklinks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
