/**
 * Deeperguard Agenda — "Calendars" list in the calendar settings panel
 * (docs/design/calendar-multi.md §1, milestone M2).
 *
 * Create, rename, recolor, show/hide and delete calendars; switch URL subscriptions on or off. Colors come from a fixed palette of
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

  /**
   * Read-only stand-in for a URL subscription, so its events carry the subscription's own name.
   * A subscription switched off (`enabled === false`) is not visible; missing `enabled` means on.
   */
  function subscriptionCalendar(sub) {
    return {
      id: `sub:${sub.id}`, subId: sub.id, name: sub.name, color: sub.color || 'slate', visible: sub.enabled !== false, subscribed: true,
    };
  }

  function listSubscriptionCalendars() {
    const S = getStore();
    if (!S || typeof S.listAgendaSubscriptions !== 'function') return [];
    return S.listAgendaSubscriptions().map(subscriptionCalendar);
  }

  /** Calendar an event is shown in (missing/unknown calendarId = default calendar). */
  function calendarForEvent(ev, map) {
    const S = getStore();
    const subId = ev && ev.subscription_id;
    if (subId && S && typeof S.getAgendaSubscription === 'function') {
      const sub = S.getAgendaSubscription(subId);
      if (sub) return subscriptionCalendar(sub);
    }
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
      + ` style="background:${p.bg};color:${p.text}"${cal.subscribed ? ' title="Subscribed calendar (read-only)"' : ''}>${esc(cal.name || 'Agenda')}</span>`
    );
  }

  /**
   * Calendar of the most recently saved event in a visible calendar, or '' when there is none.
   * Hidden calendars are skipped so a new event is never created where it cannot be seen.
   * Derived from the encrypted events themselves, so nothing extra is stored on the device.
   */
  function lastUsedCalendarId(events, map) {
    const cals = map || calendarMap();
    let bestId = '';
    let bestAt = '';
    (events || []).forEach((ev) => {
      const id = String((ev && ev.calendarId) || '');
      const at = String((ev && ev.updated_at) || '');
      if (id && cals.has(id) && cals.get(id).visible !== false && at >= bestAt) {
        bestId = id;
        bestAt = at;
      }
    });
    return bestId;
  }

  /**
   * Rows for the URL subscriptions in the Calendars section of the settings panel. Each has one
   * on/off switch (off = events hidden and no refresh); rename, refresh and delete stay in the
   * Subscribed calendars list below.
   */
  function subscriptionRowsHtml() {
    return listSubscriptionCalendars().map((c) => {
      const p = paletteEntry(c.color);
      const on = c.visible;
      const name = c.name || 'Agenda';
      return (
        `<li class="agenda-cal-row agenda-cal-row-sub${on ? '' : ' is-hidden'}" data-agenda-sub-id="${esc(c.subId)}"><div class="agenda-cal-row-main">`
        + `<label class="agenda-cal-toggle"><input type="checkbox" role="switch" data-agenda-cal-action="sub-toggle"${on ? ' checked' : ''}`
        + ` aria-label="${esc(`Subscribed calendar ${name}`)}">`
        + `<span class="agenda-cal-dot" data-agenda-cal-color="${esc(p.key)}" style="background:${p.bg}" aria-hidden="true"></span>`
        + `<span class="agenda-cal-name">${esc(name)}</span></label>`
        + `<span class="agenda-cal-badge" aria-hidden="true">${on ? 'Subscribed · on' : 'Subscribed · off'}</span>`
        + '</div></li>'
      );
    }).join('');
  }

  function subsRoot() {
    return typeof document !== 'undefined' ? document.getElementById('agenda-calendars-subs') : null;
  }

  function renderSubscriptions(focusSubId) {
    const el = subsRoot();
    if (!el) return;
    el.innerHTML = subscriptionRowsHtml();
    if (!focusSubId) return;
    const row = [...el.querySelectorAll('[data-agenda-sub-id]')].find((li) => li.getAttribute('data-agenda-sub-id') === focusSubId);
    const input = row && row.querySelector('[data-agenda-cal-action="sub-toggle"]');
    if (input) input.focus();
  }

  /** Switch handler: stores the choice, re-renders at once, refreshes once when turned on. */
  async function handleSubToggle(ev) {
    const cb = ev.target.closest('[data-agenda-cal-action="sub-toggle"]');
    if (!cb) return;
    const subId = cb.closest('[data-agenda-sub-id]')?.getAttribute('data-agenda-sub-id') || '';
    const Subs = global.NotesAgendaSubs;
    const S = getStore();
    const sub = S && typeof S.getAgendaSubscription === 'function' ? S.getAgendaSubscription(subId) : null;
    if (!sub || !Subs || typeof Subs.setEnabled !== 'function') {
      renderSubscriptions();
      return;
    }
    const on = cb.checked;
    const pending = Subs.setEnabled(subId, on);
    announce(`${sub.name} ${on ? 'on' : 'off'}`);
    renderSubscriptions(subId);
    Subs.renderList();
    onChange();
    const res = await pending;
    if (!on || !res) return;
    if (!res.ok && typeof global.notesAgendaToast === 'function') global.notesAgendaToast(Subs.errorText(res.code), true);
    Subs.renderList();
    onChange();
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

  /** Default reminders (minutes) as stored on a calendar; same rules as an event's `reminders`. */
  function cleanDefaultReminders(raw) {
    const R = global.NotesAgendaReminders;
    return R && typeof R.offsetMinutes === 'function' ? R.offsetMinutes(raw) : [];
  }

  function createCalendar(name, color, defaultReminders) {
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
      default_reminders: cleanDefaultReminders(defaultReminders),
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
    if (patch && 'default_reminders' in patch) next.default_reminders = cleanDefaultReminders(patch.default_reminders);
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
  const ui = { editing: '', deleting: '', feeding: '' };

  /** `selected` empty = nothing checked (optional choice); `legend` names the group for screen readers. */
  function colorPickerHtml(prefix, selected, legend) {
    const sel = selected ? paletteEntry(selected).key : '';
    return (
      `<fieldset class="agenda-cal-colors"><legend class="muted">${esc(legend || 'Color')}</legend>`
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

  /** The same picker as a DOM element (for code that must not assign innerHTML itself). */
  function colorPickerEl(prefix, selected, legend) {
    const t = document.createElement('template');
    t.innerHTML = colorPickerHtml(prefix, selected, legend);
    return t.content.firstElementChild;
  }

  const DEFAULT_REMINDER_PRESETS = [0, 5, 10, 15, 30, 60, 1440];

  function defaultRemindersHtml(cal) {
    const R = global.NotesAgendaReminders;
    const current = cleanDefaultReminders(cal && cal.default_reminders);
    const label = (n) => (R && typeof R.offsetLabel === 'function' ? R.offsetLabel(n) : `${n} min before`);
    const custom = current.filter((n) => !DEFAULT_REMINDER_PRESETS.includes(n)).join(', ');
    return (
      '<fieldset class="agenda-cal-default-reminders"><legend class="muted">Default reminders for new events</legend>'
      + DEFAULT_REMINDER_PRESETS.map((n) => (
        `<label class="settings-row checkbox"><span>${esc(label(n))}</span>`
        + `<input type="checkbox" name="default_reminder" value="${n}"${current.includes(n) ? ' checked' : ''}></label>`
      )).join('')
      + '<label class="settings-row stacked">Custom (minutes before, e.g. 20 or 20, 120)'
      + `<input type="text" name="default_reminder_custom" inputmode="numeric" maxlength="60" autocomplete="off" value="${esc(custom)}"></label>`
      + '<p class="settings-hint muted">Reminders only work while Deeperguard is open in your browser. They send no email and no push message.</p>'
      + '</fieldset>'
    );
  }

  /** Minutes picked in a calendar form (preset checkboxes plus the custom field). */
  function readDefaultReminders(form) {
    const picked = [...form.querySelectorAll('input[name="default_reminder"]')]
      .filter((el) => el.checked)
      .map((el) => el.value);
    const custom = form.querySelector('input[name="default_reminder_custom"]');
    if (custom) picked.push(...String(custom.value || '').split(/[\s,;]+/));
    return cleanDefaultReminders(picked);
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
      + defaultRemindersHtml(cal)
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
      + others.map((c) => (
        `<option value="${esc(c.id)}"${c.id === defId ? ' selected' : ''}>${esc(c.name)}${c.id === defId ? ' (default)' : ''}</option>`
      )).join('')
      + '</select></label>'
      + '<label class="settings-hint"><input type="radio" name="mode" value="delete"> Delete them too</label>'
      + '</fieldset>'
      + '<div class="agenda-cal-form-actions">'
      + '<button type="submit" class="btn danger sm">Delete calendar</button>'
      + '<button type="button" class="btn ghost sm" data-agenda-cal-action="cancel">Cancel</button>'
      + '</div></form>'
    );
  }

  // ---- Opt-in webcal feed (the one place the server can read a calendar) -------------------

  /** calendar id -> updated_at (seconds) of calendars that have a feed on the server. */
  const feeds = new Map();
  const pushed = new Map(); // calendar id -> last .ics the server holds, to skip identical uploads
  let feedsLoaded = false;
  let feedHost = { buildIcs: () => null };
  const feedUi = { url: '', urlFor: '', busy: false, error: '' };

  async function feedApi(method, path, body) {
    const NS = global.NotesStore;
    let csrf = (NS && typeof NS.csrf === 'function' && NS.csrf()) || '';
    if (!csrf && NS && typeof NS.loadAccount === 'function') {
      try { csrf = ((await NS.loadAccount()) || {}).csrf || ''; } catch (e) { /* the route answers 400 */ }
    }
    try {
      const res = await global.fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: {} };
    }
  }

  async function loadFeeds() {
    const r = await feedApi('GET', '/api/agenda/feeds');
    if (!r.ok || !Array.isArray(r.data.feeds)) return false;
    feeds.clear();
    r.data.feeds.forEach((f) => feeds.set(String(f.calendar_id), Number(f.updated_at) || 0));
    feedsLoaded = true;
    return true;
  }

  function feedPanelHtml(cal) {
    const name = esc(cal.name || 'Agenda');
    const on = feeds.has(cal.id);
    let html = `<div class="agenda-cal-feed" data-agenda-cal-feed="${esc(cal.id)}" role="group" aria-label="${esc(`Subscription link for ${cal.name}`)}">`;
    html += (
      '<p class="settings-hint agenda-cal-feed-warning"><strong>The server can read this calendar.</strong> '
      + 'To make a link that Apple Calendar, Thunderbird or Google Calendar can subscribe to, Deeperguard uploads '
      + `the titles, places, notes and times of the events in <strong>${name}</strong> as readable text. `
      + 'Everything else stays encrypted. Anyone who has the link can read the calendar, and the server sees when '
      + 'and from which address it is fetched. Your other calendars are not uploaded.</p>'
    );
    if (feedUi.url && feedUi.urlFor === cal.id) {
      const webcal = feedUi.url.replace(/^https?:/, 'webcal:');
      html += (
        '<label class="settings-hint" for="agenda-cal-feed-url">Your link (shown only now, copy it before closing):</label>'
        + '<div class="agenda-cal-feed-url-row">'
        + `<input type="text" id="agenda-cal-feed-url" class="agenda-cal-feed-url" readonly value="${esc(webcal)}">`
        + '<button type="button" class="btn ghost sm" data-agenda-cal-action="feed-copy">Copy</button></div>'
      );
    }
    if (feedUi.error) html += `<p class="settings-hint agenda-cal-feed-error" role="alert">${esc(feedUi.error)}</p>`;
    const dis = feedUi.busy ? ' disabled' : '';
    if (on) {
      html += (
        '<p class="settings-hint">The feed is on. It updates while Deeperguard is open and unlocked; your calendar app '
        + 'decides how often it refreshes. The link can not be shown again. Make a new one if you lost it.</p>'
      );
    } else {
      html += (
        '<label class="settings-hint agenda-cal-feed-ack"><input type="checkbox" data-agenda-feed-ack>'
        + ' I understand the server can read this calendar.</label>'
      );
    }
    html += '<div class="agenda-cal-form-actions">';
    if (on) {
      html += (
        `<button type="button" class="btn ghost sm" data-agenda-cal-action="feed-create"${dis}>New link (old link stops working)</button>`
        + `<button type="button" class="btn danger sm" data-agenda-cal-action="feed-off"${dis}>Turn off and revoke link</button>`
      );
    } else {
      html += `<button type="button" class="btn primary sm" data-agenda-cal-action="feed-create"${dis}>Create link</button>`;
    }
    html += '<button type="button" class="btn ghost sm" data-agenda-cal-action="cancel">Close</button></div></div>';
    return html;
  }

  async function createFeed(calId, ackBox) {
    if (feedUi.busy) return;
    if (!feeds.has(calId) && !(ackBox && ackBox.checked)) {
      feedUi.error = 'Tick the box to confirm you understand the server can read this calendar.';
      renderList('[data-agenda-feed-ack]');
      return;
    }
    const ics = feedHost.buildIcs(calId);
    if (ics == null) {
      feedUi.error = 'Could not build the calendar. Unlock Deeperguard and try again.';
      renderList();
      return;
    }
    feedUi.busy = true;
    feedUi.error = '';
    renderList();
    const r = await feedApi('POST', '/api/agenda/feeds', { calendar_id: calId, ics, acknowledged: true });
    feedUi.busy = false;
    if (r.ok && r.data.url) {
      feeds.set(calId, Date.now() / 1000);
      pushed.set(calId, ics);
      feedUi.url = r.data.url;
      feedUi.urlFor = calId;
      renderList('#agenda-cal-feed-url');
      const input = document.getElementById('agenda-cal-feed-url');
      if (input) input.select();
      announce('Link created. Copy it now; it is not shown again.');
    } else {
      feedUi.error = r.status === 413
        ? 'This calendar is too large for a feed.'
        : (r.data && r.data.error === 'too many feeds'
          ? 'You have reached the limit of feeds.'
          : 'Could not create the link. Check your connection and try again.');
      renderList();
    }
  }

  async function turnOffFeed(calId) {
    if (feedUi.busy) return;
    feedUi.busy = true;
    feedUi.error = '';
    renderList();
    const r = await feedApi('POST', '/api/agenda/feeds/delete', { calendar_id: calId });
    feedUi.busy = false;
    if (r.ok) {
      feeds.delete(calId);
      pushed.delete(calId);
      feedUi.url = '';
      feedUi.urlFor = '';
      renderList(rowSel(calId, 'feed'));
      announce('Feed turned off. The link no longer works.');
    } else {
      feedUi.error = 'Could not turn the feed off. Check your connection and try again.';
      renderList();
    }
  }

  function stripStamp(text) {
    return String(text).replace(/^DTSTAMP[^\r\n]*/gm, '');
  }

  let syncing = false;
  /** Upload changed calendars and remove feeds of deleted calendars. Safe to call often. */
  async function syncFeeds() {
    if (syncing) return;
    syncing = true;
    try {
      if (!feedsLoaded && !(await loadFeeds())) return;
      const known = new Set(listCalendars().map((c) => c.id));
      for (const calId of [...feeds.keys()]) {
        if (!known.has(calId)) {
          const r = await feedApi('POST', '/api/agenda/feeds/delete', { calendar_id: calId });
          if (r.ok) { feeds.delete(calId); pushed.delete(calId); }
          continue;
        }
        const ics = feedHost.buildIcs(calId);
        if (ics == null) continue;
        // DTSTAMP changes on every build; compare without it so only real edits are uploaded.
        if (pushed.has(calId) && stripStamp(pushed.get(calId)) === stripStamp(ics)) continue;
        const r = await feedApi('POST', '/api/agenda/feeds/update', { calendar_id: calId, ics });
        if (r.ok) pushed.set(calId, ics);
      }
    } finally {
      syncing = false;
    }
  }

  /** The host builds the .ics of one calendar (null while events are unavailable). */
  function setFeedHost(host) {
    if (host && typeof host.buildIcs === 'function') feedHost = host;
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
    html += (
      `<button type="button" class="btn ghost sm" data-agenda-cal-action="export" aria-label="${esc(`Export ${name} as .ics`)}">Export</button>`
    );
    html += (
      `<button type="button" class="btn ghost sm" data-agenda-cal-action="feed" aria-label="${esc(`Subscription link for ${name}`)}"`
      + ` aria-expanded="${ui.feeding === cal.id ? 'true' : 'false'}">${feeds.has(cal.id) ? 'Feed on' : 'Feed'}</button>`
    );
    if (!cal.is_default) {
      html += (
        `<button type="button" class="btn ghost sm" data-agenda-cal-action="delete" aria-label="${esc(`Delete ${name}`)}"`
        + ` aria-expanded="${ui.deleting === cal.id ? 'true' : 'false'}">Delete</button>`
      );
    }
    html += '</div>';
    if (ui.editing === cal.id) html += editFormHtml(cal);
    if (ui.feeding === cal.id) html += feedPanelHtml(cal);
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
  let onExport = () => {};
  let wiredRoot = null;
  let wiredSubsRoot = null;

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
    renderSubscriptions();
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
    if (action === 'export') {
      onExport(id);
    } else if (action === 'feed') {
      ui.feeding = ui.feeding === id ? '' : id;
      ui.editing = '';
      ui.deleting = '';
      if (feedUi.urlFor !== ui.feeding) { feedUi.url = ''; feedUi.urlFor = ''; }
      feedUi.error = '';
      renderList(ui.feeding ? '[data-agenda-cal-feed] input, [data-agenda-cal-feed] [data-agenda-cal-action="feed-create"]' : rowSel(id, 'feed'));
      if (ui.feeding && !feedsLoaded) loadFeeds().then(() => { if (ui.feeding === id) renderList(); });
    } else if (action === 'feed-create') {
      createFeed(id, btn.closest('[data-agenda-cal-feed]')?.querySelector('[data-agenda-feed-ack]'));
    } else if (action === 'feed-off') {
      turnOffFeed(id);
    } else if (action === 'feed-copy') {
      const input = document.getElementById('agenda-cal-feed-url');
      const clip = global.navigator && global.navigator.clipboard;
      if (input) input.select();
      if (input && clip && clip.writeText) {
        clip.writeText(input.value).then(() => announce('Link copied'), () => announce('Press Ctrl+C to copy the selected link'));
      } else announce('Press Ctrl+C to copy the selected link');
    } else if (action === 'new') {
      ui.editing = 'new';
      ui.deleting = '';
      ui.feeding = '';
      renderList('[data-agenda-cal-form="new"] input[name="name"]');
    } else if (action === 'edit') {
      ui.editing = ui.editing === id ? '' : id;
      ui.deleting = '';
      ui.feeding = '';
      renderList(ui.editing ? `[data-agenda-cal-id] [data-agenda-cal-form] input[name="name"]` : rowSel(id, 'edit'));
    } else if (action === 'delete') {
      ui.deleting = ui.deleting === id ? '' : id;
      ui.editing = '';
      ui.feeding = '';
      renderList(ui.deleting ? '[data-agenda-cal-delete] input[name="mode"]' : rowSel(id, 'delete'));
    } else if (action === 'cancel' && ui.feeding) {
      const back = ui.feeding;
      ui.feeding = '';
      feedUi.url = '';
      feedUi.urlFor = '';
      feedUi.error = '';
      renderList(rowSel(back, 'feed'));
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
      const defaultReminders = readDefaultReminders(form);
      if (!name) {
        form.querySelector('input[name="name"]')?.focus();
        announce('Enter a name for the calendar');
        return;
      }
      let id = editId;
      if (editId === 'new') {
        id = createCalendar(name, color, defaultReminders);
        announce(`Calendar ${name} created`);
      } else {
        updateCalendar(editId, { name, color, default_reminders: defaultReminders });
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
    if (ev.key !== 'Escape' || (!ui.editing && !ui.deleting && !ui.feeding)) return;
    // Close the inline form first; the panel itself closes on the next Escape.
    ev.stopPropagation();
    handleClick({ target: root().querySelector('[data-agenda-cal-action="cancel"]') || root() });
  }

  /** The host supplies the per-calendar .ics export; it receives the calendar id. */
  function setExportHandler(fn) {
    if (typeof fn === 'function') onExport = fn;
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
    const subs = subsRoot();
    if (subs && wiredSubsRoot !== subs) {
      wiredSubsRoot = subs;
      subs.addEventListener('change', (ev) => { handleSubToggle(ev).catch(() => {}); });
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
    lastUsedCalendarId,
    renderSubscriptions,
    colorPickerEl,
    paletteEntry,
    createCalendar,
    renameCalendar,
    setCalendarColor,
    setCalendarVisible,
    updateCalendar,
    deleteCalendar,
    renderHtml,
    renderList,
    wire,
    setExportHandler,
    setFeedHost,
    syncFeeds,
    _ui: ui,
    _setStore(s) { storeOverride = s; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.NotesAgendaCalendars;
}(typeof window !== 'undefined' ? window : globalThis));
