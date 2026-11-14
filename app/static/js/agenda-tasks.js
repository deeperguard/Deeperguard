/**
 * Dated tasks (`agenda_task` items, docs/REMINDERS_TASKS_SPEC.md §2.2 and §3).
 *
 * Pure helpers: build/normalise the encrypted payload, decide on which agenda day a
 * task shows, and the accessible name. No DOM, no store: agenda.js renders, store.js
 * persists (each task is its own encrypted item).
 */
(function (global) {
  'use strict';

  const TASK_TYPE = 'agenda_task';
  const TASK_VERSION = 1;
  const DONE_VISIBLE_DAYS = 7;
  const DAY_MS = 86400000;
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Local `YYYY-MM-DD` for a Date. */
  function dateKey(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /** Local midnight Date for a valid `YYYY-MM-DD`, else null. */
  function parseDue(due) {
    const m = DATE_RE.exec(String(due || ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
    return d;
  }

  function validTime(t) {
    return TIME_RE.test(String(t || '')) ? String(t) : '';
  }

  function isoOrEmpty(v) {
    const s = String(v || '');
    return s && Number.isFinite(Date.parse(s)) ? s : '';
  }

  /**
   * Build the payload to save from editor fields. Unknown keys of `prev` are kept
   * (additive schema), so a newer client's fields survive an edit here.
   * Returns null when the title or due date is invalid.
   */
  function buildTask(fields, prev, nowIso) {
    const f = fields || {};
    const base = prev && typeof prev === 'object' ? prev : {};
    const now = nowIso || new Date().toISOString();
    const title = String(f.title ?? base.title ?? '').trim();
    const due = String(f.due ?? base.due ?? '').trim();
    if (!title || !parseDue(due)) return null;
    const out = {
      ...base,
      type: TASK_TYPE,
      version: TASK_VERSION,
      title,
      notes: String(f.notes ?? base.notes ?? ''),
      due,
      due_time: validTime(f.due_time ?? base.due_time),
      tz: String(base.tz || ''),
      rrule: String(base.rrule || ''),
      done_at: isoOrEmpty(f.done_at ?? base.done_at),
      note_uuid: String(base.note_uuid || ''),
      reminder: base.reminder ?? null,
      created_at: base.created_at || now,
      updated_at: now,
    };
    delete out.id;
    return out;
  }

  /**
   * Tolerant read of a stored payload (spec §2.3): missing version = 1, a malformed
   * `due` keeps the data but is not placed, a newer version is read-only. Never throws.
   */
  function normalizeTask(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const version = Number.isInteger(r.version) && r.version > 0 ? r.version : 1;
    return {
      ...r,
      id: String(r.id || ''),
      title: String(r.title || '').trim() || 'Untitled task',
      notes: typeof r.notes === 'string' ? r.notes : '',
      due: typeof r.due === 'string' ? r.due : '',
      due_time: validTime(r.due_time),
      done_at: isoOrEmpty(r.done_at),
      version,
      readOnly: version > TASK_VERSION,
      dueValid: !!parseDue(r.due),
    };
  }

  function isDone(task) {
    return !!(task && isoOrEmpty(task.done_at));
  }

  /** Payload with done state set/cleared; keeps every other field. */
  function withDone(task, done, nowIso) {
    const now = nowIso || new Date().toISOString();
    const out = { ...task, done_at: done ? now : '', updated_at: now };
    for (const k of ['id', 'readOnly', 'dueValid']) delete out[k];
    return out;
  }

  /**
   * Which tasks show on which day for [rangeStart, rangeEnd).
   * - A task shows on its due date.
   * - An open task due before today shows once, on today, as overdue (and not on
   *   its past date).
   * - A done task is hidden once done more than 7 days ago, unless showCompleted.
   * Returns [{ task, dayMs, overdue }] sorted by day, overdue first, then time.
   */
  function placeTasks(tasks, rangeStart, rangeEnd, now, opts) {
    const o = opts || {};
    const nowD = now instanceof Date ? now : new Date(now || Date.now());
    const today = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate());
    const rs = rangeStart instanceof Date ? rangeStart.getTime() : Number(rangeStart);
    const re = rangeEnd instanceof Date ? rangeEnd.getTime() : Number(rangeEnd);
    const out = [];
    (tasks || []).forEach((raw) => {
      const task = normalizeTask(raw);
      const due = parseDue(task.due);
      if (!due) return;
      const done = isDone(task);
      if (done && !o.showCompleted) {
        const doneMs = Date.parse(task.done_at);
        if (nowD.getTime() - doneMs > DONE_VISIBLE_DAYS * DAY_MS) return;
      }
      let day = due;
      let overdue = false;
      if (!done && due.getTime() < today.getTime()) {
        day = today;
        overdue = true;
      }
      const ms = day.getTime();
      if (ms < rs || ms >= re) return;
      out.push({ task, dayMs: ms, overdue });
    });
    out.sort((a, b) => (a.dayMs - b.dayMs)
      || (Number(b.overdue) - Number(a.overdue))
      || (a.overdue ? a.task.due.localeCompare(b.task.due) : 0)
      || (a.task.due_time || '').localeCompare(b.task.due_time || '')
      || a.task.title.localeCompare(b.task.title));
    return out;
  }

  function formatDue(task, locale) {
    const d = parseDue(task.due);
    if (!d) return String(task.due || '');
    let s;
    try {
      s = d.toLocaleDateString(locale || undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) {
      s = task.due;
    }
    return task.due_time ? `${s} ${task.due_time}` : s;
  }

  /** "{title}, due {date} {time}" (+ ", overdue"), spec §3 screen reader. */
  function accessibleName(task, overdue, locale) {
    const t = normalizeTask(task);
    let s = `Task: ${t.title}, due ${formatDue(t, locale)}`;
    if (overdue) s += ', overdue';
    if (isDone(t)) s += ', done';
    return s;
  }

  global.NotesAgendaTasks = {
    TASK_TYPE,
    TASK_VERSION,
    DONE_VISIBLE_DAYS,
    dateKey,
    parseDue,
    buildTask,
    normalizeTask,
    isDone,
    withDone,
    placeTasks,
    formatDue,
    accessibleName,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.NotesAgendaTasks;
}(typeof window !== 'undefined' ? window : globalThis));
