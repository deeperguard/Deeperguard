/**
 * Pure time-grid scroll helpers for Agenda (no DOM / no search state).
 * Loaded before agenda.js; exposed as NotesAgendaScroll for tests and runtime.
 */
(function (global) {
  const DEFAULT_PX_PER_HOUR = 52;
  const DEFAULT_DAY_START_HOUR = 8;

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

  /** Place earliest timed event at vertical center of viewport (px), else default morning band. */
  function preferredTimeGridScrollTop(occ, range, opts) {
    const pxPerHour = (opts && opts.pxPerHour) || DEFAULT_PX_PER_HOUR;
    const defaultDayStartHour = (opts && opts.defaultDayStartHour) || DEFAULT_DAY_START_HOUR;
    const viewportHeight = Number(opts && opts.viewportHeight) || 0;
    const minMin = earliestVisibleMinutesInPeriod(
      occ,
      range && range.days,
      range && range.start,
      range && range.end,
    );
    if (minMin === null) return defaultDayStartHour * pxPerHour;
    const eventTopPx = (minMin / 60) * pxPerHour;
    if (viewportHeight > 0) {
      return Math.max(0, eventTopPx - viewportHeight / 2);
    }
    return Math.max(0, eventTopPx);
  }

  function clampTimeGridScrollTop(top, scrollHeight, clientHeight) {
    const max = Math.max(0, Number(scrollHeight) - Number(clientHeight));
    const n = Number(top);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(n, max));
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
    let top = null;
    if (
      storedFingerprint != null
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
    scheduleFingerprint,
    earliestVisibleMinutesInPeriod,
    preferredTimeGridScrollTop,
    clampTimeGridScrollTop,
    pickTimeGridScrollTop,
    startOfDay,
    addDays,
  };
}(typeof window !== 'undefined' ? window : globalThis));
