/**
 * Reminders for dated tasks, on the existing window-push path (docs/design/reminders.md §3.2, §4, M3).
 *
 * - The task keeps `reminder: { offsets: [minutes] }` in the encrypted vault item.
 * - Each reminder is uploaded to `POST /api/push-windows` as `{ id, window_start }` only: a random
 *   32-hex id that is not derived from the task, and the start of the 15-minute window (a multiple of
 *   900 s, rounded down, so it can arrive up to 15 minutes early). No title, date or exact time.
 * - The ids of the uploaded windows are kept in the task (`reminder_windows`), so ticking the task off,
 *   deleting it, or changing its date or offsets withdraws them (`POST /api/push-windows/delete`).
 * - The push itself is empty; the service worker shows its own generic text.
 * - A withdrawal that fails (offline) is queued on this device as bare ids and retried.
 */
(function (global) {
  'use strict';

  const WINDOW_SEC = 900;
  const MAX_AHEAD_SEC = 365 * 86400; // the server refuses windows more than 366 days ahead
  const DEFAULT_TIME = '09:00';
  const PENDING_KEY = 'task_reminder_pending_deletes_v1';
  const ID_RE = /^[0-9a-f]{32}$/;

  function tasksApi() {
    return global.NotesAgendaTasks || null;
  }

  function remindersApi() {
    return global.NotesAgendaReminders || null;
  }

  function entitled() {
    const R = remindersApi();
    return !!(R && typeof R.hasAgendaRemindersEntitlement === 'function' && R.hasAgendaRemindersEntitlement());
  }

  function randomId() {
    const bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Window starts (seconds, multiples of 900) for a task: sorted, unique, in the future, not too far ahead. */
  function plannedWindows(task, nowMs) {
    const T = tasksApi();
    if (!T || !task || T.isDone(task)) return [];
    const offsets = (task.reminder && Array.isArray(task.reminder.offsets) ? task.reminder.offsets : [])
      .filter((n) => Number.isInteger(n) && n >= 0);
    const due = T.parseDue(task.due);
    if (!offsets.length || !due) return [];
    const [hh, mm] = (/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(task.due_time || '')) ? task.due_time : DEFAULT_TIME)
      .split(':').map(Number);
    const dueMs = new Date(due.getFullYear(), due.getMonth(), due.getDate(), hh, mm).getTime();
    const out = new Set();
    for (const minutes of offsets) {
      const start = Math.floor((dueMs - minutes * 60000) / 1000 / WINDOW_SEC) * WINDOW_SEC;
      // A window that has already begun would push at once, before the real time: skip it.
      if (start * 1000 <= nowMs || start > nowMs / 1000 + MAX_AHEAD_SEC) continue;
      out.add(start);
    }
    return [...out].sort((a, b) => a - b);
  }

  function storedWindows(task) {
    const list = task && Array.isArray(task.reminder_windows) ? task.reminder_windows : [];
    return list.filter((w) => w && ID_RE.test(String(w.id)) && Number.isInteger(w.window_start));
  }

  /** Endpoint of this browser's push subscription, or '' when push is not turned on here. */
  async function deviceEndpoint() {
    try {
      const reg = await global.navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      return sub ? String(sub.endpoint || '') : '';
    } catch (e) {
      return '';
    }
  }

  // ---- withdrawals that could not be sent (ids only) ----

  function loadPending() {
    try {
      const raw = JSON.parse(global.localStorage.getItem(PENDING_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((x) => ID_RE.test(String(x))) : [];
    } catch (e) {
      return [];
    }
  }

  function savePending(ids) {
    try {
      const uniq = [...new Set(ids)].slice(-2000);
      if (uniq.length) global.localStorage.setItem(PENDING_KEY, JSON.stringify(uniq));
      else global.localStorage.removeItem(PENDING_KEY);
    } catch (e) { /* ignore */ }
  }

  async function postDelete(ids) {
    const S = global.NotesStore;
    for (let i = 0; i < ids.length; i += 50) {
      await S.api('/api/push-windows/delete', {
        method: 'POST',
        body: JSON.stringify({ ids: ids.slice(i, i + 50) }),
      });
    }
  }

  /** Withdraw ids; whatever cannot be sent now is queued and retried. */
  async function withdraw(ids) {
    const list = [...new Set(ids)].filter((id) => ID_RE.test(id));
    if (!list.length) return;
    try {
      await postDelete(list);
    } catch (err) {
      savePending([...loadPending(), ...list]);
      throw err;
    }
  }

  async function flushPending() {
    const S = global.NotesStore;
    const ids = loadPending();
    if (!ids.length || !S || typeof S.api !== 'function') return;
    try {
      await postDelete(ids);
      savePending(loadPending().filter((id) => !ids.includes(id)));
    } catch (e) { /* still offline: stays queued */ }
  }

  // ---- sync ----

  let chain = Promise.resolve();

  function storedTask(taskId) {
    const S = global.NotesStore;
    return (S && typeof S.listAgendaTasks === 'function' ? S.listAgendaTasks() : []).find((t) => t.id === taskId) || null;
  }

  async function syncNow(taskId) {
    const S = global.NotesStore;
    if (!S || typeof S.api !== 'function' || !taskId) return;
    const task = storedTask(taskId);
    if (!task) return;
    const previous = storedWindows(task);
    const wanted = entitled() ? plannedWindows(task, Date.now()) : [];
    if (!wanted.length && !previous.length) return;
    const kept = previous.filter((w) => wanted.includes(w.window_start));
    const stale = previous.filter((w) => !wanted.includes(w.window_start)).map((w) => w.id);
    const missing = wanted.filter((start) => !kept.some((w) => w.window_start === start));
    const save = (windows) => {
      const same = windows.length === previous.length && windows.every((w) => previous.some((p) => p.id === w.id));
      const current = storedTask(taskId);
      if (same || !current) return;
      const { id: _drop, ...content } = current;
      S.upsertAgendaTask(taskId, { ...content, reminder_windows: windows });
    };
    let next = kept;
    let failure = null;
    try {
      await withdraw(stale);
    } catch (err) {
      failure = err; // the withdrawal is queued; keep going so the task stops listing the ids
    }
    if (missing.length) {
      const endpoint = await deviceEndpoint();
      if (!endpoint) {
        failure = failure || Object.assign(new Error('push is not turned on for this device'), { code: 'no_device' });
      } else {
        const added = missing.map((start) => ({ id: randomId(), window_start: start }));
        try {
          await S.api('/api/push-windows', {
            method: 'POST',
            body: JSON.stringify({ endpoint, windows: added }),
          });
          next = [...kept, ...added];
        } catch (err) {
          failure = failure || err;
        }
      }
    }
    save(next);
    if (failure) throw failure;
  }

  /** Bring the server windows of one task in line with the task as stored (safe to call repeatedly). */
  function syncTaskReminders(taskId) {
    const run = chain.then(() => syncNow(taskId));
    chain = run.catch(() => {});
    return run;
  }

  /** Withdraw every window of a task that is being deleted. */
  function cancelTaskReminders(row) {
    const ids = storedWindows(row).map((w) => w.id);
    const run = chain.then(() => withdraw(ids));
    chain = run.catch(() => {});
    return run;
  }

  /** On opening the Agenda: retry queued withdrawals, then re-plan tasks that have a reminder. */
  async function onAgendaShown() {
    const S = global.NotesStore;
    if (!S || typeof S.listAgendaTasks !== 'function') return;
    if (typeof S.isUnlocked === 'function' && !S.isUnlocked()) return;
    await flushPending();
    for (const t of S.listAgendaTasks()) {
      const has = t.reminder && Array.isArray(t.reminder.offsets) && t.reminder.offsets.length;
      if (!has && !storedWindows(t).length) continue;
      try {
        await syncTaskReminders(t.id);
      } catch (e) {
        return; // offline or no device: retried on the next visit
      }
    }
  }

  if (typeof global.addEventListener === 'function') {
    global.addEventListener('online', () => { flushPending(); });
  }

  global.NotesAgendaTaskReminders = {
    WINDOW_SEC,
    DEFAULT_TIME,
    plannedWindows,
    deviceEndpoint,
    randomId,
    withdraw,
    syncTaskReminders,
    cancelTaskReminders,
    flushPending,
    onAgendaShown,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.NotesAgendaTaskReminders;
}(typeof window !== 'undefined' ? window : globalThis));
