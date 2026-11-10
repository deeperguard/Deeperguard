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
    return new Date(d.getTime() + n * 86400000);
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

  global.NotesAgendaScroll = {
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
