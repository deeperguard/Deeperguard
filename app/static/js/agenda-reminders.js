/**
 * Agenda reminders: client-side fire times; server sees only id + fire_at + channel + optional local time label.
 */
(function (global) {
  const MS_MIN = 60000;
  const MS_DAY = 86400000;
  const SERIES_CAP = 16;
  const PENDING_BINDINGS_KEY = 'agenda_reminder_bindings_v1';

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

  const GENERIC_PUSH_TITLE = 'Deeperguard';
  const genericBody = (localTimeLabel) => (
    localTimeLabel
      ? `You have an event at ${localTimeLabel}`
      : 'You have an upcoming event'
  );

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

  function expandOccurrenceStarts(ev, rangeStart, rangeEnd) {
    const Occ = global.NotesAgendaOccurrence;
    const expand = global.NotesAgenda && typeof NotesAgenda._testExpand === 'function'
      ? NotesAgenda._testExpand
      : null;
    if (expand) {
      return expand(ev, rangeStart, rangeEnd).map((o) => o.start);
    }
    const starts = [];
    const start = new Date(ev.start);
    const end = new Date(ev.end);
    if (!ev.rrule || !String(ev.rrule).trim()) {
      if (end > rangeStart && start < rangeEnd) starts.push(start);
      return starts;
    }
    let cur = new Date(start);
    let n = 0;
    while (n < SERIES_CAP && cur < rangeEnd) {
      const ce = new Date(cur.getTime() + (end.getTime() - start.getTime()));
      if (ce > rangeStart && cur < rangeEnd) starts.push(new Date(cur));
      n += 1;
      const rule = String(ev.rrule).toUpperCase();
      if (/FREQ=DAILY/.test(rule)) {
        cur = new Date(cur.getTime() + MS_DAY);
      } else if (/FREQ=WEEKLY/.test(rule)) {
        cur = new Date(cur.getTime() + 7 * MS_DAY);
      } else if (/FREQ=MONTHLY/.test(rule)) {
        cur = new Date(cur);
        cur.setMonth(cur.getMonth() + 1);
      } else if (/FREQ=YEARLY/.test(rule)) {
        cur.setFullYear(cur.getFullYear() + 1);
      } else {
        break;
      }
    }
    return starts;
  }

  function computePlannedReminders(ev, channels, nowMs) {
    const offsets = normalizeOffsets(ev.reminders);
    if (!offsets.length || !channels.length) return [];
    const horizon = nowMs + 366 * MS_DAY;
    const rangeStart = new Date(nowMs);
    const rangeEnd = new Date(horizon);
    const occStarts = expandOccurrenceStarts(ev, rangeStart, rangeEnd);
    const out = [];
    function newReminderId() {
      if (global.NotesStore?.newUuid) return NotesStore.newUuid();
      if (global.crypto?.randomUUID) return global.crypto.randomUUID();
      return '00000000-0000-4000-8000-000000000000';
    }
    occStarts.forEach((occStart) => {
      offsets.forEach((key) => {
        const offMin = OFFSET_PRESETS[key];
        const fireAt = new Date(occStart.getTime() - offMin * MS_MIN);
        if (fireAt.getTime() <= nowMs) return;
        const label = localTimeLabel(occStart);
        channels.forEach((channel) => {
          const id = newReminderId();
          out.push({
            id,
            fire_at: Math.floor(fireAt.getTime() / 1000),
            channel,
            local_time_label: label,
            _bind: { event_id: ev.id || '', occurrence_ms: occStart.getTime(), offset_key: key },
          });
        });
      });
    });
    return out;
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

  function loadBindings() {
    try {
      const raw = JSON.parse(localStorage.getItem(PENDING_BINDINGS_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (e) {
      return {};
    }
  }

  function saveBindings(map) {
    try {
      if (Object.keys(map).length) localStorage.setItem(PENDING_BINDINGS_KEY, JSON.stringify(map));
      else localStorage.removeItem(PENDING_BINDINGS_KEY);
    } catch (e) { /* ignore */ }
  }

  function mergeBindings(planned) {
    const map = loadBindings();
    planned.forEach((p) => {
      if (p._bind) map[p.id] = p._bind;
    });
    saveBindings(map);
  }

  function channelPrefs() {
    let prefs = {};
    try {
      prefs = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}') || {};
    } catch (e) { /* ignore */ }
    const email = !!prefs.agenda_reminder_email;
    const push = !!prefs.agenda_reminder_push;
    const channels = [];
    if (email) channels.push('email');
    if (push) channels.push('push');
    return channels;
  }

  async function syncEventReminders(eventId, eventLike) {
    const S = global.NotesStore;
    if (!S || typeof S.api !== 'function' || !eventId) return;
    const row = eventLike || (S.listAgendaEvents?.() || []).find((e) => e.id === eventId);
    if (!row) return;
    const nowMs = Date.now();
    const channels = channelPrefs();
    const planned = computePlannedReminders({ ...row, id: eventId }, channels, nowMs);
    mergeBindings(planned);
    const deleteIds = (row.scheduled_reminder_ids || []).map((x) => x.id).filter(Boolean);
    const body = {
      reminders: publicUploadRows(planned),
      delete_ids: deleteIds,
    };
    await S.api('/api/agenda-reminders/sync', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const nextIds = planned.map((p) => ({ id: p.id, channel: p.channel, fire_at: p.fire_at }));
    if (typeof S.upsertAgendaEvent === 'function') {
      const prev = S.get(eventId);
      const content = prev?.content?.type === 'agenda_event' ? prev.content : row;
      await S.upsertAgendaEvent(eventId, { ...content, scheduled_reminder_ids: nextIds });
    }
  }

  async function cancelEventReminders(eventId, row) {
    const S = global.NotesStore;
    if (!S || typeof S.api !== 'function' || !eventId) return;
    const ids = (row?.scheduled_reminder_ids || []).map((x) => x.id).filter(Boolean);
    await S.api('/api/agenda-reminders/sync', {
      method: 'POST',
      body: JSON.stringify({ reminders: [], delete_ids: ids }),
    });
    const map = loadBindings();
    ids.forEach((id) => { delete map[id]; });
    saveBindings(map);
  }

  function loadChannelToggles() {
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}') || {}; } catch (e) { /* ignore */ }
    const emailEl = document.getElementById('agenda-reminder-email');
    const pushEl = document.getElementById('agenda-reminder-push');
    if (emailEl instanceof HTMLInputElement) emailEl.checked = !!prefs.agenda_reminder_email;
    if (pushEl instanceof HTMLInputElement) pushEl.checked = !!prefs.agenda_reminder_push;
  }

  function saveChannelPrefs() {
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem('deeperguard-prefs') || '{}') || {}; } catch (e) { prefs = {}; }
    const emailEl = document.getElementById('agenda-reminder-email');
    const pushEl = document.getElementById('agenda-reminder-push');
    prefs.agenda_reminder_email = !!(emailEl && emailEl.checked);
    prefs.agenda_reminder_push = !!(pushEl && pushEl.checked);
    try { localStorage.setItem('deeperguard-prefs', JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }

  async function refreshPushConfigUi() {
    const btn = document.getElementById('agenda-reminder-enable-push');
    const status = document.getElementById('agenda-reminder-push-status');
    const S = global.NotesStore;
    if (!btn || !S || typeof S.api !== 'function') return;
    try {
      const data = await S.api('/api/agenda-reminders/push-config');
      const ready = !!data?.push_ready;
      btn.hidden = !ready;
      if (status) {
        status.hidden = ready;
        status.textContent = ready ? '' : "Push isn't available yet.";
      }
    } catch (e) {
      if (status) {
        status.hidden = false;
        status.textContent = 'Could not load push configuration.';
      }
      btn.hidden = true;
    }
  }

  async function enablePushFromGesture() {
    const S = global.NotesStore;
    if (!S || typeof S.api !== 'function') return;
    if (!('Notification' in global) || !navigator.serviceWorker?.pushManager) {
      if (typeof global.toast === 'function') toast('Push is not supported in this browser', true);
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    const cfg = await S.api('/api/agenda-reminders/push-config');
    const key = cfg?.vapid_public_key;
    if (!key) {
      if (typeof global.toast === 'function') toast("Push isn't available yet.", true);
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
    saveChannelPrefs();
    if (typeof global.toast === 'function') toast('Push enabled on this device');
  }

  function wireAgendaReminderSettings() {
    loadChannelToggles();
    refreshPushConfigUi();
    document.getElementById('agenda-reminder-email')?.addEventListener('change', saveChannelPrefs);
    document.getElementById('agenda-reminder-push')?.addEventListener('change', saveChannelPrefs);
    document.getElementById('agenda-reminder-enable-push')?.addEventListener('click', () => {
      enablePushFromGesture().catch(() => {});
    });
  }

  global.NotesAgendaReminders = {
    OFFSET_PRESETS,
    GENERIC_PUSH_TITLE,
    genericBody,
    normalizeOffsets,
    computePlannedReminders,
    publicUploadRows,
    expandOccurrenceStarts,
    syncEventReminders,
    cancelEventReminders,
    channelPrefs,
    ALLOWED_UPLOAD_KEYS,
    wireAgendaReminderSettings,
    loadChannelToggles,
    enablePushFromGesture,
  };
}(typeof window !== 'undefined' ? window : globalThis));
