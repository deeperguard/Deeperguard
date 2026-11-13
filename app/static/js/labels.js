// Nested labels: pure data-model helpers (docs/NOTES_ORGANIZATION_SPEC.md, section 1).
// Everything here works on already decrypted label content. Nothing in this file
// talks to the server; name, parent_id, order and title_sync only ever exist
// inside the encrypted item payload.
(() => {
  const SEP = ' / ';
  const MAX_DEPTH = 8; // levels, a root label is depth 1
  const MAX_LABELS = 2000;
  const MAX_NAME = 64;
  const ORDER_STEP = 1024;

  const nameOf = (c) => String((c && (c.name !== undefined ? c.name : c.title)) || '');
  const parentOf = (c) => String((c && c.parent_id) || '');
  const key = (s) => String(s || '').trim().toLowerCase();

  // records: iterable of {uuid, content}; returns Map uuid -> content (type 'tag' only).
  function indexOf(records) {
    const map = new Map();
    for (const r of records || []) {
      if (r && r.content && r.content.type === 'tag' && !r.deleted) map.set(r.uuid, r.content);
    }
    return map;
  }

  function validateName(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) return { ok: false, error: 'empty' };
    if (n.length > MAX_NAME) return { ok: false, error: 'too_long' };
    if (n.includes('/')) return { ok: false, error: 'slash' };
    return { ok: true, name: n };
  }

  // Ancestor chain, nearest parent first. Stops at unknown parents and on cycles.
  function ancestors(uuid, byId) {
    const out = [];
    const seen = new Set([uuid]);
    let cur = byId.get(uuid);
    while (cur) {
      const pid = parentOf(cur);
      if (!pid || seen.has(pid) || !byId.has(pid)) break;
      out.push(pid);
      seen.add(pid);
      cur = byId.get(pid);
    }
    return out;
  }

  function depthOf(uuid, byId) {
    return ancestors(uuid, byId).length + 1;
  }

  function childrenOf(uuid, byId) {
    const out = [];
    for (const [id, c] of byId) if (parentOf(c) === (uuid || '') && id !== uuid) out.push(id);
    return out;
  }

  // All descendants (breadth first); cycle safe.
  function descendants(uuid, byId) {
    const out = [];
    const seen = new Set([uuid]);
    let level = [uuid];
    while (level.length) {
      const next = [];
      for (const id of level) {
        for (const child of childrenOf(id, byId)) {
          if (seen.has(child)) continue;
          seen.add(child);
          out.push(child);
          next.push(child);
        }
      }
      level = next;
    }
    return out;
  }

  function subtreeHeight(uuid, byId) {
    let height = 1;
    for (const d of descendants(uuid, byId)) {
      height = Math.max(height, depthOf(d, byId) - depthOf(uuid, byId) + 1);
    }
    return height;
  }

  function siblingNameTaken(name, parentId, byId, exceptUuid) {
    const k = key(name);
    for (const [id, c] of byId) {
      if (id === exceptUuid || parentOf(c) !== (parentId || '')) continue;
      if (key(nameOf(c)) === k) return true;
    }
    return false;
  }

  // Can `uuid` (existing label, or null for a new leaf) live under `parentId`?
  function validateParent(uuid, parentId, byId) {
    const pid = parentId || '';
    if (!pid) return { ok: true };
    if (!byId.has(pid)) return { ok: false, error: 'unknown_parent' };
    if (uuid && (pid === uuid || descendants(uuid, byId).includes(pid))) return { ok: false, error: 'cycle' };
    const height = uuid ? subtreeHeight(uuid, byId) : 1;
    if (depthOf(pid, byId) + height > MAX_DEPTH) return { ok: false, error: 'too_deep' };
    return { ok: true };
  }

  function pathOf(uuid, byId) {
    const chain = [uuid, ...ancestors(uuid, byId)].reverse();
    return chain.map((id) => nameOf(byId.get(id))).join(SEP);
  }

  function nextOrder(parentId, byId) {
    let max = 0;
    for (const c of byId.values()) {
      if (parentOf(c) === (parentId || '') && typeof c.order === 'number') max = Math.max(max, c.order);
    }
    return max + ORDER_STEP;
  }

  // Migration of legacy flat labels: pure, lossless, idempotent.
  // Returns [{uuid, content}] only for labels that must change; every existing
  // field (uuid, color, unknown fields) is kept via spread. Running it on its own
  // output returns [].
  function migrate(records) {
    const byId = indexOf(records);
    const legacy = [...byId].filter(([, c]) => c.name === undefined);
    legacy.sort((a, b) => String(a[1].title || '').localeCompare(String(b[1].title || '')) || (a[0] < b[0] ? -1 : 1));
    const updates = [];
    let order = nextOrder('', byId) - ORDER_STEP;
    for (const [uuid, c] of legacy) {
      const title = String(c.title || '');
      order += ORDER_STEP;
      updates.push({
        uuid,
        content: { ...c, name: title, parent_id: parentOf(c), order, title_sync: title },
      });
    }
    return updates;
  }

  // Repair on read (spec 1.6), pure: returns [{uuid, content}] of labels to rewrite.
  //  - old client renamed (title !== title_sync): adopt title as name
  //  - unknown parent -> root; cycle -> the link with the oldest updated_at becomes root
  function repair(records) {
    const byId = new Map([...indexOf(records)].map(([id, c]) => [id, { ...c }]));
    const changed = new Set();
    for (const [id, c] of byId) {
      if (c.title_sync !== undefined && c.name !== undefined && c.title !== c.title_sync) {
        const leaf = String(c.title || '').split('/').pop().trim();
        if (leaf) { c.name = leaf.slice(0, MAX_NAME); changed.add(id); }
      }
      if (parentOf(c) && !byId.has(parentOf(c))) { c.parent_id = ''; changed.add(id); }
    }
    for (const id of [...byId.keys()].sort()) {
      const seen = [];
      let cur = id;
      while (cur && !seen.includes(cur)) {
        seen.push(cur);
        cur = parentOf(byId.get(cur));
      }
      if (!cur) continue;
      const loop = seen.slice(seen.indexOf(cur));
      loop.sort((a, b) => String(byId.get(a).updated_at || '').localeCompare(String(byId.get(b).updated_at || '')) || (a < b ? -1 : 1));
      byId.get(loop[0]).parent_id = '';
      changed.add(loop[0]);
    }
    // Refresh compat titles for anything touched, and for all descendants.
    const refresh = new Set(changed);
    for (const id of changed) for (const d of descendants(id, byId)) refresh.add(d);
    const out = [];
    for (const id of refresh) {
      const c = byId.get(id);
      if (c.name === undefined) continue;
      const title = pathOf(id, byId);
      c.title = title;
      c.title_sync = title;
    }
    for (const id of changed) out.push({ uuid: id, content: byId.get(id) });
    for (const id of refresh) if (!changed.has(id)) out.push({ uuid: id, content: byId.get(id) });
    return out.filter((u) => {
      const before = indexOf(records).get(u.uuid);
      return JSON.stringify(before) !== JSON.stringify(u.content);
    });
  }

  // Content for `uuid` after a rename or move, plus new compat titles for its subtree.
  // Pure; the caller upserts the returned records. Returns {ok:false,error} on rejection.
  function planUpdate(uuid, patch, byId) {
    const cur = byId.get(uuid);
    if (!cur) return { ok: false, error: 'unknown_label' };
    const name = patch.name !== undefined ? validateName(patch.name) : { ok: true, name: nameOf(cur) };
    if (!name.ok) return name;
    const parentId = patch.parent_id !== undefined ? patch.parent_id || '' : parentOf(cur);
    const pv = validateParent(uuid, parentId, byId);
    if (!pv.ok) return pv;
    if (siblingNameTaken(name.name, parentId, byId, uuid)) return { ok: false, error: 'duplicate' };
    const next = new Map(byId);
    const moved = parentId !== parentOf(cur);
    next.set(uuid, {
      ...cur,
      name: name.name,
      parent_id: parentId,
      order: moved || typeof cur.order !== 'number' ? nextOrder(parentId, byId) : cur.order,
    });
    const updates = [];
    for (const id of [uuid, ...descendants(uuid, next)]) {
      const c = next.get(id);
      const title = pathOf(id, next);
      updates.push({ uuid: id, content: { ...c, name: nameOf(c), parent_id: parentOf(c), title, title_sync: title } });
    }
    return { ok: true, updates };
  }

  // Delete plan. mode 'promote' (default): children move to the deleted label's parent
  // (duplicate sibling names are kept, never auto-deleted). mode 'delete': the whole
  // subtree goes. Returns {remove:[uuid], updates:[{uuid, content}]}.
  function planDelete(uuid, mode, byId) {
    if (!byId.has(uuid)) return { remove: [], updates: [] };
    if (mode === 'delete') return { remove: [uuid, ...descendants(uuid, byId)], updates: [] };
    const next = new Map(byId);
    const up = parentOf(byId.get(uuid));
    const kids = childrenOf(uuid, byId);
    for (const id of kids) next.set(id, { ...next.get(id), parent_id: up });
    next.delete(uuid);
    const updates = [];
    for (const id of kids) {
      for (const t of [id, ...descendants(id, next)]) {
        const c = next.get(t);
        if (c.name === undefined) continue;
        const title = pathOf(t, next);
        updates.push({ uuid: t, content: { ...c, title, title_sync: title } });
      }
    }
    return { remove: [uuid], updates };
  }

  const api = {
    SEP, MAX_DEPTH, MAX_LABELS, MAX_NAME,
    indexOf, nameOf, parentOf, validateName, validateParent, ancestors, descendants,
    depthOf, subtreeHeight, siblingNameTaken, pathOf, nextOrder, migrate, repair, planUpdate, planDelete,
  };
  if (typeof window !== 'undefined') window.NotesLabels = api;
  if (typeof globalThis !== 'undefined') globalThis.NotesLabels = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
