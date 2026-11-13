// Accessible label tree (WAI-ARIA tree pattern) for the sidebar.
// Pure helpers: rows, markup, keyboard navigation, expand-state persistence.
// Expand state stores only random label uuids, never label names.
(() => {
  const OPEN_KEY = 'notes_label_open';
  const L = () => (typeof NotesLabels !== 'undefined' ? NotesLabels : globalThis.NotesLabels);

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  function byOrderThenName(byId) {
    return (a, b) => {
      const ca = byId.get(a);
      const cb = byId.get(b);
      const oa = typeof ca.order === 'number' ? ca.order : Infinity;
      const ob = typeof cb.order === 'number' ? cb.order : Infinity;
      if (oa !== ob) return oa < ob ? -1 : 1;
      const n = L().nameOf(ca).localeCompare(L().nameOf(cb));
      return n || (a < b ? -1 : 1);
    };
  }

  // Map parent uuid ('' = top level) -> sorted child uuids. Orphans and cycle
  // members are shown at the top level (repair-on-read, in memory only).
  function childMap(byId) {
    const cmp = byOrderThenName(byId);
    const direct = new Map();
    for (const [id, c] of byId) {
      let pid = L().parentOf(c);
      if (!byId.has(pid) || pid === id) pid = '';
      if (!direct.has(pid)) direct.set(pid, []);
      direct.get(pid).push(id);
    }
    const reach = new Set();
    const walk = (id) => {
      if (reach.has(id)) return;
      reach.add(id);
      (direct.get(id) || []).forEach(walk);
    };
    (direct.get('') || []).forEach(walk);
    for (const id of [...byId.keys()].sort(cmp)) {
      if (reach.has(id)) continue; // cycle: promote the first one found to the top level
      const pid = L().parentOf(byId.get(id));
      const list = direct.get(pid) || [];
      direct.set(pid, list.filter((x) => x !== id));
      if (!direct.has('')) direct.set('', []);
      direct.get('').push(id);
      walk(id);
    }
    const map = new Map();
    map.set('', (direct.get('') || []).sort(cmp));
    for (const id of byId.keys()) map.set(id, (direct.get(id) || []).sort(cmp));
    return map;
  }

  // Visible rows in DOM order (children of collapsed labels are skipped).
  function visibleRows(byId, open) {
    const kids = childMap(byId);
    const rows = [];
    const walk = (parent, level) => {
      const list = kids.get(parent) || [];
      list.forEach((id, i) => {
        const hasChildren = (kids.get(id) || []).length > 0;
        const expanded = hasChildren && open.has(id);
        rows.push({ uuid: id, parent, level, posinset: i + 1, setsize: list.length, hasChildren, expanded });
        if (expanded) walk(id, level + 1);
      });
    };
    walk('', 1);
    return rows;
  }

  // ctx: {open:Set, selected, active, count(uuid), color(uuid) -> safe css colour}
  function html(byId, ctx) {
    const kids = childMap(byId);
    const roots = kids.get('');
    const rows = visibleRows(byId, ctx.open);
    const tabbable = ctx.active && rows.some((r) => r.uuid === ctx.active) ? ctx.active : (rows[0] ? rows[0].uuid : '');
    const item = (id, level, pos, size) => {
      const c = byId.get(id);
      const sub = kids.get(id) || [];
      const expanded = sub.length > 0 && ctx.open.has(id);
      const sel = ctx.selected === id;
      const name = L().nameOf(c);
      const count = ctx.count(id);
      return `<li role="none" class="label-node"><div role="treeitem" class="label-item${sel ? ' active' : ''}" data-label="${esc(id)}"`
        + ` aria-level="${level}" aria-posinset="${pos}" aria-setsize="${size}" aria-selected="${sel ? 'true' : 'false'}"`
        + (sub.length ? ` aria-expanded="${expanded ? 'true' : 'false'}"` : '')
        + ` aria-label="${esc(name)}, ${count}" tabindex="${id === tabbable ? '0' : '-1'}" draggable="true" style="--tag-color:${ctx.color(id)};--label-level:${level - 1}">`
        + `<span class="label-twisty" data-label-toggle="${esc(id)}" aria-hidden="true">${sub.length ? (expanded ? '▾' : '▸') : ''}</span>`
        + `<span class="tag-dot" aria-hidden="true"></span><span class="tag-name label-name">${esc(name)}</span>`
        + `<span class="tag-count" aria-hidden="true">${count}</span>`
        + `<button type="button" class="label-menu-btn" data-label-menu="${esc(id)}" tabindex="-1" aria-haspopup="menu" aria-label="Actions for ${esc(name)}">⋯</button></div>`
        + (sub.length ? `<ul role="group" class="label-group"${expanded ? '' : ' hidden'}>${expanded ? sub.map((s, i) => item(s, level + 1, i + 1, sub.length)).join('') : ''}</ul>` : '')
        + '</li>';
    };
    return `<ul role="tree" class="label-tree" aria-label="Labels">${roots.map((r, i) => item(r, 1, i + 1, roots.length)).join('')}</ul>`;
  }

  // Keyboard model. Returns one of {focus, expand, collapse, select, rename, menu} (uuid values).
  function navigate(rows, activeId, key) {
    if (!rows.length) return {};
    const found = rows.findIndex((r) => r.uuid === activeId);
    const at = found < 0 ? 0 : found;
    const cur = rows[at];
    switch (key) {
      case 'ArrowDown': return { focus: rows[Math.min(at + 1, rows.length - 1)].uuid };
      case 'ArrowUp': return { focus: rows[Math.max(at - 1, 0)].uuid };
      case 'Home': return { focus: rows[0].uuid };
      case 'End': return { focus: rows[rows.length - 1].uuid };
      case 'ArrowRight':
        if (cur.hasChildren && !cur.expanded) return { expand: cur.uuid };
        if (cur.hasChildren && cur.expanded) return { focus: rows[at + 1].uuid };
        return {};
      case 'ArrowLeft':
        if (cur.hasChildren && cur.expanded) return { collapse: cur.uuid };
        if (cur.parent) return { focus: cur.parent };
        return {};
      case 'Enter': case ' ': return { select: cur.uuid };
      case 'F2': return { rename: cur.uuid };
      case 'ContextMenu': return { menu: cur.uuid };
      default: return {};
    }
  }

  // Label ids a filter on `uuid` must match: the label and every sub-label.
  function scope(uuid, byId) {
    return uuid ? [uuid, ...L().descendants(uuid, byId)] : [];
  }

  // Valid new parents for `uuid` (not itself, not a descendant, not too deep).
  function moveTargets(uuid, byId) {
    const out = [];
    for (const id of byId.keys()) {
      if (id !== uuid && L().validateParent(uuid, id, byId).ok) out.push(id);
    }
    return out.sort((a, b) => L().pathOf(a, byId).localeCompare(L().pathOf(b, byId)));
  }

  function loadOpen(storage) {
    try {
      const v = JSON.parse(storage.getItem(OPEN_KEY) || '[]');
      return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    } catch (err) {
      return new Set();
    }
  }

  function saveOpen(storage, open) {
    try { storage.setItem(OPEN_KEY, JSON.stringify([...open])); } catch (err) { /* ignore */ }
  }

  const api = { OPEN_KEY, visibleRows, html, navigate, scope, moveTargets, loadOpen, saveOpen };
  if (typeof window !== 'undefined') window.NotesLabelTree = api;
  if (typeof globalThis !== 'undefined') globalThis.NotesLabelTree = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
