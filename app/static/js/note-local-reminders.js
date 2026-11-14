/**
 * Local note reminders (docs/REMINDERS_TASKS_SPEC.md sections 2.1 and 4).
 *
 * - The reminder lives in the encrypted note content (`content.reminder`). Nothing here uses the
 *   network: no fetch, no endpoint, no time sent to the server.
 * - It fires only while Deeperguard is open and the vault is unlocked (the planner returns early
 *   when locked). A reminder that came due earlier (up to 14 days) is shown once, marked missed.
 * - An OS notification is always generic: it never contains the note title or text.
 */
(function (global) {
  const MS_MIN = 60000;
  const MISSED_WINDOW_MS = 14 * 24 * 3600 * 1000;
  const LATE_GRACE_MS = 5 * MS_MIN;
  const TICK_MS = 15000;
  const MAX_BANNERS = 6;
  const NOTIFICATION_TITLE = 'Deeperguard';
  const NOTIFICATION_BODY = 'You have a reminder';
  const CLOSED_APP_TEXT = 'If Deeperguard is closed, nothing can remind you. Open it and we will show what you missed. To be notified while it is closed, you can turn on email or push reminders, but then our server learns when the reminder is due (never what it is about).';
  const PERMISSION_EXPLAINER = 'Reminders only work while Deeperguard is open and unlocked.\nThey stay on your devices: we never learn what or when. If you close the app or lock your vault, you will not be notified. Missed reminders are shown the next time you unlock.';
  const SETTINGS_TEXT = 'Local reminders are checked only while Deeperguard is open and your vault is unlocked. They are private: the time and text are encrypted and never sent to our server.';
  const DENIED_TEXT = 'Notifications are blocked in your browser settings. Reminders will appear inside Deeperguard when it is open.';

  /** `datetime-local` value -> 'YYYY-MM-DDTHH:mm:ss', '' when invalid. */
  function normalizeAt(value) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/.exec(String(value || '').trim());
    if (!m) return '';
    const iso = `${m[1]}T${m[2]}:${m[3] || '00'}`;
    return Number.isFinite(new Date(iso).getTime()) ? iso : '';
  }

  function buildReminder(value, prev) {
    const at = normalizeAt(value);
    if (!at) return null;
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* ignore */ }
    const base = prev && typeof prev === 'object' ? prev : {};
    // A new time starts fresh: it must fire again even if the old one already did. Unknown keys stay.
    return { ...base, v: 1, at, tz, repeat: '', snoozed_until: '', fired_at: '', dismissed_at: '' };
  }

  function ms(s) {
    const t = s ? new Date(s).getTime() : NaN;
    return Number.isFinite(t) ? t : NaN;
  }

  /** Instant the reminder is (next) due, or NaN when absent, unreadable or from a newer version. */
  function dueAt(rem) {
    if (!rem || typeof rem !== 'object' || rem.v !== 1) return NaN;
    const at = ms(rem.at);
    if (!Number.isFinite(at)) return NaN;
    const snooze = ms(rem.snoozed_until);
    return Number.isFinite(snooze) && snooze > at ? snooze : at;
  }

  function isHandled(rem, due) {
    const f = ms(rem.fired_at);
    const d = ms(rem.dismissed_at);
    return (Number.isFinite(f) && f >= due) || (Number.isFinite(d) && d >= due);
  }

  /** Not-yet-shown reminders of live notes with due time in (now - 14 days, now]. */
  function dueNotes(notes, nowMs) {
    const out = [];
    for (const n of notes || []) {
      const c = n && n.content;
      if (!c || c.type !== 'note' || c.trashed || c.deleted || !c.reminder) continue;
      const due = dueAt(c.reminder);
      if (!Number.isFinite(due) || due > nowMs || due < nowMs - MISSED_WINDOW_MS) continue;
      if (isHandled(c.reminder, due)) continue;
      out.push({ uuid: n.uuid, due, missed: nowMs - due > LATE_GRACE_MS });
    }
    return out.sort((a, b) => a.due - b.due);
  }

  function randomTag() {
    const c = global.crypto;
    if (c && typeof c.getRandomValues === 'function') {
      return `r${Array.from(c.getRandomValues(new Uint32Array(2)), (x) => x.toString(36)).join('')}`;
    }
    return `r${Math.random().toString(36).slice(2)}`;
  }

  /** Generic OS notification: no title, no text, random tag (not the note id). */
  function showNotification() {
    const N = global.Notification;
    if (typeof N !== 'function' || N.permission !== 'granted') return null;
    try {
      const n = new N(NOTIFICATION_TITLE, { body: NOTIFICATION_BODY, tag: randomTag() });
      n.onclick = () => { try { global.focus(); } catch (e) { /* ignore */ } n.close(); };
      return n;
    } catch (e) {
      return null; // some mobile browsers only allow notifications from a service worker
    }
  }

  function bannerRoot() {
    const doc = global.document;
    if (!doc || !doc.body) return null;
    let root = doc.getElementById('note-reminder-banners');
    if (!root) {
      root = doc.createElement('div');
      root.id = 'note-reminder-banners';
      root.className = 'agenda-local-reminder-banners';
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      doc.body.appendChild(root);
    }
    return root;
  }

  function showBanner(r, title, hooks) {
    const root = bannerRoot();
    if (!root) return;
    const doc = global.document;
    const item = doc.createElement('div');
    item.className = `agenda-local-reminder${r.missed ? ' is-missed' : ''}`;
    const text = doc.createElement('div');
    text.className = 'agenda-local-reminder-text';
    const strong = doc.createElement('strong');
    strong.textContent = (r.missed ? 'Missed: ' : '') + (title || 'Note reminder');
    text.appendChild(strong);
    if (r.missed) {
      const foot = doc.createElement('span');
      foot.textContent = CLOSED_APP_TEXT;
      text.appendChild(foot);
    }
    const open = doc.createElement('button');
    open.type = 'button';
    open.className = 'btn ghost sm';
    open.textContent = 'Open';
    open.addEventListener('click', () => { if (hooks.open) hooks.open(r.uuid); item.remove(); });
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'btn ghost sm';
    close.textContent = 'Dismiss';
    close.addEventListener('click', () => { if (hooks.dismiss) hooks.dismiss(r.uuid); item.remove(); });
    item.append(text, open, close);
    root.appendChild(item);
    while (root.children.length > MAX_BANNERS) root.firstElementChild.remove();
  }

  /** deps (tests): now, isUnlocked, listNotes, update(uuid, reminder), banner(r, title), notify(), isHidden(), open(uuid). */
  function createPlanner(deps) {
    const d = deps || {};
    const now = d.now || (() => Date.now());
    const S = () => global.NotesStore;
    const isUnlocked = d.isUnlocked || (() => !!(S() && S().isUnlocked && S().isUnlocked()));
    const listNotes = d.listNotes || (() => (S() && S().listNotes ? S().listNotes() : []));
    const find = (uuid) => listNotes().find((n) => n.uuid === uuid);
    const update = d.update || ((uuid, reminder) => {
      const n = S().get(uuid);
      if (n) S().upsert(uuid, { ...n.content, reminder });
    });
    const isHidden = d.isHidden || (() => !!(global.document && global.document.hidden));
    const notify = d.notify || showNotification;
    const hooks = {
      open: d.open || ((uuid) => { if (global.NotesNoteReminderOpen) global.NotesNoteReminderOpen(uuid); }),
      dismiss: (uuid) => {
        const n = find(uuid);
        if (n && n.content.reminder) update(uuid, { ...n.content.reminder, dismissed_at: new Date(now()).toISOString() });
      },
    };
    const banner = d.banner || ((r, title) => showBanner(r, title, hooks));

    function check() {
      if (!isUnlocked()) return [];
      const nowMs = now();
      const due = dueNotes(listNotes(), nowMs);
      for (const r of due) {
        const n = find(r.uuid);
        // Marked first (encrypted, syncs) so no other pass or device shows it twice.
        update(r.uuid, { ...n.content.reminder, fired_at: new Date(nowMs).toISOString() });
        try { banner(r, n.content.title || ''); } catch (e) { /* keep going */ }
        if (!r.missed && isHidden()) { try { notify(); } catch (e) { /* ignore */ } }
      }
      return due;
    }

    let timer = null;
    const safeCheck = () => { try { check(); } catch (e) { /* ignore */ } };
    function start() {
      if (timer) return;
      timer = setInterval(safeCheck, d.tickMs || TICK_MS);
      if (global.document && global.document.addEventListener) {
        global.document.addEventListener('visibilitychange', safeCheck);
      }
      safeCheck();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { check, start, stop };
  }

  /** Asks the browser only after the explicit click, behind our own explanation. */
  async function requestNotificationPermission(confirmFn) {
    const N = global.Notification;
    if (typeof N !== 'function') return 'unsupported';
    if (N.permission !== 'default') return N.permission;
    const ask = confirmFn || (typeof global.confirm === 'function' ? global.confirm.bind(global) : () => false);
    if (!ask(PERMISSION_EXPLAINER)) return 'default';
    try { return await N.requestPermission(); } catch (e) { return 'default'; }
  }

  function permissionText() {
    const N = global.Notification;
    if (typeof N !== 'function') return 'This browser does not support notifications. Reminders show inside Deeperguard only.';
    if (N.permission === 'denied') return DENIED_TEXT;
    return '';
  }

  let planner = null;
  function startInBrowser() {
    if (!planner) planner = createPlanner();
    planner.start();
  }
  if (global.document && typeof global.document.addEventListener === 'function' && !global.__DG_NO_LOCAL_REMINDERS) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', startInBrowser);
    else startInBrowser();
  }

  global.NotesNoteReminders = {
    MISSED_WINDOW_MS,
    LATE_GRACE_MS,
    NOTIFICATION_TITLE,
    NOTIFICATION_BODY,
    CLOSED_APP_TEXT,
    PERMISSION_EXPLAINER,
    SETTINGS_TEXT,
    DENIED_TEXT,
    normalizeAt,
    buildReminder,
    dueAt,
    dueNotes,
    createPlanner,
    showNotification,
    requestNotificationPermission,
    permissionText,
    toInputValue: (rem) => (rem && rem.v === 1 ? normalizeAt(rem.at).slice(0, 16) : ''),
  };
}(typeof window !== 'undefined' ? window : globalThis));
