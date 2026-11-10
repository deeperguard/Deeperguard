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

  function masterDurationMs(masterStart, masterEnd) {
    const a = new Date(masterStart);
    const b = new Date(masterEnd);
    if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime())) return 3600000;
    const d = b.getTime() - a.getTime();
    return d > 0 ? d : 3600000;
  }

  /** True when override times still match the series slot identified by rid (title-only edit). */
  function overrideKeepsSeriesSlotTime(ov, rid, masterStart, masterEnd, seriesAllDay) {
    if (!ov || !rid) return true;
    const slot = parseRecurrenceId(rid, seriesAllDay);
    if (!slot || !Number.isFinite(slot.getTime())) return true;
    const os = ov.start ? new Date(ov.start) : slot;
    if (!Number.isFinite(os.getTime())) return true;
    const duration = masterDurationMs(masterStart, masterEnd);
    const oe = ov.end ? new Date(ov.end) : new Date(os.getTime() + duration);
    if (!Number.isFinite(oe.getTime())) return true;
    if (seriesAllDay) {
      return startOfDay(os).getTime() === startOfDay(slot).getTime()
        && Math.abs(oe.getTime() - os.getTime() - duration) < 1000;
    }
    return Math.abs(os.getTime() - slot.getTime()) < 1000
      && Math.abs(oe.getTime() - (slot.getTime() + duration)) < 1000;
  }

  function shiftRecurrenceToken(token, deltaMs, oldAllDay, newAllDay) {
    const t = String(token || '').trim();
    if (!t || !Number.isFinite(deltaMs) || deltaMs === 0) return t;
    const inst = parseRecurrenceId(t, oldAllDay);
    if (!inst || !Number.isFinite(inst.getTime())) return t;
    const shifted = new Date(inst.getTime() + deltaMs);
    return recurrenceIdForStart(shifted, newAllDay);
  }

  function overrideFieldMatchesMaster(ov, field, master) {
    if (!ov || !master) return true;
    if (field === 'title') {
      const o = String(ov.title || '').trim();
      const m = String(master.title || '').trim() || 'Untitled';
      return !o || o === m;
    }
    if (field === 'location') {
      return ov.location == null || String(ov.location) === String(master.location || '');
    }
    if (field === 'notes') {
      return ov.notes == null || String(ov.notes) === String(master.notes || '');
    }
    return true;
  }

  function overrideIsCustomized(ov, rid, master) {
    if (!ov || ov.cancelled) return false;
    if (!overrideFieldMatchesMaster(ov, 'title', master)) return true;
    if (!overrideFieldMatchesMaster(ov, 'location', master)) return true;
    if (!overrideFieldMatchesMaster(ov, 'notes', master)) return true;
    return !overrideKeepsSeriesSlotTime(ov, rid, master.start, master.end, !!master.all_day);
  }

  function countCustomizedOverrides(overrides, master) {
    let n = 0;
    for (const [rid, ov] of Object.entries(overrides || {})) {
      if (overrideIsCustomized(ov, rid, master)) n += 1;
    }
    return n;
  }

  function seriesOverrideResetMessage(count) {
    const n = Math.max(0, Number(count) || 0);
    if (n === 0) return '';
    if (n === 1) return '1 customized occurrence will be reset to the series';
    return `${n} customized occurrences will be reset to the series`;
  }

  function mergeOverrideSeriesFields(patch, ov, base, next) {
    const masterTitle = String(next.title != null ? next.title : base.title || '').trim() || 'Untitled';
    const masterLoc = next.location != null ? next.location : base.location;
    const masterNotes = next.notes != null ? next.notes : base.notes;
    patch.title = overrideFieldMatchesMaster(ov, 'title', base)
      ? masterTitle
      : (String(ov.title || '').trim() || masterTitle);
    patch.location = overrideFieldMatchesMaster(ov, 'location', base)
      ? masterLoc
      : ov.location;
    patch.notes = overrideFieldMatchesMaster(ov, 'notes', base)
      ? masterNotes
      : ov.notes;
    return patch;
  }

  /**
   * Re-key occurrence overrides and EXDATEs when the recurring master start/end shifts.
   * Per-occurrence field overrides are preserved; non-time-overridden slots move with the series delta.
   */
  function preserveOverridesOnSeriesEdit(prev, next) {
    const base = prev && typeof prev === 'object' ? prev : {};
    const oldAllDay = !!base.all_day;
    const newAllDay = typeof next.all_day === 'boolean' ? next.all_day : oldAllDay;
    const oldStartMs = new Date(base.start).getTime();
    const newStartMs = new Date(next.start).getTime();
    const deltaMs = (Number.isFinite(oldStartMs) && Number.isFinite(newStartMs))
      ? newStartMs - oldStartMs
      : 0;
    const oldOverrides = (base.ics_occurrence_overrides && typeof base.ics_occurrence_overrides === 'object')
      ? base.ics_occurrence_overrides
      : {};
    if (oldAllDay !== newAllDay) {
      return {
        ics_exdates: normalizeExdates(base.ics_exdates),
        ics_occurrence_overrides: {},
        resetCount: countCustomizedOverrides(oldOverrides, base),
      };
    }
    if (deltaMs === 0) {
      const overrides = {};
      for (const [rid, ov] of Object.entries(oldOverrides)) {
        if (!ov || typeof ov !== 'object') continue;
        overrides[rid] = mergeOverrideSeriesFields({ ...ov }, ov, base, next);
      }
      return {
        ics_exdates: normalizeExdates(base.ics_exdates),
        ics_occurrence_overrides: overrides,
        resetCount: 0,
      };
    }
    const duration = masterDurationMs(base.start, base.end);
    const exdates = normalizeExdates(base.ics_exdates).map((ex) => {
      const ov = oldOverrides[ex];
      if (ov && !overrideKeepsSeriesSlotTime(ov, ex, base.start, base.end, oldAllDay)) return ex;
      return shiftRecurrenceToken(ex, deltaMs, oldAllDay, newAllDay);
    });
    const overrides = {};
    for (const [oldRid, ov] of Object.entries(oldOverrides)) {
      if (!ov || typeof ov !== 'object') continue;
      const keepsSlot = overrideKeepsSeriesSlotTime(
        ov, oldRid, base.start, base.end, oldAllDay,
      );
      let newRid = oldRid;
      let patch = { ...ov };
      if (keepsSlot) {
        newRid = shiftRecurrenceToken(oldRid, deltaMs, oldAllDay, newAllDay);
        if (patch.start) {
          const os = new Date(patch.start);
          if (Number.isFinite(os.getTime())) patch.start = new Date(os.getTime() + deltaMs).toISOString();
        }
        if (patch.end) {
          const oe = new Date(patch.end);
          if (Number.isFinite(oe.getTime())) patch.end = new Date(oe.getTime() + deltaMs).toISOString();
        } else if (patch.start) {
          const os = new Date(patch.start);
          if (Number.isFinite(os.getTime())) {
            patch.end = new Date(os.getTime() + duration).toISOString();
          }
        }
      }
      patch = mergeOverrideSeriesFields(patch, ov, base, next);
      if (typeof patch.all_day !== 'boolean') patch.all_day = newAllDay;
      overrides[newRid] = patch;
    }
    return {
      ics_exdates: normalizeExdates(exdates),
      ics_occurrence_overrides: overrides,
      resetCount: 0,
    };
  }

  function planPreserveOverridesOnSeriesEdit(prev, next) {
    return preserveOverridesOnSeriesEdit(prev, next);
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
    overrideKeepsSeriesSlotTime,
    overrideIsCustomized,
    countCustomizedOverrides,
    seriesOverrideResetMessage,
    preserveOverridesOnSeriesEdit,
    planPreserveOverridesOnSeriesEdit,
    finalizeOccurrences,
    ensureIcalUid,
  };
}(typeof window !== 'undefined' ? window : globalThis));
