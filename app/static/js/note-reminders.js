/**
 * Closed-app reminders for notes, on the existing window-push path (docs/design/reminders.md §4, M4).
 *
 * - The note keeps `reminders: [{ at, push, rid, window_start }]` in its encrypted content.
 * - With `push` on, one window is uploaded to `POST /api/push-windows` as `{ id, window_start }` only:
 *   `id` is the random `rid` (not derived from the note), `window_start` is the reminder time rounded
 *   down to a multiple of 900 s (300 s on a device that opted in to the 5-minute window, which then
 *   also sends `window_sec: 300`), so the push can come up to 15 minutes early. No note id, no title, no
 *   exact time. The push is empty; the service worker shows its own generic text.
 * - Opening that notification makes the client look the note up locally (`findDueNote`): the note whose
 *   window has just begun. The server never learns which note it was.
 * - Trashing, deleting, clearing or moving the reminder withdraws the old window by `rid`.
 */
(function (global) {
  'use strict';

  const WINDOW_SEC = 900;
  const MAX_AHEAD_SEC = 365 * 86400; // the server refuses windows more than 366 days ahead
  const MAX_LATE_SEC = 1800; // the server drops a window more than 30 minutes late
  const ID_RE = /^[0-9a-f]{32}$/;

  function taskReminders() {
    return global.NotesAgendaTaskReminders || null;
  }

  function entitled() {
    const R = global.NotesAgendaReminders;
    return !!(R && typeof R.hasAgendaRemindersEntitlement === 'function' && R.hasAgendaRemindersEntitlement());
  }

  function firstEntry(content) {
    return content && Array.isArray(content.reminders) ? content.reminders[0] || null : null;
  }

  /** Window start (seconds, multiple of the window size) for a note's reminder, or 0 when none should be scheduled. */
  function plannedWindow(content, nowMs) {
    const entry = firstEntry(content);
    const ms = Date.parse(entry && entry.at);
    if (!entry || !entry.push || content.trashed || !Number.isFinite(ms) || ms <= 0) return 0;
    const TR = taskReminders();
    const size = TR ? TR.windowSec() : WINDOW_SEC;
    const start = Math.floor(ms / 1000 / size) * size;
    // A window that has already begun would push at once, before the real time: skip it.
    if (start * 1000 <= nowMs || start > nowMs / 1000 + MAX_AHEAD_SEC) return 0;
    return start;
  }

  function storedWindow(content) {
    const entry = firstEntry(content);
    return entry && ID_RE.test(String(entry.rid)) && Number.isInteger(entry.window_start)
      ? { id: entry.rid, window_start: entry.window_start } : null;
  }

  function withWindow(content, win) {
    const entry = { ...(firstEntry(content) || {}) };
    delete entry.rid;
    delete entry.window_start;
    if (win) {
      entry.rid = win.id;
      entry.window_start = win.window_start;
    }
    return { ...content, reminders: [entry, ...content.reminders.slice(1)] };
  }

  let chain = Promise.resolve();

  async function syncNow(uuid) {
    const S = global.NotesStore;
    const TR = taskReminders();
    const note = S && typeof S.get === 'function' ? S.get(uuid) : null;
    if (!note || !TR) return;
    const previous = storedWindow(note.content);
    const wanted = entitled() ? plannedWindow(note.content, Date.now()) : 0;
    if (!wanted && !previous) return;
    if (previous && previous.window_start === wanted) return;
    let next = null;
    let failure = null;
    if (previous) {
      try {
        await TR.withdraw([previous.id]);
      } catch (err) {
        failure = err; // queued for retry; the note stops listing the id
      }
    }
    if (wanted) {
      const endpoint = await TR.deviceEndpoint();
      if (!endpoint) {
        failure = failure || Object.assign(new Error('push is not turned on for this device'), { code: 'no_device' });
      } else {
        const added = { id: TR.randomId(), window_start: wanted };
        try {
          await S.api('/api/push-windows', {
            method: 'POST',
            body: JSON.stringify({ endpoint, windows: [added], ...TR.windowSecField([added]) }),
          });
          next = added;
        } catch (err) {
          failure = failure || err;
        }
      }
    }
    const live = S.get(uuid);
    if (live && firstEntry(live.content)) S.upsert(uuid, withWindow(live.content, next));
    if (failure) throw failure;
  }

  /** Bring the server window of one note in line with the note as stored (safe to call repeatedly). */
  function syncNoteReminders(uuid) {
    const run = chain.then(() => syncNow(uuid));
    chain = run.catch(() => {});
    return run;
  }

  /** Withdraw the window of a note that is being deleted, trashed or whose reminder is cleared. */
  function cancelNoteReminders(content) {
    const TR = taskReminders();
    const stored = storedWindow(content);
    if (!stored || !TR) return Promise.resolve();
    const run = chain.then(() => TR.withdraw([stored.id]));
    chain = run.catch(() => {});
    return run;
  }

  /**
   * The note to open when a closed-app reminder notification is opened: among notes with a pushed
   * reminder whose window has begun (and is not older than the server's lateness limit), the latest.
   */
  function findDueNote(notes, nowMs) {
    let best = null;
    for (const n of notes || []) {
      const stored = n && !n.deleted && n.content && !n.content.trashed ? storedWindow(n.content) : null;
      if (!stored) continue;
      const age = nowMs / 1000 - stored.window_start;
      if (age < 0 || age > MAX_LATE_SEC) continue;
      if (!best || stored.window_start > best.start) best = { uuid: n.uuid, start: stored.window_start };
    }
    return best ? best.uuid : '';
  }

  /** A delivered window is spent on the server; forget its id here so the same notification opens once. */
  function markDelivered(uuid) {
    const S = global.NotesStore;
    const note = S && S.get(uuid);
    if (note && storedWindow(note.content)) S.upsert(uuid, withWindow(note.content, null));
  }

  global.NotesNoteReminders = {
    WINDOW_SEC,
    plannedWindow,
    syncNoteReminders,
    cancelNoteReminders,
    findDueNote,
    markDelivered,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.NotesNoteReminders;
}(typeof window !== 'undefined' ? window : globalThis));
