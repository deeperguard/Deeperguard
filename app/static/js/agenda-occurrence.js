/**
 * Weekly/biweekly occurrence identity: EXDATE, RECURRENCE-ID keys, override overlay.
 */
(function (global) {
  const Ics = () => global.NotesAgendaIcs;

  function recurrenceIdForStart(start, allDay) {
    const d = start instanceof Date ? start : new Date(start);
    if (!Number.isFinite(d.getTime())) return '';
    const ICS = Ics();
    if (!ICS) return String(d.getTime());
    if (allDay) return ICS.formatLocalDateValue(d);
    return ICS.formatUtcDateTime(d);
  }

  function parseRecurrenceId(rid, seriesAllDay) {
    const s = String(rid || '').trim().replace(/\s+/g, '');
    if (!s) return null;
    if (/^\d{8}$/.test(s)) {
      const y = Number(s.slice(0, 4));
      const m = Number(s.slice(4, 6)) - 1;
      const d = Number(s.slice(6, 8));
      return new Date(y, m, d);
    }
    if (/^\d{8}T\d{6}Z$/i.test(s)) {
      const y = Number(s.slice(0, 4));
      const mo = Number(s.slice(4, 6)) - 1;
      const day = Number(s.slice(6, 8));
      const h = Number(s.slice(9, 11));
      const mi = Number(s.slice(11, 13));
      const se = Number(s.slice(13, 15));
      return new Date(Date.UTC(y, mo, day, h, mi, se));
    }
    if (seriesAllDay && /^\d{8}T/.test(s)) {
      const y = Number(s.slice(0, 4));
      const mo = Number(s.slice(4, 6)) - 1;
      const day = Number(s.slice(6, 8));
      return startOfDay(new Date(y, mo, day));
    }
    return null;
  }

  function normalizeExdates(list) {
    const out = [];
    const seen = new Set();
    for (const x of list || []) {
      const t = String(x || '').trim().replace(/\s+/g, '');
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  function exdateTokenMatchesInstance(token, instanceStart, seriesAllDay) {
    const rid = recurrenceIdForStart(instanceStart, seriesAllDay);
    const tok = String(token || '').trim().replace(/\s+/g, '');
    if (!tok || !rid) return false;
    if (tok === rid) return true;
    const ICS = Ics();
    if (!ICS) return false;
    const parsed = ICS.parseIcsFile(`BEGIN:VEVENT\nDTSTART:${tok}\nEND:VEVENT`);
    const row = (parsed.events || [])[0];
    if (!row || !row.start) return false;
    const exMs = Date.parse(row.start);
    const instMs = instanceStart instanceof Date ? instanceStart.getTime() : Date.parse(instanceStart);
    if (!Number.isFinite(exMs) || !Number.isFinite(instMs)) return false;
    if (seriesAllDay) {
      return startOfDay(new Date(exMs)).getTime() === startOfDay(new Date(instMs)).getTime();
    }
    return Math.abs(exMs - instMs) < 1000;
  }

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function isExcludedByExdate(instanceStart, exdates, seriesAllDay) {
    for (const ex of exdates || []) {
      if (exdateTokenMatchesInstance(ex, instanceStart, seriesAllDay)) return true;
    }
    return false;
  }

  function supportsOccurrenceEdit(rrule) {
    const R = global.NotesAgendaRecurrence;
    if (!R || typeof R.parseAgendaRrule !== 'function') return false;
    const p = R.parseAgendaRrule(String(rrule || ''));
    return p.kind === 'weekly' || p.kind === 'biweekly';
  }

  function defaultOverridePatch() {
    return {
      title: '',
      location: '',
      notes: '',
      start: '',
      end: '',
      all_day: false,
    };
  }

  /**
   * Apply EXDATE filter, per-occurrence overrides, and synthetic moved instances.
   * @param {Array<{ ev, start, end, recurring: boolean }>} raw
   */
  function finalizeOccurrences(ev, raw, rangeStart, rangeEnd) {
    const exdates = normalizeExdates(ev.ics_exdates);
    const overrides = (ev.ics_occurrence_overrides && typeof ev.ics_occurrence_overrides === 'object')
      ? ev.ics_occurrence_overrides
      : {};
    const seriesAllDay = !!ev.all_day;
    const out = [];
    const overrideKeysRendered = new Set();

    for (const o of raw || []) {
      const seriesStart = o.start;
      if (isExcludedByExdate(seriesStart, exdates, seriesAllDay)) continue;
      const rid = recurrenceIdForStart(seriesStart, seriesAllDay);
      const ov = rid && overrides[rid];
      if (ov && ov.cancelled) continue;
      let start = seriesStart;
      let end = o.end;
      let display = {
        title: ev.title,
        location: ev.location || '',
        notes: ev.notes || '',
        all_day: seriesAllDay,
      };
      if (ov) {
        overrideKeysRendered.add(rid);
        if (ov.title) display.title = ov.title;
        if (ov.location != null) display.location = ov.location;
        if (ov.notes != null) display.notes = ov.notes;
        const os = ov.start ? new Date(ov.start) : null;
        const oe = ov.end ? new Date(ov.end) : null;
        if (os && Number.isFinite(os.getTime())) start = os;
        if (oe && Number.isFinite(oe.getTime())) end = oe;
        if (typeof ov.all_day === 'boolean') display.all_day = ov.all_day;
      }
      if (end <= rangeStart || start >= rangeEnd) continue;
      out.push({
        ev,
        start,
        end,
        recurring: !!o.recurring,
        seriesInstanceStart: seriesStart,
        displayTitle: display.title,
        displayAllDay: display.all_day,
      });
    }

    for (const [rid, ov] of Object.entries(overrides)) {
      if (!ov || ov.cancelled || overrideKeysRendered.has(rid)) continue;
      const seriesStart = parseRecurrenceId(rid, seriesAllDay);
      if (!seriesStart) continue;
      if (!isExcludedByExdate(seriesStart, exdates, seriesAllDay)) continue; /* moved: master slot excluded */
      const os = new Date(ov.start || seriesStart);
      const oe = new Date(ov.end || os.getTime() + (new Date(ev.end) - new Date(ev.start)));
      if (!Number.isFinite(os.getTime()) || !Number.isFinite(oe.getTime())) continue;
      if (oe <= rangeStart || os >= rangeEnd) continue;
      out.push({
        ev,
        start: os,
        end: oe,
        recurring: true,
        seriesInstanceStart: seriesStart,
        displayTitle: ov.title || ev.title,
        displayAllDay: typeof ov.all_day === 'boolean' ? ov.all_day : seriesAllDay,
      });
    }

    out.sort((a, b) => a.start - b.start || a.end - b.end);
    return out;
  }

  function ensureIcalUid(ev, vaultId) {
    const u = String(ev.ical_uid || '').trim();
    if (u) return u;
    const id = String(vaultId || ev.id || '').trim();
    return id ? `deeperguard-${id}@local` : '';
  }

  global.NotesAgendaOccurrence = {
    recurrenceIdForStart,
    parseRecurrenceId,
    normalizeExdates,
    exdateTokenMatchesInstance,
    isExcludedByExdate,
    supportsOccurrenceEdit,
    finalizeOccurrences,
    ensureIcalUid,
  };
}(typeof window !== 'undefined' ? window : globalThis));
