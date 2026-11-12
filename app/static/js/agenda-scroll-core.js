/**
 * Pure time-grid scroll helpers for Agenda (no DOM / no search state).
 * Loaded before agenda.js; exposed as NotesAgendaScroll for tests and runtime.
 */
(function (global) {
  const DEFAULT_PX_PER_HOUR = 52;
  const DEFAULT_DAY_START_HOUR = 8;
  const SCROLL_TOP_INSET_PX = 72;

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function addDays(d, n) {
    return new Date(
      d.getFullYear(), d.getMonth(), d.getDate() + n,
      d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(),
    );
  }

  /** Schedule identity for scroll persistence: visible occurrences in period (not search-filtered). */
  function scheduleFingerprint(occ, rangeStart, rangeEnd) {
    const parts = [];
    for (const o of occ || []) {
      if (!o || !o.ev) continue;
      if (o.end <= rangeStart || o.start >= rangeEnd) continue;
      const id = String(o.ev.id || '');
      parts.push(`${id}|${o.start.getTime()}|${o.end.getTime()}|${!!o.ev.all_day}`);
    }
    parts.sort();
    return parts.join(';');
  }

  function earliestVisibleMinutesInPeriod(occ, days, rangeStart, rangeEnd) {
    let minMin = null;
    for (const d of days || []) {
      const ds = startOfDay(d);
      const de = addDays(ds, 1);
      if (de <= rangeStart || ds >= rangeEnd) continue;
      for (const o of occ || []) {
        if (!o || !o.ev || o.ev.all_day) continue;
        if (o.end <= ds || o.start >= de) continue;
        const a = o.start < ds ? ds : o.start;
        const b = o.end > de ? de : o.end;
        if (b <= a) continue;
        const mins = (a - ds) / 60000;
        if (minMin === null || mins < minMin) minMin = mins;
      }
    }
    return minMin;
  }

  /** Minutes anchor for today in view: first timed event today, else current clock time. */
  function todayAnchorMinutes(occ, days, now) {
    const ref = now instanceof Date ? now : new Date();
    const td = startOfDay(ref);
    const t0 = td.getTime();
    const inView = (days || []).some((d) => startOfDay(d).getTime() === t0);
    if (!inView) return null;
    const dayEnd = addDays(td, 1);
    let first = null;
    for (const o of occ || []) {
      if (!o || !o.ev || o.ev.all_day) continue;
      if (o.end <= td || o.start >= dayEnd) continue;
      const a = o.start < td ? td : o.start;
      const mins = (a - td) / 60000;
      if (first === null || mins < first) first = mins;
    }
    if (first !== null) return first;
    const nowMin = (ref - td) / 60000;
    return Math.max(0, Math.min(nowMin, 23 * 60 + 59));
  }

  /** Place anchor (today or earliest event) near the top of the viewport, else default morning band. */
  function preferredTimeGridScrollTop(occ, range, opts) {
    const pxPerHour = (opts && opts.pxPerHour) || DEFAULT_PX_PER_HOUR;
    const defaultDayStartHour = (opts && opts.defaultDayStartHour) || DEFAULT_DAY_START_HOUR;
    const viewportHeight = Number(opts && opts.viewportHeight) || 0;
    const inset = Number(opts && opts.topInsetPx) || SCROLL_TOP_INSET_PX;
    const now = (opts && opts.now instanceof Date) ? opts.now : new Date();
    const todayMin = todayAnchorMinutes(occ, range && range.days, now);
    let minMin = todayMin;
    if (minMin === null) {
      minMin = earliestVisibleMinutesInPeriod(
        occ,
        range && range.days,
        range && range.start,
        range && range.end,
      );
    }
    if (minMin === null) return defaultDayStartHour * pxPerHour;
    const eventTopPx = (minMin / 60) * pxPerHour;
    return Math.max(0, eventTopPx - inset);
  }

  function clampTimeGridScrollTop(top, scrollHeight, clientHeight) {
    const max = Math.max(0, Number(scrollHeight) - Number(clientHeight));
    const n = Number(top);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(n, max));
  }

  /** Defer scroll placement until grid has measurable layout (avoids clamping to 0). */
  function isTimeGridLayoutReady(scrollHeight, clientHeight) {
    const ch = Number(clientHeight) || 0;
    const sh = Number(scrollHeight) || 0;
    return ch > 0 && sh > ch;
  }

  /**
   * Choose scrollTop for time grid: honor saved position when schedule fingerprint matches.
   * @param {object} p
   * @param {string} p.currentFingerprint — from unfiltered schedule (search must not affect)
   * @param {string|null} p.storedFingerprint
   * @param {number|null} p.storedScrollTop
   * @param {Array} p.displayOcc — search-filtered occurrences (for preferred top when schedule changes)
   * @param {object} p.range
   * @param {object} [p.opts]
   */
  function pickTimeGridScrollTop(p) {
    const {
      currentFingerprint,
      storedFingerprint,
      storedScrollTop,
      displayOcc,
      range,
      opts,
    } = p || {};
    const fpOk = (s) => s != null && s !== '';
    let top = null;
    if (
      fpOk(storedFingerprint)
      && fpOk(currentFingerprint)
      && storedFingerprint === currentFingerprint
      && storedScrollTop != null
      && storedScrollTop !== ''
    ) {
      const n = Number(storedScrollTop);
      if (Number.isFinite(n)) top = n;
    }
    if (top === null) top = preferredTimeGridScrollTop(displayOcc, range, opts);
    return top;
  }

  /** Pixel offset of the "now" line inside a day column (hours * px per hour). */
  function nowLineTop(now, pxPerHour) {
    const d = now instanceof Date ? now : new Date(now);
    const start = startOfDay(d);
    return ((d.getTime() - start.getTime()) / 3600000) * pxPerHour;
  }

  /**
   * Once-a-minute clock for the Agenda. Calls onMinute() every minute and onNewDay() instead
   * when the calendar day changed since the last tick. Pauses while the page is hidden and
   * catches up (one tick) when it becomes visible again.
   *
   * deps: { now(): Date, setInterval, clearInterval, isVisible(): boolean }
   */
  function createMinuteClock({ onMinute, onNewDay }, deps) {
    const d = deps || {};
    const nowFn = d.now || (() => new Date());
    const setIv = d.setInterval || global.setInterval.bind(global);
    const clearIv = d.clearInterval || global.clearInterval.bind(global);
    const isVisible = d.isVisible || (() => true);
    let handle = null;
    let lastDay = startOfDay(nowFn()).getTime();

    function tick() {
      if (!isVisible()) return;
      const day = startOfDay(nowFn()).getTime();
      if (day !== lastDay) {
        lastDay = day;
        if (onNewDay) onNewDay(nowFn());
        return;
      }
      if (onMinute) onMinute(nowFn());
    }

    return {
      start() {
        if (handle !== null) return;
        lastDay = startOfDay(nowFn()).getTime();
        handle = setIv(tick, 60000);
      },
      stop() {
        if (handle === null) return;
        clearIv(handle);
        handle = null;
      },
      tick,
      get running() { return handle !== null; },
    };
  }

  /**
   * Stable text signature of a form: [{ key, type, value, checked }] -> string.
   * Buttons and file inputs are ignored; radios and checkboxes count by checked state.
   */
  function formSignature(controls) {
    const parts = [];
    for (const c of controls || []) {
      if (!c || !c.key) continue;
      const type = String(c.type || '').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'file') continue;
      if (type === 'checkbox' || type === 'radio') {
        if (type === 'radio' && !c.checked) continue;
        parts.push(`${c.key}=${c.checked ? '1' : '0'}${type === 'radio' ? `:${c.value}` : ''}`);
      } else {
        parts.push(`${c.key}=${String(c.value == null ? '' : c.value)}`);
      }
    }
    return parts.join('\u0001');
  }

  /** True when closing the editor would lose edits (snapshot taken when it opened). */
  function editorHasUnsavedChanges(snapshot, current) {
    if (snapshot == null) return false;
    return snapshot !== current;
  }

  /**
   * Maps a keydown to an Agenda action, or '' when the key is not ours.
   * ctx: { paneVisible, blocked } - blocked = a dialog, editor or text field has the keyboard.
   * ev:  { key, ctrlKey, metaKey, altKey, isComposing, target: { tagName, isContentEditable } }
   */
  function agendaShortcutAction(ev, ctx) {
    if (!ev || !ctx || !ctx.paneVisible || ctx.blocked) return '';
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return '';
    const tag = String((ev.target && ev.target.tagName) || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ev.target && ev.target.isContentEditable)) return '';
    switch (ev.key) {
      case 't': case 'T': return 'today';
      case 'ArrowLeft': return 'prev';
      case 'ArrowRight': return 'next';
      case 'n': case 'N': return 'new';
      case 'd': case 'D': return 'view:day';
      case '3': return 'view:3day';
      case 'w': case 'W': return 'view:week';
      case 'm': case 'M': return 'view:month';
      case 'l': case 'L': return 'view:agenda';
      case 'g': case 'G': return 'goto';
      case '/': return 'search';
      case '?': return 'help';
      default: return '';
    }
  }

  global.NotesAgendaScroll = {
    nowLineTop,
    createMinuteClock,
    formSignature,
    editorHasUnsavedChanges,
    agendaShortcutAction,
    todayAnchorMinutes,
    scheduleFingerprint,
    earliestVisibleMinutesInPeriod,
    preferredTimeGridScrollTop,
    clampTimeGridScrollTop,
    isTimeGridLayoutReady,
    pickTimeGridScrollTop,
    startOfDay,
    addDays,
  };
}(typeof window !== 'undefined' ? window : globalThis));
