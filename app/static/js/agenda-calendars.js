/**
 * Deeperguard Agenda — "My calendars" list in the calendar settings panel
 * (docs/design/calendar-multi.md §1, milestone M2).
 *
 * Create, rename, recolor, show/hide and delete calendars. Colors come from a fixed palette of
 * keys (never free hex); every key has a text color with at least 4.5:1 contrast, checked by
 * tests/test_agenda_calendars_ui.js via tests/agenda_contrast_utils.js. Events always show the
 * calendar name next to the color, so color is never the only cue.
 *
 * All controls are native buttons, inputs, radios and selects, so keyboard and screen readers
 * work without custom key handling. Calendar names stay inside the encrypted pack: nothing here
 * writes them to localStorage or the console (§6 R7).
 */
(function (global) {
  /** Fixed palette; `text` is the label color drawn on `bg`. Order = picker order. */
  const PALETTE = [
    { key: 'blue', name: 'Blue', bg: '#1d4ed8', text: '#ffffff' },
    { key: 'teal', name: 'Teal', bg: '#0f766e', text: '#ffffff' },
    { key: 'green', name: 'Green', bg: '#15803d', text: '#ffffff' },
    { key: 'amber', name: 'Amber', bg: '#b45309', text: '#ffffff' },
    { key: 'orange', name: 'Orange', bg: '#c2410c', text: '#ffffff' },
    { key: 'red', name: 'Red', bg: '#b91c1c', text: '#ffffff' },
    { key: 'pink', name: 'Pink', bg: '#be185d', text: '#ffffff' },
    { key: 'purple', name: 'Purple', bg: '#6d28d9', text: '#ffffff' },
    { key: 'slate', name: 'Slate', bg: '#475569', text: '#ffffff' },
  ];
  const NAME_MAX = 60;

  /** Unknown keys (from a newer app) fall back to the first tint; the stored key is kept. */
  function paletteEntry(key) {
    const k = String(key || '').trim().toLowerCase();
    return PALETTE.find((p) => p.key === k) || PALETTE[0];
  }

  function cleanName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let storeOverride = null;
  function getStore() {
    return storeOverride || global.NotesStore;
  }

  function listCalendars() {
    const S = getStore();
    if (!S || typeof S.listAgendaCalendars !== 'function') return [];
    return S.listAgendaCalendars();
  }

  function calendarMap() {
    const out = new Map();
    listCalendars().forEach((c) => out.set(c.id, c));
    return out;
  }

  /** Calendar an event is shown in (missing/unknown calendarId = default calendar). */
  function calendarForEvent(ev, map) {
    const S = getStore();
    const m = map || calendarMap();
    const raw = String((ev && ev.calendarId) || '').trim();
    if (raw && m.has(raw)) return m.get(raw);
    const defId = S && S.DEFAULT_CALENDAR_ID;
    return m.get(defId) || [...m.values()][0] || null;
  }

  function isEventVisible(ev, map) {
    const cal = calendarForEvent(ev, map);
    return !cal || cal.visible !== false;
  }

  /** Small text label with the calendar name in its palette colors (not color alone). */
  function labelHtml(cal, extraClass) {
    if (!cal) return '';
    const p = paletteEntry(cal.color);
    return (
      `<span class="agenda-cal-label${extraClass ? ` ${extraClass}` : ''}" data-agenda-cal-color="${esc(p.key)}"`
      + ` style="background:${p.bg};color:${p.text}">${esc(cal.name || 'Agenda')}</span>`
    );
  }

  function eventCounts() {
    const S = getStore();
    const counts = new Map();
    if (!S || typeof S.listAgendaEvents !== 'function') return counts;
    const map = calendarMap();
    S.listAgendaEvents().forEach((ev) => {
      const cal = calendarForEvent(ev, map);
      if (cal) counts.set(cal.id, (counts.get(cal.id) || 0) + 1);
    });
    return counts;
  }

  // ---- actions (used by the UI and the tests) ----------------------------------

  function createCalendar(name, color) {
    const S = getStore();
    const n = cleanName(name);
    if (!S || !n) return '';
    const cals = listCalendars();
    const order = cals.reduce((m, c) => Math.max(m, Number(c.order) || 0), 0) + 1;
    return S.upsertAgendaCalendar(null, {
      name: n,
      color: paletteEntry(color).key,
      visible: true,
      order,
      default_reminders: [],
    });
  }

  function updateCalendar(id, patch) {
    const S = getStore();
    const cal = listCalendars().find((c) => c.id === id);
    if (!S || !cal) return false;
    const next = {};
    if (patch && 'name' in patch) {
      const n = cleanName(patch.name);
      if (!n) return false;
      next.name = n;
    }
    if (patch && 'color' in patch) next.color = paletteEntry(patch.color).key;
    if (patch && 'visible' in patch) next.visible = !!patch.visible;
    const { id: _drop, ...rest } = cal;
    S.upsertAgendaCalendar(id, { ...rest, ...next });
    return true;
  }

  const renameCalendar = (id, name) => updateCalendar(id, { name });
  const setCalendarColor = (id, color) => updateCalendar(id, { color });
  const setCalendarVisible = (id, visible) => updateCalendar(id, { visible });

  /** mode 'move' (events go to targetId, default calendar by default) or 'delete'. */
  function deleteCalendar(id, mode, targetId) {
    const S = getStore();
    if (!S || typeof S.removeAgendaCalendar !== 'function') return { ok: false, moved: 0, deletedEventIds: [] };
    const before = new Map((S.listAgendaEvents?.() || []).map((e) => [e.id, e]));
    const res = S.removeAgendaCalendar(id, { mode, targetId });
    const R = global.NotesAgendaReminders;
    if (res.ok && R && typeof R.cancelEventReminders === 'function') {
      res.deletedEventIds.forEach((evId) => {
        const ev = before.get(evId);
        if (ev) Promise.resolve(R.cancelEventReminders(evId, ev)).catch(() => {});
      });
    }
    return res;
  }

  // ---- rendering -------------------------------------------------------------

  /** UI state: which row is being edited ('new' for the create form) or confirmed for delete. */
  const ui = { editing: '', deleting: '' };

  function colorPickerHtml(prefix, selected) {
    const sel = paletteEntry(selected).key;
    return (
      `<fieldset class="agenda-cal-colors"><legend class="muted">Color</legend>`
      + PALETTE.map((p) => (
        `<label class="agenda-cal-color" title="${esc(p.name)}">`
        + `<input type="radio" name="${esc(prefix)}-color" value="${esc(p.key)}"${p.key === sel ? ' checked' : ''}>`
        + `<span class="agenda-cal-color-swatch" style="background:${p.bg};color:${p.text}" aria-hidden="true">Aa</span>`
        + `<span class="sr-only">${esc(p.name)}</span>`
        + '</label>'
      )).join('')
      + '</fieldset>'
    );
  }

  function editFormHtml(cal) {
    const isNew = !cal;
    const prefix = isNew ? 'agenda-cal-new' : `agenda-cal-edit-${cal.id}`;
    const title = isNew ? 'New calendar' : `Edit ${cal.name}`;
    return (
      `<form class="agenda-cal-form" data-agenda-cal-form="${isNew ? 'new' : esc(cal.id)}" aria-label="${esc(title)}">`
      + `<label class="settings-row stacked">Name`
      + `<input type="text" name="name" id="${esc(prefix)}-name" maxlength="${NAME_MAX}" required autocomplete="off"`
      + ` value="${esc(isNew ? '' : cal.name)}"></label>`
      + colorPickerHtml(prefix, isNew ? PALETTE[listCalendars().length % PALETTE.length].key : cal.color)
      + '<div class="agenda-cal-form-actions">'
      + `<button type="submit" class="btn primary sm">${isNew ? 'Create calendar' : 'Save'}</button>`
      + '<button type="button" class="btn ghost sm" data-agenda-cal-action="cancel">Cancel</button>'
      + '</div></form>'
    );
  }

  function deleteFormHtml(cal, cals, count) {
    const others = cals.filter((c) => c.id !== cal.id);
    const S = getStore();
    const defId = S && S.DEFAULT_CALENDAR_ID;
    const n = count === 1 ? '1 event' : `${count} events`;
    return (
      `<form class="agenda-cal-delete" data-agenda-cal-delete="${esc(cal.id)}" aria-label="${esc(`Delete ${cal.name}`)}">`
      + `<p class="settings-hint">Delete <strong>${esc(cal.name)}</strong>? It has ${esc(n)}. What should happen to them?</p>`
      + '<fieldset class="agenda-cal-delete-choice"><legend class="sr-only">Events in this calendar</legend>'
      + '<label class="settings-hint"><input type="radio" name="mode" value="move" checked> Move them to '
      + `<select name="target" aria-label="Calendar to move the events to">`
      + others.map((c) => `<option value="${esc(c.id)}"${c.id === defId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')
      + '</select></label>'
      + '<label class="settings-hint"><input type="radio" name="mode" value="delete"> Delete them too</label>'
      + '</fieldset>'
      + '<div class="agenda-cal-form-actions">'
      + '<button type="submit" class="btn danger sm">Delete calendar</button>'
      + '<button type="button" class="btn ghost sm" data-agenda-cal-action="cancel">Cancel</button>'
      + '</div></form>'
    );
  }

  function rowHtml(cal, cals, counts) {
    const p = paletteEntry(cal.color);
    const visible = cal.visible !== false;
    const name = cal.name || 'Agenda';
    let html = `<li class="agenda-cal-row${visible ? '' : ' is-hidden'}" data-agenda-cal-id="${esc(cal.id)}">`;
    html += '<div class="agenda-cal-row-main">';
    html += (
      `<label class="agenda-cal-toggle"><input type="checkbox" data-agenda-cal-action="toggle"${visible ? ' checked' : ''}`
      + ` aria-label="${esc(`Show ${name}`)}">`
      + `<span class="agenda-cal-dot" style="background:${p.bg}" aria-hidden="true"></span>`
      + `<span class="agenda-cal-name">${esc(name)}</span>`
      + `<span class="sr-only">, ${esc(p.name)}${visible ? '' : ', hidden'}</span></label>`
    );
    html += (
      `<button type="button" class="btn ghost sm" data-agenda-cal-action="edit" aria-label="${esc(`Rename or recolor ${name}`)}"`
      + ` aria-expanded="${ui.editing === cal.id ? 'true' : 'false'}">Edit</button>`
    );
    if (!cal.is_default) {
      html += (
        `<button type="button" class="btn ghost sm" data-agenda-cal-action="delete" aria-label="${esc(`Delete ${name}`)}"`
        + ` aria-expanded="${ui.deleting === cal.id ? 'true' : 'false'}">Delete</button>`
      );
    }
    html += '</div>';
    if (ui.editing === cal.id) html += editFormHtml(cal);
    if (ui.deleting === cal.id) html += deleteFormHtml(cal, cals, counts.get(cal.id) || 0);
    html += '</li>';
    return html;
  }

  function renderHtml() {
    const cals = listCalendars();
    const counts = eventCounts();
    let html = '<ul class="agenda-cal-list" aria-labelledby="agenda-calendars-heading">';
    cals.forEach((c) => { html += rowHtml(c, cals, counts); });
    html += '</ul>';
    if (ui.editing === 'new') html += editFormHtml(null);
    else {
      html += (
        '<button type="button" class="btn ghost sm agenda-cal-add" data-agenda-cal-action="new"'
        + ' aria-expanded="false">+ New calendar</button>'
      );
    }
    return html;
  }

  // ---- DOM wiring ------------------------------------------------------------

  let onChange = () => {};
  let wiredRoot = null;

  function root() {
    return typeof document !== 'undefined' ? document.getElementById('agenda-calendars-list') : null;
  }

  function announce(msg) {
    const live = typeof document !== 'undefined' && document.getElementById('agenda-calendars-status');
    if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = msg; }, 30);
  }

  function renderList(focusSelector) {
    const el = root();
    if (!el) return;
    el.innerHTML = renderHtml();
    if (focusSelector) {
      const target = el.querySelector(focusSelector);
      if (target) target.focus();
    }
  }

  function rowSel(id, action) {
    const safe = String(id).replace(/["\\]/g, '\\$&');
    return `[data-agenda-cal-id="${safe}"] [data-agenda-cal-action="${action}"]`;
  }

  function handleClick(ev) {
    const btn = ev.target.closest('[data-agenda-cal-action]');
    if (!btn || btn.getAttribute('data-agenda-cal-action') === 'toggle') return;
    const action = btn.getAttribute('data-agenda-cal-action');
    const id = btn.closest('[data-agenda-cal-id]')?.getAttribute('data-agenda-cal-id') || '';
    if (action === 'new') {
      ui.editing = 'new';
      ui.deleting = '';
      renderList('[data-agenda-cal-form="new"] input[name="name"]');
    } else if (action === 'edit') {
      ui.editing = ui.editing === id ? '' : id;
      ui.deleting = '';
      renderList(ui.editing ? `[data-agenda-cal-id] [data-agenda-cal-form] input[name="name"]` : rowSel(id, 'edit'));
    } else if (action === 'delete') {
      ui.deleting = ui.deleting === id ? '' : id;
      ui.editing = '';
      renderList(ui.deleting ? '[data-agenda-cal-delete] input[name="mode"]' : rowSel(id, 'delete'));
    } else if (action === 'cancel') {
      const wasNew = ui.editing === 'new';
      const back = ui.editing || ui.deleting;
      const backAction = ui.deleting ? 'delete' : 'edit';
      ui.editing = '';
      ui.deleting = '';
      renderList(wasNew ? '[data-agenda-cal-action="new"]' : rowSel(back, backAction));
    }
  }

  function handleChange(ev) {
    const cb = ev.target.closest('[data-agenda-cal-action="toggle"]');
    if (!cb) return;
    const id = cb.closest('[data-agenda-cal-id]')?.getAttribute('data-agenda-cal-id') || '';
    const cal = listCalendars().find((c) => c.id === id);
    if (!setCalendarVisible(id, cb.checked)) return;
    announce(`${cal ? cal.name : 'Calendar'} ${cb.checked ? 'shown' : 'hidden'}`);
    renderList(rowSel(id, 'toggle'));
    onChange();
  }

  function handleSubmit(ev) {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    ev.preventDefault();
    const fd = new FormData(form);
    const editId = form.getAttribute('data-agenda-cal-form');
    const delId = form.getAttribute('data-agenda-cal-delete');
    if (editId) {
      const name = cleanName(fd.get('name'));
      const color = [...form.querySelectorAll('input[type="radio"]')].find((r) => r.checked)?.value;
      if (!name) {
        form.querySelector('input[name="name"]')?.focus();
        announce('Enter a name for the calendar');
        return;
      }
      let id = editId;
      if (editId === 'new') {
        id = createCalendar(name, color);
        announce(`Calendar ${name} created`);
      } else {
        updateCalendar(editId, { name, color });
        announce(`Calendar ${name} saved`);
      }
      ui.editing = '';
      renderList(id ? rowSel(id, 'edit') : '[data-agenda-cal-action="new"]');
      onChange();
    } else if (delId) {
      const cal = listCalendars().find((c) => c.id === delId);
      const mode = fd.get('mode') === 'delete' ? 'delete' : 'move';
      const res = deleteCalendar(delId, mode, String(fd.get('target') || ''));
      ui.deleting = '';
      if (res.ok) {
        announce(mode === 'delete'
          ? `Calendar ${cal ? cal.name : ''} and ${res.deletedEventIds.length} events deleted`
          : `Calendar ${cal ? cal.name : ''} deleted, ${res.moved} events moved`);
      }
      renderList('[data-agenda-cal-action="new"]');
      onChange();
    }
  }

  function handleKeydown(ev) {
    if (ev.key !== 'Escape' || (!ui.editing && !ui.deleting)) return;
    // Close the inline form first; the panel itself closes on the next Escape.
    ev.stopPropagation();
    handleClick({ target: root().querySelector('[data-agenda-cal-action="cancel"]') || root() });
  }

  /** Wire once; `opts.onChange` re-renders the agenda after a change. */
  function wire(opts) {
    if (opts && typeof opts.onChange === 'function') onChange = opts.onChange;
    const el = root();
    if (!el) return;
    if (wiredRoot !== el) {
      wiredRoot = el;
      el.addEventListener('click', handleClick);
      el.addEventListener('change', handleChange);
      el.addEventListener('submit', handleSubmit);
      el.addEventListener('keydown', handleKeydown);
    }
    renderList();
  }

  global.NotesAgendaCalendars = {
    PALETTE,
    NAME_MAX,
    paletteEntry,
    listCalendars,
    calendarForEvent,
    calendarMap,
    isEventVisible,
    labelHtml,
    createCalendar,
    renameCalendar,
    setCalendarColor,
    setCalendarVisible,
    updateCalendar,
    deleteCalendar,
    renderHtml,
    renderList,
    wire,
    _ui: ui,
    _setStore(s) { storeOverride = s; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.NotesAgendaCalendars;
}(typeof window !== 'undefined' ? window : globalThis));
