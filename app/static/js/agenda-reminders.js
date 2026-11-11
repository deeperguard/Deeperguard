/**
 * Agenda reminders: client-side fire times; server sees only id + fire_at + channel + optional local time label.
 *
 * - Occurrences come from the same expander the calendar draws with (interval, until, count,
 *   deleted and moved occurrences), so a reminder never fires for a date that is not shown.
 * - Reminder ids are derived from (event id, occurrence slot, offset, channel). The event id is a
 *   random vault id the server never sees, so the id is opaque to it, and every device computes
 *   the same id: syncing twice or from two devices cannot create duplicates.
 * - Only the next PLAN_HORIZON_DAYS are planned. `topUp()` extends the plan when the app opens.
 * - A sync that fails is queued on this device and retried (`flushPending()`).
 */
(function (global) {
  const MS_MIN = 60000;
  const MS_DAY = 86400000;
  const PLAN_HORIZON_DAYS = 60;
  const MAX_OCCURRENCES_PER_EVENT = 40;
  const MAX_ROWS_PER_EVENT = 150;
  const SYNC_BATCH = 200;
  const TOP_UP_INTERVAL_MS = 12 * 3600 * 1000;
  const PENDING_KEY = 'agenda_reminder_pending_v1';
  const TOP_UP_KEY = 'agenda_reminder_topup_at';
  const LEGACY_BINDINGS_KEY = 'agenda_reminder_bindings_v1';

  const OFFSET_PRESETS = {
    none: null,
    at_start: 0,
    m5: 5,
    m10: 10,
    m15: 15,
    m30: 30,
    h1: 60,
    d1: 24 * 60,
  };

  const ALLOWED_UPLOAD_KEYS = new Set(['id', 'fire_at', 'channel', 'local_time_label']);

  const PRO_RULE_COPY = 'Event reminders are included with Pro.';

  const GENERIC_PUSH_TITLE = 'Deeperguard';
  const genericBody = (localTimeLabel) => (
    localTimeLabel
      ? `You have an event at ${localTimeLabel}`
      : 'You have an upcoming event'
  );

  /** null = not asked yet. */
  let serverChannels = null;

  function isPlanRequiredError(err) {
    return !!(err && err.code === 'plan_required');
  }

  function hasAgendaRemindersEntitlement() {
    const S = global.NotesStore;
    const account = (S && typeof S.cachedAccount === 'function' && S.cachedAccount()) || {};
    const feats = account.plan_features;
    if (feats && Object.prototype.hasOwnProperty.call(feats, 'agenda_reminders')) {
      return !!feats.agenda_reminders;
    }
    return String(account.plan || 'free').toLowerCase() === 'pro';
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function localTimeLabel(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function normalizeOffsets(raw) {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((x) => String(x).trim()).filter((k) => k && k !== 'none' && OFFSET_PRESETS[k] != null))];
  }

  /**
   * Upcoming occurrences as { start, slotMs }: `start` is when the occurrence really begins
   * (after a per-occurrence edit), `slotMs` identifies its place in the series.
   */
  function expandOccurrences(ev, rangeStart, rangeEnd) {
    let rows = null;
    const A = global.NotesAgenda;
    const R = global.NotesAgendaRecurrence;
    const Occ = global.NotesAgendaOccurrence;
    if (A && typeof A.expandEventOccurrences === 'function') {
      rows = A.expandEventOccurrences(ev, rangeStart, rangeEnd);
    } else if (ev.rrule && String(ev.rrule).trim() && R && typeof R.expandSeries === 'function') {
      const raw = R.expandSeries(ev, rangeStart, rangeEnd).map((row) => ({ ev, ...row }));
      rows = Occ && typeof Occ.finalizeOccurrences === 'function'
        ? Occ.finalizeOccurrences(ev, raw, rangeStart, rangeEnd)
        : raw;
    }
    if (!rows) {
      // No expander loaded: the first occurrence only. Never guess at a repeat rule here.
      const start = new Date(ev.start);
      const end = new Date(ev.end);
      rows = Number.isFinite(start.getTime()) && end > rangeStart && start < rangeEnd
        ? [{ start, end }]
        : [];
    }
    return rows
      .filter((o) => o && o.start instanceof Date && Number.isFinite(o.start.getTime()))
      .map((o) => ({
        // A non-repeating all-day event is clipped to the range by the calendar; use its real start.
        start: (!o.recurring && ev.all_day) ? new Date(new Date(ev.start).setHours(0, 0, 0, 0)) : o.start,
        slotMs: (o.seriesInstanceStart || (o.recurring ? o.start : new Date(ev.start))).getTime(),
      }))
      .sort((a, b) => a.start - b.start);
  }

  function expandOccurrenceStarts(ev, rangeStart, rangeEnd) {
    return expandOccurrences(ev, rangeStart, rangeEnd).map((o) => o.start);
  }

  /** Planned reminder rows without ids (see `planReminders`). Each row carries a stable `_key`. */
  function computePlannedReminders(ev, channels, nowMs) {
    const offsets = normalizeOffsets(ev.reminders);
    if (!offsets.length || !channels || !channels.length) return [];
    const rangeStart = new Date(nowMs);
    const rangeEnd = new Date(nowMs + (PLAN_HORIZON_DAYS + 1) * MS_DAY);
    const horizonMs = nowMs + PLAN_HORIZON_DAYS * MS_DAY;
    const occ = expandOccurrences(ev, rangeStart, rangeEnd).slice(0, MAX_OCCURRENCES_PER_EVENT);
    const out = [];
    for (const o of occ) {
      for (const key of offsets) {
        const fireAt = o.start.getTime() - OFFSET_PRESETS[key] * MS_MIN;
        if (fireAt <= nowMs || fireAt > horizonMs) continue;
        const label = ev.all_day ? '' : localTimeLabel(o.start);
        for (const channel of channels) {
          if (out.length >= MAX_ROWS_PER_EVENT) return out;
          out.push({
            id: '',
            fire_at: Math.floor(fireAt / 1000),
            channel,
            local_time_label: label,
            _key: `agenda-reminder|${ev.id || ''}|${o.slotMs}|${key}|${channel}`,
          });
        }
      }
    }
    return out;
  }

  function randomUuid() {
    if (global.NotesStore?.newUuid) return global.NotesStore.newUuid();
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
  }

  /** UUID-shaped SHA-256 of the key, so every device derives the same id for the same reminder. */
  async function reminderIdForKey(key) {
    const subtle = global.crypto && global.crypto.subtle;
    if (!subtle || typeof TextEncoder === 'undefined') return randomUuid();
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(key)));
    const b = digest.slice(0, 16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function planReminders(ev, channels, nowMs) {
    const rows = computePlannedReminders(ev, channels, nowMs);
    for (const row of rows) row.id = await reminderIdForKey(row._key);
    return rows;
  }

  function publicUploadRows(planned) {
    return planned.map((row) => {
      const payload = {
        id: row.id,
        fire_at: row.fire_at,
        channel: row.channel,
      };
      if (row.local_time_label) payload.local_time_label = row.local_time_label;
      Object.keys(payload).forEach((k) => {
        if (!ALLOWED_UPLOAD_KEYS.has(k)) delete payload[k];
      });
      return payload;
    });
  }

  function readPrefs() {
    try {
      return JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  /** Channels the user switched on, on this device. */
  function channelPrefs() {
    const prefs = readPrefs();
    const channels = [];
    if (prefs.agenda_reminder_email) channels.push('email');
    if (prefs.agenda_reminder_push) channels.push('push');
    return channels;
  }

  async function loadServerChannels(force) {
    if (serverChannels && !force) return serverChannels;
    const S = global.NotesStore;
    if (!S || typeof S.api !== 'function') return { push: false, email: true, key: '' };
    const data = await S.api('/api/agenda-reminders/push-config');
    serverChannels = {
      push: !!data?.push_ready,
      email: data?.email_ready !== false,
      key: String(data?.vapid_public_key || ''),
    };
    return serverChannels;
  }

  /** Channels that are switched on and that the server can deliver right now. */
  async function effectiveChannels() {
    const wanted = channelPrefs();
    if (!wanted.length) return [];
    const server = await loadServerChannels(false);
    return wanted.filter((c) => (c === 'push' ? server.push : server.email));
  }

  // ---- retry queue (this device) ----

  function loadPending() {
    try {
      const raw = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}') || {};
      return {
        events: Array.isArray(raw.events) ? raw.events.map(String) : [],
        deletes: Array.isArray(raw.deletes) ? raw.deletes.map(String) : [],
      };
    } catch (e) {
      return { events: [], deletes: [] };
    }
  }

  function savePending(p) {
    try {
      const events = [...new Set(p.events)].slice(-500);
      const deletes = [...new Set(p.deletes)].slice(-2000);
      if (events.length || deletes.length) localStorage.setItem(PENDING_KEY, JSON.stringify({ events, deletes }));
      else localStorage.removeItem(PENDING_KEY);
    } catch (e) { /* ignore */ }
  }

  function queueEvent(eventId) {
    const p = loadPending();
    p.events.push(String(eventId));
    savePending(p);
  }

  function queueDeletes(ids) {
    if (!ids.length) return;
    const p = loadPending();
    p.deletes.push(...ids);
    savePending(p);
  }

  function dropQueuedEvent(eventId) {
    const p = loadPending();
    const next = p.events.filter((x) => x !== String(eventId));
    if (next.length !== p.events.length) savePending({ events: next, deletes: p.deletes });
  }

  async function postSync(reminders, deleteIds) {
    const S = global.NotesStore;
    const rows = reminders.slice();
    const dels = deleteIds.slice();
    do {
      await S.api('/api/agenda-reminders/sync', {
        method: 'POST',
        body: JSON.stringify({
          reminders: rows.splice(0, SYNC_BATCH),
          delete_ids: dels.splice(0, SYNC_BATCH),
        }),
      });
    } while (rows.length || dels.length);
  }

  function storedEvent(eventId) {
    const S = global.NotesStore;
    return (S && typeof S.listAgendaEvents === 'function' ? S.listAgendaEvents() : [])
      .find((e) => e.id === eventId) || null;
  }

  function sameScheduled(a, b) {
    if (a.length !== b.length) return false;
    const key = (x) => `${x.id}|${x.channel}|${x.fire_at}`;
    const set = new Set(a.map(key));
    return b.every((x) => set.has(key(x)));
  }

  /**
   * Bring the server's reminders for one event in line with the event as stored in the vault.
   * Safe to call any number of times and from several devices.
   */
  async function syncEventReminders(eventId, eventLike) {
    const S = global.NotesStore;
    if (!S || typeof S.api !== 'function' || !eventId) return;
    if (!hasAgendaRemindersEntitlement()) return;
    const row = storedEvent(eventId) || eventLike;
    if (!row) return;
    try {
      const channels = await effectiveChannels();
      const planned = await planReminders({ ...row, id: eventId }, channels, Date.now());
      const previous = Array.isArray(row.scheduled_reminder_ids) ? row.scheduled_reminder_ids : [];
      const keep = new Set(planned.map((p) => p.id));
      const deleteIds = previous.map((x) => x && x.id).filter((id) => id && !keep.has(id));
      if (planned.length || deleteIds.length) await postSync(publicUploadRows(planned), deleteIds);
      dropQueuedEvent(eventId);
      const next = planned.map((p) => ({ id: p.id, channel: p.channel, fire_at: p.fire_at }));
      const current = storedEvent(eventId);
      if (current && typeof S.upsertAgendaEvent === 'function' && !sameScheduled(previous, next)) {
        const { id: _drop, ...content } = current;
        S.upsertAgendaEvent(eventId, { ...content, scheduled_reminder_ids: next });
      }
    } catch (err) {
      if (isPlanRequiredError(err)) throw err;
      queueEvent(eventId);
      throw err;
    }
  }

  /** Remove every server reminder of an event that is being deleted. */
  async function cancelEventReminders(eventId, row) {
    const S = global.NotesStore;
    if (!S || typeof S.api !== 'function' || !eventId) return;
    if (!hasAgendaRemindersEntitlement()) return;
    const ids = (row?.scheduled_reminder_ids || []).map((x) => x && x.id).filter(Boolean);
    dropQueuedEvent(eventId);
    if (!ids.length) return;
    try {
      await postSync([], ids);
    } catch (err) {
      if (isPlanRequiredError(err)) throw err;
      queueDeletes(ids);
      throw err;
    }
  }

  let flushing = null;

  /** Retry what failed earlier on this device. */
  function flushPending() {
    if (flushing) return flushing;
    flushing = (async () => {
      const S = global.NotesStore;
      if (!S || typeof S.api !== 'function') return;
      if (!hasAgendaRemindersEntitlement()) return;
      if (typeof S.isUnlocked === 'function' && !S.isUnlocked()) return;
      const p = loadPending();
      if (p.deletes.length) {
        await postSync([], p.deletes);
        savePending({ events: loadPending().events, deletes: [] });
      }
      for (const eventId of [...new Set(p.events)]) {
        if (!storedEvent(eventId)) {
          dropQueuedEvent(eventId);
          continue;
        }
        await syncEventReminders(eventId);
      }
    })().catch((err) => {
      if (isPlanRequiredError(err)) savePending({ events: [], deletes: [] });
      /* still offline: stays queued */
    }).finally(() => { flushing = null; });
    return flushing;
  }

  /** Extend the planning window for every event with reminders. Runs at most twice a day per device. */
  async function topUp(force) {
    const S = global.NotesStore;
    if (!S || typeof S.listAgendaEvents !== 'function') return;
    if (!hasAgendaRemindersEntitlement()) return;
    if (typeof S.isUnlocked === 'function' && !S.isUnlocked()) return;
    let last = 0;
    try { last = Number(localStorage.getItem(TOP_UP_KEY)) || 0; } catch (e) { /* ignore */ }
    if (!force && Date.now() - last < TOP_UP_INTERVAL_MS) return;
    try { localStorage.setItem(TOP_UP_KEY, String(Date.now())); } catch (e) { /* ignore */ }
    const rows = S.listAgendaEvents().filter((e) => (
      normalizeOffsets(e.reminders).length || (e.scheduled_reminder_ids || []).length
    ));
    for (const row of rows) {
      try {
        await syncEventReminders(row.id);
      } catch (e) {
        return; // queued; flushPending retries later
      }
    }
  }

  /** Called when the Agenda tab is shown. */
  function onAgendaShown() {
    if (!hasAgendaRemindersEntitlement()) return;
    try { localStorage.removeItem(LEGACY_BINDINGS_KEY); } catch (e) { /* ignore */ }
    flushPending().then(() => topUp(false)).catch(() => {});
  }

  // ---- settings UI ----

  function loadChannelToggles() {
    const prefs = readPrefs();
    const emailEl = document.getElementById('agenda-reminder-email');
    const pushEl = document.getElementById('agenda-reminder-push');
    if (emailEl instanceof HTMLInputElement) emailEl.checked = !!prefs.agenda_reminder_email;
    if (pushEl instanceof HTMLInputElement) pushEl.checked = !!prefs.agenda_reminder_push;
  }

  function saveChannelPrefs() {
    const prefs = readPrefs();
    const emailEl = document.getElementById('agenda-reminder-email');
    const pushEl = document.getElementById('agenda-reminder-push');
    prefs.agenda_reminder_email = !!(emailEl && emailEl.checked);
    prefs.agenda_reminder_push = !!(pushEl && pushEl.checked && !pushEl.disabled);
    try { localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }

  function onChannelChange() {
    if (!hasAgendaRemindersEntitlement()) return;
    saveChannelPrefs();
    // Existing events pick up the new channel choice.
    topUp(true).catch(() => {});
  }

  /** Text for the editor when ticking an offset would do nothing. Empty when reminders can be sent. */
  function editorHint() {
    if (!hasAgendaRemindersEntitlement()) return '';
    if (!channelPrefs().length) {
      return 'Reminders are off. Turn on email or push reminders in Calendar settings to receive them.';
    }
    if (serverChannels) {
      const usable = channelPrefs().filter((c) => (c === 'push' ? serverChannels.push : serverChannels.email));
      if (!usable.length) {
        return serverChannels.email
          ? "Push isn't available yet. Turn on email reminders in Calendar settings to receive them."
          : 'Confirm your email address to receive reminders.';
      }
    }
    return '';
  }

  async function refreshPushConfigUi() {
    if (!hasAgendaRemindersEntitlement()) return;
    const btn = document.getElementById('agenda-reminder-enable-push');
    const status = document.getElementById('agenda-reminder-push-status');
    const pushEl = document.getElementById('agenda-reminder-push');
    const emailEl = document.getElementById('agenda-reminder-email');
    const emailStatus = document.getElementById('agenda-reminder-email-status');
    try {
      const server = await loadServerChannels(true);
      if (btn) btn.hidden = !server.push;
      if (pushEl instanceof HTMLInputElement) {
        pushEl.disabled = !server.push;
        if (!server.push) pushEl.checked = false;
      }
      if (status) {
        status.hidden = server.push;
        status.textContent = server.push ? '' : "Push isn't available yet.";
      }
      if (emailEl instanceof HTMLInputElement) emailEl.disabled = !server.email;
      if (emailStatus) {
        emailStatus.hidden = server.email;
        emailStatus.textContent = server.email ? '' : 'Confirm your email address to receive email reminders.';
      }
    } catch (e) {
      if (status) {
        status.hidden = false;
        status.textContent = 'Could not load push configuration.';
      }
      if (btn) btn.hidden = true;
    }
  }

  async function enablePushFromGesture() {
    const S = global.NotesStore;
    if (!S || typeof S.api !== 'function') return;
    if (!('Notification' in global) || !navigator.serviceWorker?.pushManager) {
      if (typeof global.notesAgendaToast === 'function') global.notesAgendaToast('Push is not supported in this browser', true);
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    const server = await loadServerChannels(true);
    const key = server.key;
    if (!key) {
      if (typeof global.notesAgendaToast === 'function') global.notesAgendaToast("Push isn't available yet.", true);
      return;
    }
    const raw = key.replace(/-/g, '+').replace(/_/g, '/');
    const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: bytes,
    });
    await S.api('/api/agenda-reminders/push-subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: sub.endpoint, subscription: sub.toJSON() }),
    });
    const pushEl = document.getElementById('agenda-reminder-push');
    if (pushEl instanceof HTMLInputElement) pushEl.checked = true;
    onChannelChange();
    if (typeof global.notesAgendaToast === 'function') global.notesAgendaToast('Push enabled on this device');
  }

  let settingsWired = false;

  function wireAgendaReminderSettings() {
    loadChannelToggles();
    refreshPushConfigUi();
    if (settingsWired) return;
    settingsWired = true;
    document.getElementById('agenda-reminder-email')?.addEventListener('change', onChannelChange);
    document.getElementById('agenda-reminder-push')?.addEventListener('change', onChannelChange);
    document.getElementById('agenda-reminder-enable-push')?.addEventListener('click', () => {
      enablePushFromGesture().catch(() => {});
    });
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('online', () => { flushPending(); });
    }
  }

  global.NotesAgendaReminders = {
    OFFSET_PRESETS,
    PLAN_HORIZON_DAYS,
    PRO_RULE_COPY,
    isPlanRequiredError,
    hasAgendaRemindersEntitlement,
    GENERIC_PUSH_TITLE,
    genericBody,
    normalizeOffsets,
    computePlannedReminders,
    planReminders,
    reminderIdForKey,
    publicUploadRows,
    expandOccurrences,
    expandOccurrenceStarts,
    syncEventReminders,
    cancelEventReminders,
    flushPending,
    topUp,
    onAgendaShown,
    channelPrefs,
    editorHint,
    ALLOWED_UPLOAD_KEYS,
    wireAgendaReminderSettings,
    loadChannelToggles,
    enablePushFromGesture,
  };
}(typeof window !== 'undefined' ? window : globalThis));
