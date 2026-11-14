/**
 * Local event reminders (docs/design/calendar-multi.md §5.1, phase 1).
 *
 * - Runs only in this browser while Deeperguard is open and the vault is unlocked. Nothing here
 *   calls the network: no fetch, no server endpoint, no third party. The server-side email/push
 *   reminders (Pro, `agenda-reminders.js`) are a separate, optional channel.
 * - The planner reads the decrypted events, expands occurrences with the same expander the
 *   calendar draws with, and fires each reminder (offset in minutes before the start) once.
 * - Display: always a banner in the app; also a browser Notification when the user allowed it.
 *   Permission is asked only after a click on "Allow browser notifications".
 * - A reminder that came due while Deeperguard was closed (up to 24 hours back) is shown once,
 *   marked "Missed", the next time the app is open. No OS notification for those.
 * - Several open tabs: "already shown" is kept in localStorage and claimed under a Web Lock
 *   (`navigator.locks`), so exactly one tab shows each reminder. The stored keys are hashes, so
 *   event ids and times do not sit in plain text in localStorage.
 */
(function (global) {
  const MS_MIN = 60000;
  const MISSED_WINDOW_MS = 24 * 3600 * 1000;
  /** A reminder shown later than this after its time counts as missed (background tabs throttle timers). */
  const LATE_GRACE_MS = 5 * MS_MIN;
  const TICK_MS = 15000;
  const SHOWN_KEY = 'agenda_local_reminders_shown_v1';
  const LOCK_NAME = 'deeperguard-agenda-local-reminders';
  const MAX_BANNERS = 6;

  function reminderApi() {
    return global.NotesAgendaReminders || null;
  }

  function offsetsOf(ev) {
    const R = reminderApi();
    return R && typeof R.offsetMinutes === 'function' ? R.offsetMinutes(ev && ev.reminders) : [];
  }

  /** Two 32-bit FNV-1a hashes: an opaque, stable key for localStorage. */
  function hashKey(s) {
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    }
    return a.toString(36) + b.toString(36);
  }

  /**
   * Reminders of `events` whose fire time is in (fromMs, toMs], oldest first. A reminder whose time
   * had already passed when the event was last saved is skipped: it was never "upcoming".
   */
  function dueReminders(events, fromMs, toMs) {
    const R = reminderApi();
    if (!R || typeof R.expandOccurrences !== 'function') return [];
    const out = [];
    for (const ev of events || []) {
      if (!ev || !ev.id || ev.type === 'agenda_task') continue;
      const offsets = offsetsOf(ev);
      if (!offsets.length) continue;
      const maxOffset = offsets[offsets.length - 1];
      const savedMs = Date.parse(ev.updated_at || '') || 0;
      const occ = R.expandOccurrences(ev, new Date(fromMs), new Date(toMs + maxOffset * MS_MIN + 1));
      for (const o of occ) {
        for (const minutes of offsets) {
          const fireAt = o.start.getTime() - minutes * MS_MIN;
          if (fireAt <= fromMs || fireAt > toMs || fireAt < savedMs) continue;
          out.push({
            key: `${ev.id}|${o.slotMs}|${minutes}`,
            eventId: ev.id,
            title: String(ev.title || '').trim(),
            allDay: !!ev.all_day,
            start: o.start,
            minutes,
            fireAt,
          });
        }
      }
    }
    return out.sort((a, b) => a.fireAt - b.fireAt);
  }

  function readShown(storage, nowMs) {
    let raw = {};
    try { raw = JSON.parse(storage.getItem(SHOWN_KEY) || '{}') || {}; } catch (e) { raw = {}; }
    const out = {};
    for (const [k, exp] of Object.entries(raw)) {
      if (Number(exp) > nowMs) out[k] = Number(exp);
    }
    return out;
  }

  function writeShown(storage, shown) {
    try { storage.setItem(SHOWN_KEY, JSON.stringify(shown)); } catch (e) { /* storage full or blocked */ }
  }

  function defaultLocks() {
    const nav = global.navigator;
    return nav && nav.locks && typeof nav.locks.request === 'function' ? nav.locks : null;
  }

  /**
   * One planner per tab. `deps` lets tests replace time, storage, the lock manager and the output.
   * show(item) receives { ...reminder, missed }.
   */
  function createPlanner(deps) {
    const d = deps || {};
    const now = d.now || (() => Date.now());
    const storage = d.storage || global.localStorage;
    const locks = 'locks' in d ? d.locks : defaultLocks();
    const listEvents = d.listEvents || (() => {
      const S = global.NotesStore;
      return S && typeof S.listAgendaEvents === 'function' ? S.listAgendaEvents() : [];
    });
    const isUnlocked = d.isUnlocked || (() => {
      const S = global.NotesStore;
      return !!(S && typeof S.isUnlocked === 'function' && S.isUnlocked());
    });
    const show = d.show || showReminder;

    /** Marks the due reminders as shown and returns the ones this tab must display. */
    function claim(due, nowMs) {
      const shown = readShown(storage, nowMs);
      const mine = [];
      for (const r of due) {
        const h = hashKey(r.key);
        if (shown[h]) continue;
        shown[h] = r.fireAt + 2 * MISSED_WINDOW_MS;
        mine.push({ ...r, missed: nowMs - r.fireAt > LATE_GRACE_MS });
      }
      if (mine.length) writeShown(storage, shown);
      return mine;
    }

    async function check() {
      if (!isUnlocked()) return [];
      const nowMs = now();
      const due = dueReminders(listEvents(), nowMs - MISSED_WINDOW_MS, nowMs);
      if (!due.length) return [];
      const mine = locks
        ? await locks.request(LOCK_NAME, async () => claim(due, now()))
        : claim(due, nowMs);
      mine.forEach((r) => {
        try { show(r); } catch (e) { /* one bad reminder must not block the rest */ }
      });
      return mine;
    }

    let timer = null;
    let running = false;
    function tick() {
      if (running) return;
      running = true;
      check().catch(() => {}).finally(() => { running = false; });
    }
    function start() {
      if (timer) return;
      timer = setInterval(tick, d.tickMs || TICK_MS);
      if (global.document && typeof global.document.addEventListener === 'function') {
        global.document.addEventListener('visibilitychange', tick);
      }
      tick();
    }
    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
    return { check, start, stop };
  }

  // ---- output ---------------------------------------------------------------

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function whenText(r) {
    if (r.allDay) return 'All day';
    return `${pad2(r.start.getHours())}:${pad2(r.start.getMinutes())}`;
  }

  function reminderText(r) {
    const title = r.title || 'Event';
    const R = reminderApi();
    const offset = R && typeof R.offsetLabel === 'function' ? R.offsetLabel(r.minutes) : '';
    const day = r.start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    return {
      title: r.missed ? `Missed: ${title}` : title,
      body: `${day}, ${whenText(r)}${offset ? ` (${offset.toLowerCase()})` : ''}`,
    };
  }

  function bannerRoot() {
    const doc = global.document;
    if (!doc || !doc.body) return null;
    let root = doc.getElementById('agenda-local-reminder-banners');
    if (!root) {
      root = doc.createElement('div');
      root.id = 'agenda-local-reminder-banners';
      root.className = 'agenda-local-reminder-banners';
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      doc.body.appendChild(root);
    }
    return root;
  }

  function showBanner(r) {
    const root = bannerRoot();
    if (!root) return;
    const t = reminderText(r);
    const doc = global.document;
    const item = doc.createElement('div');
    item.className = `agenda-local-reminder${r.missed ? ' is-missed' : ''}`;
    const text = doc.createElement('div');
    text.className = 'agenda-local-reminder-text';
    const strong = doc.createElement('strong');
    strong.textContent = t.title;
    const body = doc.createElement('span');
    body.textContent = t.body;
    text.append(strong, body);
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'btn ghost sm';
    close.textContent = 'Dismiss';
    close.addEventListener('click', () => item.remove());
    item.append(text, close);
    root.appendChild(item);
    while (root.children.length > MAX_BANNERS) root.firstElementChild.remove();
  }

  function showNotification(r) {
    if (r.missed) return; // late OS notifications would be wrong; the banner says "Missed"
    const N = global.Notification;
    if (typeof N !== 'function' || N.permission !== 'granted') return;
    const t = reminderText(r);
    try {
      const n = new N(t.title, { body: t.body, tag: hashKey(r.key) });
      n.onclick = () => { try { global.focus(); } catch (e) { /* ignore */ } n.close(); };
    } catch (e) { /* some mobile browsers only allow notifications from a service worker */ }
  }

  function showReminder(r) {
    try { showBanner(r); } catch (e) { /* no DOM: the notification can still show */ }
    showNotification(r);
  }

  // ---- settings: notification permission (asked only after a click) ----------

  function permissionText() {
    const N = global.Notification;
    if (typeof N !== 'function') return 'This browser does not support notifications. Reminders show inside Deeperguard only.';
    if (N.permission === 'granted') return 'Browser notifications are allowed on this device.';
    if (N.permission === 'denied') return 'Browser notifications are blocked. Reminders show inside Deeperguard only. Allow notifications for this site in your browser settings to get them.';
    return 'Reminders show inside Deeperguard. Allow browser notifications to also see them outside this tab.';
  }

  function refreshPermissionUi() {
    const doc = global.document;
    if (!doc) return;
    const status = doc.getElementById('agenda-local-reminder-permission-status');
    const btn = doc.getElementById('agenda-local-reminder-allow');
    const N = global.Notification;
    if (status) status.textContent = permissionText();
    if (btn) btn.hidden = !(typeof N === 'function' && N.permission === 'default');
  }

  function wireSettings() {
    const doc = global.document;
    const btn = doc && doc.getElementById('agenda-local-reminder-allow');
    refreshPermissionUi();
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const N = global.Notification;
      if (typeof N !== 'function' || typeof N.requestPermission !== 'function') return;
      Promise.resolve(N.requestPermission()).catch(() => {}).finally(refreshPermissionUi);
    });
  }

  let planner = null;
  function startInBrowser() {
    wireSettings();
    if (!planner) planner = createPlanner();
    planner.start();
  }

  if (global.document && typeof global.document.addEventListener === 'function' && !global.__DG_NO_LOCAL_REMINDERS) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', startInBrowser);
    else startInBrowser();
  }

  global.NotesAgendaLocalReminders = {
    MISSED_WINDOW_MS,
    LATE_GRACE_MS,
    SHOWN_KEY,
    LOCK_NAME,
    dueReminders,
    createPlanner,
    reminderText,
    hashKey,
    wireSettings,
    refreshPermissionUi,
  };
}(typeof window !== 'undefined' ? window : globalThis));
