/**
 * Local reminders for events, tasks and notes (docs/design/calendar-multi.md §5.1,
 * docs/design/reminders.md §4).
 *
 * - Runs only in this browser while Deeperguard is open and the vault is unlocked. Nothing here
 *   calls the network: no fetch, no server endpoint, no third party. The server-side email/push
 *   reminders (Pro, `agenda-reminders.js`) are a separate, optional channel.
 * - The planner reads the decrypted events, expands occurrences with the same expander the
 *   calendar draws with, and fires each reminder (offset in minutes before the start) once. Dated
 *   tasks (`reminder.offsets` before the due time, 09:00 without a time) and notes
 *   (`reminders[0].at`) fire on their exact minute the same way.
 * - Display: always a banner in the app; also a browser Notification when the user allowed it.
 *   Permission is asked only after a click: on "Allow browser notifications", or when the user
 *   saves an event with a reminder for the first time. Never while loading.
 * - A reminder that came due while Deeperguard was closed (up to 24 hours back) is shown once,
 *   marked "Missed", the next time the app is open. No OS notification for those.
 * - Several open tabs: "already shown" is kept in localStorage and claimed under a Web Lock
 *   (`navigator.locks`), so exactly one tab shows each reminder. The stored keys are hashes, so
 *   event ids and times do not sit in plain text in localStorage.
 * - De-duplication with server pushes: what this device showed is written to IndexedDB
 *   (`deeperguard-reminder-dedup`), which the service worker reads when a push arrives (sw.js).
 *   Stored are only ids and times the server already has: the agenda push id of a shown event
 *   reminder, and for the window pushes of tasks and notes the random window id, its 15-minute
 *   start and whether every reminder in it was shown. Titles never go there; nothing is sent.
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
  const WINDOW_SEC = 900;
  const FINE_WINDOW_SEC = 300;
  const DEFAULT_TASK_TIME = '09:00'; // same default as agenda-task-reminders.js
  const WINDOW_ID_RE = /^[0-9a-f]{32}$/;
  const DEDUP_DB = 'deeperguard-reminder-dedup';
  const DEDUP_STORE = 'state';
  /** Windows listed for the service worker: pushes may arrive this late (server limit plus delivery delay). */
  const DEDUP_BACK_MS = 2 * 3600 * 1000;
  const DEDUP_AHEAD_MS = 15 * MS_MIN;
  const DEDUP_TIMEOUT_MS = 2000;

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
            kind: 'event',
            eventId: ev.id,
            slotMs: o.slotMs,
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

  /** Whether `start` is the 15-minute window of `ms`, or its 5-minute window (the opt-in finer size). */
  function inWindow(ms, start) {
    return [WINDOW_SEC, FINE_WINDOW_SEC].some((size) => Math.floor(ms / 1000 / size) * size === start);
  }

  /** Due moment of a task in local time ({ ms, timed }), or null without a valid date. */
  function taskDue(task) {
    const T = global.NotesAgendaTasks;
    const due = T && typeof T.parseDue === 'function' ? T.parseDue(task && task.due) : null;
    if (!due) return null;
    const timed = /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(task.due_time || ''));
    const [hh, mm] = (timed ? task.due_time : DEFAULT_TASK_TIME).split(':').map(Number);
    return { ms: new Date(due.getFullYear(), due.getMonth(), due.getDate(), hh, mm).getTime(), timed };
  }

  function taskOffsets(task) {
    const list = task && task.reminder && Array.isArray(task.reminder.offsets) ? task.reminder.offsets : [];
    return [...new Set(list.filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b);
  }

  function taskIsDone(task) {
    const T = global.NotesAgendaTasks;
    return !!(T && typeof T.isDone === 'function' && T.isDone(task));
  }

  function taskKey(task, dueMs, minutes) {
    return `task|${task.id}|${dueMs}|${minutes}`;
  }

  /** Reminders of open dated tasks whose fire time is in (fromMs, toMs], oldest first. */
  function dueTaskReminders(tasks, fromMs, toMs) {
    const out = [];
    for (const task of tasks || []) {
      if (!task || !task.id || taskIsDone(task)) continue;
      const offsets = taskOffsets(task);
      const due = offsets.length ? taskDue(task) : null;
      if (!due) continue;
      const savedMs = Date.parse(task.updated_at || '') || 0;
      for (const minutes of offsets) {
        const fireAt = due.ms - minutes * MS_MIN;
        if (fireAt <= fromMs || fireAt > toMs || fireAt < savedMs) continue;
        out.push({
          key: taskKey(task, due.ms, minutes),
          kind: 'task',
          title: String(task.title || '').trim(),
          allDay: !due.timed,
          start: new Date(due.ms),
          minutes,
          fireAt,
        });
      }
    }
    return out.sort((a, b) => a.fireAt - b.fireAt);
  }

  function noteEntry(note) {
    const c = note && !note.deleted ? note.content : null;
    if (!c || c.trashed || !Array.isArray(c.reminders) || !c.reminders[0]) return null;
    const at = Date.parse(c.reminders[0].at);
    return Number.isFinite(at) && at > 0 ? { entry: c.reminders[0], at } : null;
  }

  function noteKey(note, at) {
    return `note|${note.uuid}|${at}`;
  }

  function noteTitle(note) {
    if (note.content.locked) return ''; // a protected note keeps its title off the lock screen
    const S = global.NotesSearch;
    const t = S && typeof S.effectiveNoteTitle === 'function' ? S.effectiveNoteTitle(note) : note.content.title;
    return String(t || '').trim();
  }

  /** Note reminders (`reminders[0].at`, exact time) in (fromMs, toMs], oldest first. */
  function dueNoteReminders(notes, fromMs, toMs) {
    const out = [];
    for (const note of notes || []) {
      const n = note && note.uuid ? noteEntry(note) : null;
      if (!n || n.at <= fromMs || n.at > toMs) continue;
      if (n.at < (Date.parse(note.content.updated_at || '') || 0)) continue;
      out.push({
        key: noteKey(note, n.at),
        kind: 'note',
        title: noteTitle(note),
        allDay: false,
        start: new Date(n.at),
        minutes: 0,
        fireAt: n.at,
      });
    }
    return out.sort((a, b) => a.fireAt - b.fireAt);
  }

  /**
   * Server windows (the random ids in a task's `reminder_windows` and a note's `rid`) that start in
   * [fromMs, toMs], each with the local reminder keys it stands for. A window whose reminders no
   * longer match the item gets no keys, so it never counts as shown.
   */
  function windowEntries(tasks, notes, fromMs, toMs) {
    const inRange = (start) => Number.isInteger(start) && start * 1000 >= fromMs && start * 1000 <= toMs;
    const out = [];
    for (const task of tasks || []) {
      const stored = task && task.id && Array.isArray(task.reminder_windows) ? task.reminder_windows : [];
      const due = stored.length && !taskIsDone(task) ? taskDue(task) : null;
      for (const w of stored) {
        if (!w || !WINDOW_ID_RE.test(String(w.id)) || !inRange(w.window_start)) continue;
        const keys = due
          ? taskOffsets(task).filter((m) => inWindow(due.ms - m * MS_MIN, w.window_start))
            .map((m) => taskKey(task, due.ms, m))
          : [];
        out.push({ rid: w.id, start: w.window_start, keys });
      }
    }
    for (const note of notes || []) {
      const n = note && note.uuid ? noteEntry(note) : null;
      if (!n || !WINDOW_ID_RE.test(String(n.entry.rid)) || !inRange(n.entry.window_start)) continue;
      const keys = inWindow(n.at, n.entry.window_start) ? [noteKey(note, n.at)] : [];
      out.push({ rid: n.entry.rid, start: n.entry.window_start, keys });
    }
    return out;
  }

  /**
   * What the service worker may rely on for empty window pushes: every window of this device that
   * starts in [from, to], and whether all its reminders were shown here. Windows of the previous
   * snapshot stay listed (a window already sent is withdrawn from its item) and stay shown.
   */
  function nextWindowSnapshot(prev, entries, shown, nowMs) {
    const from = nowMs - DEDUP_BACK_MS;
    const to = nowMs + DEDUP_AHEAD_MS;
    const byRid = new Map();
    for (const w of (prev && Array.isArray(prev.windows) ? prev.windows : [])) {
      if (w && w.start * 1000 >= from) byRid.set(w.rid, w);
    }
    for (const e of entries) {
      const old = byRid.get(e.rid);
      const tags = e.keys.map(hashKey);
      const done = tags.length > 0 && tags.every((t) => shown[t]);
      byRid.set(e.rid, {
        rid: e.rid,
        start: e.start,
        shown: !!(old && old.shown) || done,
        tags: [...new Set([...(old && Array.isArray(old.tags) ? old.tags : []), ...tags])],
      });
    }
    return { from, to, windows: [...byRid.values()].sort((a, b) => a.start - b.start) };
  }

  /** Read-modify-write of one key in the IndexedDB store shared with the service worker. */
  function idbDedupStore(factory) {
    let dbPromise = null;
    function open() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const req = factory.open(DEDUP_DB, 1);
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(DEDUP_STORE)) req.result.createObjectStore(DEDUP_STORE);
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        dbPromise.catch(() => { dbPromise = null; });
      }
      return dbPromise;
    }
    async function update(key, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DEDUP_STORE, 'readwrite');
        const store = tx.objectStore(DEDUP_STORE);
        const req = store.get(key);
        let next = null;
        req.onsuccess = () => {
          next = fn(req.result || null);
          store.put(next, key);
        };
        tx.oncomplete = () => resolve(next);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    return { update };
  }

  function defaultDedup() {
    return global.indexedDB && typeof global.indexedDB.open === 'function' ? idbDedupStore(global.indexedDB) : null;
  }

  function withTimeout(promise, ms) {
    let timer = null;
    const limit = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  }

  /** Agenda push id of an event reminder: agenda-reminders.js derives the same id for the server row. */
  async function eventPushId(r) {
    const R = reminderApi();
    if (!R || typeof R.reminderIdForKey !== 'function' || typeof R.offsetIdPart !== 'function') return '';
    return R.reminderIdForKey(`agenda-reminder|${r.eventId}|${r.slotMs}|${R.offsetIdPart(r.minutes)}|push`);
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
    const listTasks = d.listTasks || (() => {
      const S = global.NotesStore;
      return S && typeof S.listAgendaTasks === 'function' ? S.listAgendaTasks() : [];
    });
    const listNotes = d.listNotes || (() => {
      const S = global.NotesStore;
      return S && typeof S.listNotes === 'function' ? S.listNotes() : [];
    });
    const dedup = 'dedup' in d ? d.dedup : defaultDedup();
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

    /** Tell the service worker what this device has shown, before it is displayed. */
    async function recordForPush(mine, tasks, notes, nowMs) {
      if (!dedup) return;
      const ids = [];
      for (const r of mine) {
        if (r.kind !== 'event') continue;
        const id = await eventPushId(r);
        if (id) ids.push({ id, tag: hashKey(r.key), exp: r.fireAt + DEDUP_BACK_MS });
      }
      if (ids.length) {
        await dedup.update('ids', (prev) => {
          const next = {};
          for (const [id, v] of Object.entries(prev || {})) if (v && v.exp > nowMs) next[id] = v;
          for (const x of ids) next[x.id] = { tag: x.tag, exp: x.exp };
          return next;
        });
      }
      const entries = windowEntries(tasks, notes, nowMs - DEDUP_BACK_MS, nowMs + DEDUP_AHEAD_MS);
      const shown = readShown(storage, nowMs);
      await dedup.update('windows', (prev) => nextWindowSnapshot(prev, entries, shown, nowMs));
    }

    async function check() {
      if (!isUnlocked()) return [];
      const nowMs = now();
      const from = nowMs - MISSED_WINDOW_MS;
      const tasks = listTasks();
      const notes = listNotes();
      const due = [
        ...dueReminders(listEvents(), from, nowMs),
        ...dueTaskReminders(tasks, from, nowMs),
        ...dueNoteReminders(notes, from, nowMs),
      ].sort((a, b) => a.fireAt - b.fireAt);
      const run = async () => {
        const t = now();
        const claimed = due.length ? claim(due, t) : [];
        try {
          await withTimeout(recordForPush(claimed, tasks, notes, t), DEDUP_TIMEOUT_MS);
        } catch (e) { /* no IndexedDB: the reminder still shows, and a later push shows too */ }
        return claimed;
      };
      const mine = locks ? await locks.request(LOCK_NAME, run) : await run();
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
    const title = r.title || (r.kind === 'task' ? 'Task' : r.kind === 'note' ? 'Note' : 'Event');
    const R = reminderApi();
    const offset = r.kind !== 'note' && R && typeof R.offsetLabel === 'function' ? R.offsetLabel(r.minutes) : '';
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
    const tag = hashKey(r.key);
    const inPage = () => {
      try {
        const n = new N(t.title, { body: t.body, tag });
        n.onclick = () => { try { global.focus(); } catch (e) { /* ignore */ } n.close(); };
      } catch (e) { /* some mobile browsers only allow notifications from a service worker */ }
    };
    // Through the service worker when there is one: a later push for this reminder then replaces
    // it silently by tag instead of adding a second notification (sw.js).
    const sw = global.navigator && global.navigator.serviceWorker;
    if (!sw || typeof sw.getRegistration !== 'function') {
      inPage();
      return;
    }
    Promise.resolve(sw.getRegistration()).then((reg) => {
      if (!reg || typeof reg.showNotification !== 'function') return inPage();
      return reg.showNotification(t.title, {
        body: t.body, tag, icon: '/static/icons/icon-192.png', data: { url: '/app' },
      });
    }).catch(inPage);
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

  /**
   * Called from the click that saves an event with reminders: the first time the user sets one is
   * the moment to ask. Never at load, and never again once the browser has an answer.
   */
  function askPermissionForNewReminder(offsets) {
    const N = global.Notification;
    if (!Array.isArray(offsets) || !offsets.length) return;
    if (typeof N !== 'function' || N.permission !== 'default' || typeof N.requestPermission !== 'function') return;
    Promise.resolve(N.requestPermission()).catch(() => {}).finally(refreshPermissionUi);
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
    DEDUP_DB,
    DEDUP_STORE,
    dueReminders,
    dueTaskReminders,
    dueNoteReminders,
    createPlanner,
    reminderText,
    hashKey,
    wireSettings,
    refreshPermissionUi,
    askPermissionForNewReminder,
  };
}(typeof window !== 'undefined' ? window : globalThis));
