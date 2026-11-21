// Contacts duplicates screen (docs/CONTACTS_SPEC.md 7.10): find groups of contacts that are probably the same
// person, review them side by side, merge them or remove the extra ones, undo the last action. The matching and the
// merge result come from NotesContacts (findDuplicateGroups, planMerge); storing goes through the host callbacks,
// i.e. the normal vault paths, so sync and other devices follow. Everything shown is set with textContent; nothing
// decrypted is kept outside this module's variables and the DOM, and lock or leaving the screen clears all of it.
const NotesContactsDuplicates = (() => {
  const MAX_SHOWN = 20; // groups drawn at once; the next ones appear as these are dealt with
  const REASON_TEXT = { email: 'same email address', phone: 'same phone number', name: 'same name only' };
  let hooks = null;
  let ui = false;
  let contacts = [];
  let byId = new Map();
  let dismissed = new Set(); // group keys marked "Not duplicates" (this session)
  let skipped = new Set(); // group keys skipped on this screen
  let states = new Map(); // group key -> { keep, picks }
  let undoRecord = null; // { label, ops: [{ keptId, keptPatch, removed: [snapshot] }] }
  let pair = null; // [idA, idB] when opened from "Merge with..."
  let busy = false;
  let lastGroups = [];

  const el = (id) => document.getElementById(id);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const copy = (value) => JSON.parse(JSON.stringify(value));

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function nameOf(c) { return hooks.name(c); }

  function setStatus(text) { el('contacts-dup-status').textContent = text; }

  function loadContacts() {
    contacts = hooks.listContacts();
    byId = new Map(contacts.map((c) => [c.uuid, c]));
  }

  function currentGroups() {
    if (pair) {
      const ids = pair.filter((id) => byId.has(id));
      if (ids.length < 2) return [];
      return [{ kind: 'pair', key: NotesContacts.groupKey(ids), ids, reasons: [], via: [] }];
    }
    return NotesContacts.findDuplicateGroups(contacts, { ignore: dismissed }).filter((g) => !skipped.has(g.key));
  }

  function stateFor(group) {
    let st = states.get(group.key);
    if (!st) {
      st = { keep: NotesContacts.pickKeeper(group.ids.map((id) => byId.get(id))).uuid, picks: {} };
      states.set(group.key, st);
    }
    return st;
  }

  function reasonText(group) {
    if (group.kind === 'pair') return 'Chosen by you';
    const via = group.via.length ? `: ${group.via.join(', ')}` : '';
    if (group.kind === 'possible') return `Possible duplicate, ${REASON_TEXT.name}`;
    return `Matched on ${group.reasons.map((r) => REASON_TEXT[r]).join(' and ')}${via}`;
  }

  function entryList(label, entries) {
    const values = (entries || []).map((e) => e.value).filter(Boolean);
    if (!values.length) return null;
    const p = make('p', 'contacts-dup-line');
    p.append(make('span', 'muted', `${label} `), document.createTextNode(values.join(', ')));
    return p;
  }

  function cardFor(c, group, st, index, onKeep) {
    const label = make('label', 'contacts-dup-card');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `contacts-dup-keep-${index}`;
    radio.value = c.uuid;
    radio.checked = st.keep === c.uuid;
    radio.setAttribute('aria-label', `Keep ${nameOf(c)}`);
    radio.addEventListener('change', () => { st.keep = c.uuid; st.picks = {}; onKeep(); });
    const head = make('span', 'contacts-dup-card-head');
    head.append(radio, hooks.avatar(c), make('strong', 'contacts-dup-name', nameOf(c)));
    const body = make('span', 'contacts-dup-card-body');
    const org = [c.org && c.org.name, c.org && c.org.unit].filter(Boolean).join(', ');
    if (org) body.append(make('p', 'contacts-dup-line', org));
    for (const p of [entryList('Phone', c.phones), entryList('Email', c.emails)]) if (p) body.append(p);
    body.append(make('p', 'contacts-dup-line muted', `${NotesContacts.filledCount(c)} fields filled`));
    label.append(head, body, make('span', 'contacts-dup-keep-tag', 'Keep this one'));
    return label;
  }

  function optionText(field, option) {
    const v = option.value;
    let text;
    if (field === 'name') text = nameOf({ name: v, org: {}, emails: [], phones: [] });
    else if (field === 'org') text = [v.name, v.unit].filter(Boolean).join(', ');
    else if (field === 'photo') text = 'Photo';
    else text = String(v);
    const from = option.from.map((id) => nameOf(byId.get(id))).join(' and ');
    return `${text} (from ${from})`;
  }

  const FIELD_LABEL = { name: 'Name', nickname: 'Nickname', org: 'Organisation', title: 'Job title', birthday: 'Birthday', photo: 'Picture' };

  function renderChoices(box, group, st, index) {
    box.replaceChildren();
    const choices = NotesContacts.mergeChoices(group.ids.map((id) => byId.get(id)), st.keep);
    if (!choices.length) return;
    box.append(make('p', 'contacts-dup-line muted', 'These values differ. Choose which one the merged contact gets; phone numbers, emails, addresses and the rest are all kept.'));
    for (const choice of choices) {
      const wrap = make('label', 'contacts-dup-choice');
      const id = `contacts-dup-pick-${index}-${choice.field}`;
      wrap.append(make('span', null, FIELD_LABEL[choice.field]));
      const select = document.createElement('select');
      select.id = id;
      choice.options.forEach((option, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = optionText(choice.field, option);
        select.append(o);
      });
      select.value = String(st.picks[choice.field] || 0);
      select.addEventListener('change', () => { st.picks[choice.field] = Number(select.value); });
      wrap.append(select);
      box.append(wrap);
    }
  }

  function groupTitle(group) {
    const names = group.ids.map((id) => nameOf(byId.get(id)));
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
  }

  function renderGroup(group, index, total) {
    const st = stateFor(group);
    const section = make('section', `contacts-dup-group${group.kind === 'possible' ? ' possible' : ''}`);
    const hid = `contacts-dup-h-${index}`;
    section.setAttribute('aria-labelledby', hid);
    const h = make('h3', 'contacts-dup-title', `${index + 1} of ${total}: ${groupTitle(group)}`);
    h.id = hid;
    h.tabIndex = -1;
    section.append(h, make('p', 'contacts-dup-reason muted', reasonText(group)));
    const cards = make('div', 'contacts-dup-cards');
    cards.setAttribute('role', 'radiogroup');
    cards.setAttribute('aria-label', 'Contact to keep');
    const choices = make('div', 'contacts-dup-choices');
    const members = group.ids.map((id) => byId.get(id));
    const refresh = () => {
      cards.replaceChildren(...members.map((c) => cardFor(c, group, st, index, refresh)));
      renderChoices(choices, group, st, index);
    };
    refresh();
    const actions = make('div', 'contacts-dup-actions');
    const btn = (text, label, onClick, cls = 'btn') => {
      const b = make('button', cls, text);
      b.type = 'button';
      b.setAttribute('aria-label', `${label}: ${groupTitle(group)}`);
      b.addEventListener('click', onClick);
      return b;
    };
    actions.append(
      btn('Merge', 'Merge', () => run(() => mergeGroup(group))),
      btn('Remove duplicates', 'Remove duplicates, keep the selected contact', () => run(() => removeGroup(group)), 'btn ghost danger'),
      btn('Not duplicates', 'Not duplicates', () => { dismissed.add(group.key); afterAction(index, 'Marked as not duplicates for this session.'); }, 'btn ghost'),
      btn('Skip', 'Skip', () => { skipped.add(group.key); afterAction(index, 'Skipped.'); }, 'btn ghost'),
    );
    section.append(cards, choices, actions);
    return section;
  }

  function render(focusIndex = -1) {
    const list = el('contacts-dup-list');
    const groups = currentGroups();
    lastGroups = groups;
    list.replaceChildren(...groups.slice(0, MAX_SHOWN).map((g, i) => renderGroup(g, i, groups.length)));
    const more = el('contacts-dup-more');
    more.hidden = groups.length <= MAX_SHOWN;
    more.textContent = `Showing the first ${MAX_SHOWN} of ${groups.length} groups. The next ones appear as you deal with these.`;
    const exact = groups.filter((g) => g.kind === 'exact');
    const exactContacts = exact.reduce((n, g) => n + g.ids.length, 0);
    const all = el('contacts-dup-merge-all');
    all.hidden = exact.length === 0;
    all.textContent = exact.length ? `Merge all exact matches (${plural(exact.length, 'group', 'groups')})` : 'Merge all exact matches';
    all.setAttribute('aria-label', exact.length ? `Merge all exact matches: ${plural(exact.length, 'group', 'groups')}, ${plural(exactContacts, 'contact', 'contacts')}` : 'Merge all exact matches');
    el('contacts-dup-empty').hidden = groups.length > 0;
    el('contacts-dup-empty').textContent = pair ? 'Nothing left to review here.' : (contacts.length < 2 ? 'There are fewer than two contacts.' : 'No duplicates found.');
    const undo = el('contacts-dup-undo');
    undo.hidden = !undoRecord;
    if (undoRecord) { undo.textContent = 'Undo'; undo.setAttribute('aria-label', `Undo: ${undoRecord.label}`); }
    if (focusIndex >= 0) {
      const target = list.querySelectorAll('.contacts-dup-title')[Math.min(focusIndex, list.children.length - 1)];
      (target || el('contacts-dup-close')).focus();
    }
  }

  function afterAction(index, message) {
    setStatus(message);
    render(index);
  }

  async function run(fn) {
    if (busy) return;
    busy = true;
    el('contacts-dup-dialog').setAttribute('aria-busy', 'true');
    try { await fn(); } finally {
      busy = false;
      el('contacts-dup-dialog').removeAttribute('aria-busy');
    }
  }

  // Applies one merge or removal and returns its undo operation, or null when nothing was changed.
  function apply(group, st, mode) {
    const members = group.ids.map((id) => byId.get(id)).filter(Boolean);
    const keep = byId.get(st.keep);
    if (!keep || members.length < 2) return null;
    let patch = null;
    let removeIds;
    if (mode === 'merge') {
      const plan = NotesContacts.planMerge(members, keep.uuid, st.picks);
      if (plan.error) { setStatus(`Not merged: ${plan.error}.`); return null; }
      patch = plan.patch;
      removeIds = plan.removeIds;
    } else removeIds = members.filter((c) => c.uuid !== keep.uuid).map((c) => c.uuid);
    const op = { keptId: keep.uuid, keptPatch: patch ? NotesContacts.restorePatch(keep) : null, removed: removeIds.map((id) => { const s = copy(byId.get(id)); delete s.uuid; return s; }) };
    if (patch && hooks.updateContact(keep.uuid, patch) === null) return null;
    for (const id of removeIds) hooks.removeContact(id);
    return op;
  }

  function finish(ops, label, message) {
    undoRecord = ops.length ? { label, ops } : null;
    if (ops.length) hooks.changed();
    loadContacts();
    return message;
  }

  async function mergeGroup(group) {
    const op = apply(group, stateFor(group), 'merge');
    if (!op) { render(); return; }
    const n = op.removed.length + 1;
    const message = finish([op], `merged ${plural(n, 'contact', 'contacts')}`, `Merged ${plural(n, 'contact', 'contacts')} into 1. Undo is available.`);
    setStatus(message);
    render(lastGroups.indexOf(group));
  }

  async function removeGroup(group) {
    const op = apply(group, stateFor(group), 'remove');
    if (!op) { render(); return; }
    const n = op.removed.length;
    setStatus(finish([op], `removed ${plural(n, 'contact', 'contacts')}`, `Removed ${plural(n, 'duplicate', 'duplicates')}, kept ${nameOf(byId.get(op.keptId))}. Undo is available.`));
    render(lastGroups.indexOf(group));
  }

  async function mergeAllExact() {
    const exact = lastGroups.filter((g) => g.kind === 'exact');
    if (!exact.length) return;
    const total = exact.reduce((n, g) => n + g.ids.length, 0);
    const ok = await hooks.confirm(
      `Merge ${plural(exact.length, 'group', 'groups')} of contacts with the same email address or phone number? This affects ${plural(total, 'contact', 'contacts')}: they become ${exact.length}, and ${total - exact.length} are deleted from all your devices. Groups matched only by name are not touched. You can undo this until you leave this screen.`,
      { title: 'Merge all exact matches', confirmLabel: `Merge ${plural(total, 'contact', 'contacts')}`, danger: true },
    );
    if (!ok || !hooks.isUnlocked()) return;
    await run(async () => {
      const ops = [];
      let failed = 0;
      for (let i = 0; i < exact.length; i += 1) {
        const op = apply(exact[i], stateFor(exact[i]), 'merge');
        if (op) ops.push(op); else failed += 1;
        if (i % 20 === 19) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const removed = ops.reduce((n, op) => n + op.removed.length, 0);
      const base = `Merged ${plural(ops.reduce((n, op) => n + op.removed.length + 1, 0), 'contact', 'contacts')} into ${ops.length}`;
      const tail = failed ? ` ${plural(failed, 'group was', 'groups were')} left alone because the result would not fit in one contact.` : '';
      setStatus(`${finish(ops, `merged ${plural(removed + ops.length, 'contact', 'contacts')} in ${plural(ops.length, 'group', 'groups')}`, `${base}.${tail}`)}${ops.length ? ' Undo is available.' : ''}`);
      render(0);
    });
  }

  function undo() {
    const rec = undoRecord;
    if (!rec || busy || !hooks.isUnlocked()) return;
    undoRecord = null;
    let restored = 0;
    let failed = 0;
    for (const op of [...rec.ops].reverse()) {
      if (op.keptPatch) hooks.updateContact(op.keptId, op.keptPatch);
      for (const snap of op.removed) {
        try { hooks.addContact(snap); restored += 1; } catch (err) { failed += 1; }
      }
    }
    hooks.changed();
    loadContacts();
    states = new Map();
    setStatus(failed
      ? `Undone: ${plural(restored, 'contact', 'contacts')} restored, ${plural(failed, 'contact', 'contacts')} could not be restored.`
      : `Undone: ${plural(restored, 'contact', 'contacts')} restored.`);
    render(0);
  }

  // --- "Merge with..." on a contact: pick the second contact -------------------------------------
  function renderPick(query) {
    const list = el('contacts-dup-pick-list');
    const from = pair && pair[0];
    const matches = NotesContacts.filterContacts(contacts.filter((c) => c.uuid !== from), query, '', false).slice(0, 50);
    list.replaceChildren(...matches.map((c) => {
      const li = document.createElement('li');
      const b = make('button', 'btn ghost contacts-dup-pick-btn');
      b.type = 'button';
      b.append(hooks.avatar(c), make('span', null, nameOf(c)));
      b.addEventListener('click', () => { pair = [from, c.uuid]; showView('review'); setStatus(`Merging ${nameOf(byId.get(from))} with ${nameOf(c)}.`); render(0); });
      li.append(b);
      return li;
    }));
    el('contacts-dup-pick-empty').hidden = matches.length > 0;
  }

  function showView(view) {
    el('contacts-dup-review').hidden = view !== 'review';
    el('contacts-dup-pick').hidden = view !== 'pick';
    el('contacts-dup-title').textContent = view === 'pick' ? 'Merge with another contact' : (pair ? 'Merge contacts' : 'Find duplicates');
  }

  function close() {
    if (busy || !el('contacts-dup-dialog')) return;
    reset();
  }

  // Lock, sign-out or leaving the screen: forget the contacts, the undo record and the session choices.
  function reset() {
    busy = false;
    contacts = [];
    byId = new Map();
    states = new Map();
    skipped = new Set();
    undoRecord = null;
    pair = null;
    lastGroups = [];
    if (!el('contacts-dup-dialog')) return;
    el('contacts-dup-list').replaceChildren();
    el('contacts-dup-pick-list').replaceChildren();
    el('contacts-dup-search').value = '';
    setStatus('');
    el('contacts-dup-dialog').hidden = true;
    el('contacts-dup-backdrop').hidden = true;
    document.body.classList.remove('scan-dialog-open');
  }

  // Not duplicates stay dismissed for the whole session (until sign-out or lock), also across screens.
  function forgetSession() { dismissed = new Set(); reset(); }

  // hooks: { isUnlocked, listContacts, updateContact, addContact, removeContact, avatar(c), name(c), confirm(msg, opts), changed() }
  // options.withId: open the "Merge with..." picker for that contact instead of the detection.
  function open(h, options = {}) {
    hooks = h;
    if (!hooks.isUnlocked()) return false;
    init();
    reset();
    loadContacts();
    skipped = new Set();
    undoRecord = null;
    el('contacts-dup-dialog').hidden = false;
    el('contacts-dup-backdrop').hidden = false;
    document.body.classList.add('scan-dialog-open');
    if (options.withId && byId.has(options.withId)) {
      pair = [options.withId];
      showView('pick');
      renderPick('');
      el('contacts-dup-search').focus();
    } else {
      showView('review');
      render();
      const n = lastGroups.length;
      setStatus(n ? `${plural(n, 'group', 'groups')} of possible duplicates found among ${plural(contacts.length, 'contact', 'contacts')}.` : '');
      (el('contacts-dup-list').querySelector('.contacts-dup-title') || el('contacts-dup-close')).focus();
    }
    return true;
  }

  function init() {
    if (ui || !el('contacts-dup-dialog')) return;
    ui = true;
    el('contacts-dup-close').addEventListener('click', close);
    el('contacts-dup-backdrop').addEventListener('click', close);
    el('contacts-dup-undo').addEventListener('click', undo);
    el('contacts-dup-merge-all').addEventListener('click', mergeAllExact);
    el('contacts-dup-search').addEventListener('input', (event) => renderPick(event.target.value));
    el('contacts-dup-dialog').addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  }

  return { open, close, reset: forgetSession, init };
})();

if (typeof window !== 'undefined') window.NotesContactsDuplicates = NotesContactsDuplicates;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesContactsDuplicates;
