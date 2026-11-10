/**
 * ICS (iCalendar) parser for on-device import: VEVENT, RRULE string preservation,
 * VALARM/VTIMEZONE blocks skipped. No network. https URLs only for join hints.
 */
(function (global) {
  function unfoldLines(raw) {
    const lines = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      let line = lines[i];
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
        i += 1;
        line += lines[i].slice(1);
      }
      out.push(line);
    }
    return out;
  }

  function unescapeText(s) {
    return String(s || '')
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  function parseLine(line) {
    const idx = line.indexOf(':');
    if (idx < 0) return { name: '', params: {}, value: '' };
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const semi = left.indexOf(';');
    if (semi < 0) return { name: left.toUpperCase(), params: {}, value };
    const name = left.slice(0, semi).toUpperCase();
    const params = {};
    left.slice(semi + 1).split(';').forEach((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return;
      params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
    });
    return { name, params, value };
  }

  function parseIcsDate(val) {
    const s = String(val || '').trim();
    if (!s) return null;
    const upper = s.toUpperCase();
    if (/^\d{8}$/.test(s)) {
      const y = Number(s.slice(0, 4));
      const m = Number(s.slice(4, 6)) - 1;
      const d = Number(s.slice(6, 8));
      /** Plain DATE: calendar day in local timezone (matches export formatLocalDateValue). */
      return { date: new Date(y, m, d), allDay: true };
    }
    if (/^\d{8}T\d{6}Z$/.test(upper)) {
      const y = Number(s.slice(0, 4));
      const mo = Number(s.slice(4, 6)) - 1;
      const d = Number(s.slice(6, 8));
      const h = Number(s.slice(9, 11));
      const mi = Number(s.slice(11, 13));
      const se = Number(s.slice(13, 15));
      return { date: new Date(Date.UTC(y, mo, d, h, mi, se)), allDay: false };
    }
    if (/^\d{8}T\d{6}$/.test(s)) {
      const y = Number(s.slice(0, 4));
      const mo = Number(s.slice(4, 6)) - 1;
      const d = Number(s.slice(6, 8));
      const h = Number(s.slice(9, 11));
      const mi = Number(s.slice(11, 13));
      const se = Number(s.slice(13, 15));
      return { date: new Date(y, mo, d, h, mi, se), allDay: false };
    }
    return null;
  }

  function sanitizeHttpsUrl(u) {
    const t = String(u || '').trim();
    if (!/^https:\/\//i.test(t)) return '';
    try {
      const url = new URL(t);
      return url.protocol === 'https:' ? url.href : '';
    } catch (e) {
      return '';
    }
  }

  function extractHttpsFromText(text) {
    const re = /https:\/\/[^\s<>()"']+/gi;
    const m = String(text || '').match(re);
    if (!m || !m.length) return '';
    for (let i = 0; i < m.length; i += 1) {
      const ok = sanitizeHttpsUrl(m[i].replace(/[),.;]+$/g, ''));
      if (ok) return ok;
    }
    return '';
  }

  /** RFC 5545 TEXT escaping for SUMMARY, LOCATION, DESCRIPTION. */
  function escapeIcsText(s) {
    return String(s || '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n/g, '\\n')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\n');
  }

  /**
   * Fold long lines (RFC 5545: max 75 octets per logical line; continuation starts with SP/HTAB).
   * Uses UTF-8 byte length and never splits inside a Unicode scalar value (emoji, combining marks).
   */
  function foldIcsLine(line) {
    const raw = String(line || '');
    const enc = new TextEncoder();
    const parts = [];
    let pos = 0;
    let firstLineMax = 75;
    while (pos < raw.length) {
      let chunk = '';
      let oct = 0;
      const limit = firstLineMax;
      firstLineMax = 74;
      while (pos < raw.length) {
        const cp = raw.codePointAt(pos);
        const w = cp > 0xffff ? 2 : 1;
        const ch = raw.slice(pos, pos + w);
        const nextOct = enc.encode(ch).length;
        if (oct + nextOct > limit) break;
        chunk += ch;
        oct += nextOct;
        pos += w;
      }
      if (!chunk && pos < raw.length) {
        const cp = raw.codePointAt(pos);
        const w = cp > 0xffff ? 2 : 1;
        chunk = raw.slice(pos, pos + w);
        pos += w;
      }
      parts.push(parts.length ? ` ${chunk}` : chunk);
    }
    return parts.join('\r\n');
  }

  function pad4(n) {
    return String(n).padStart(4, '0');
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Local floating date-time YYYYMMDDTHHmmss (no TZ suffix). */
  function formatLocalDateTime(d) {
    const x = new Date(d);
    return (
      `${pad4(x.getFullYear())}${pad2(x.getMonth() + 1)}${pad2(x.getDate())}`
      + `T${pad2(x.getHours())}${pad2(x.getMinutes())}${pad2(x.getSeconds())}`
    );
  }

  /** All-day DATE value YYYYMMDD (local calendar). */
  function formatLocalDateValue(d) {
    const x = new Date(d);
    return `${pad4(x.getFullYear())}${pad2(x.getMonth() + 1)}${pad2(x.getDate())}`;
  }

  /** DTSTAMP in UTC form ending with Z. */
  function formatUtcStamp(d) {
    const x = new Date(d);
    return (
      `${pad4(x.getUTCFullYear())}${pad2(x.getUTCMonth() + 1)}${pad2(x.getUTCDate())}`
      + `T${pad2(x.getUTCHours())}${pad2(x.getUTCMinutes())}${pad2(x.getUTCSeconds())}Z`
    );
  }

  /** DATE-TIME in UTC (Zulu) for timed events — preserves absolute instant across timezones. */
  function formatUtcDateTime(d) {
    const x = new Date(d);
    return (
      `${pad4(x.getUTCFullYear())}${pad2(x.getUTCMonth() + 1)}${pad2(x.getUTCDate())}`
      + `T${pad2(x.getUTCHours())}${pad2(x.getUTCMinutes())}${pad2(x.getUTCSeconds())}Z`
    );
  }

  /**
   * Build a VCALENDAR string from vault agenda rows (client-only, no network).
   * @param {Array<{ id?: string, title?: string, location?: string, notes?: string,
   *   start?: string, end?: string, all_day?: boolean, rrule?: string,
   *   webcall_url?: string, attendees?: string[], ical_uid?: string }>} rows
   */
  function buildIcsCalendarFromEvents(rows) {
    const now = new Date();
    const dtstamp = formatUtcStamp(now);
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Deeperguard//Agenda Export//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];
    for (const ev of rows || []) {
      const startIso = ev.start;
      const endIso = ev.end;
      if (!startIso || !endIso) continue;
      const ds = new Date(startIso);
      const de = new Date(endIso);
      if (!Number.isFinite(ds.getTime()) || !Number.isFinite(de.getTime())) continue;
      const uidRaw = String(ev.ical_uid || ev.id || '').trim();
      const uid = uidRaw || `deeperguard-${(ev.id || Math.random().toString(36).slice(2))}@local`;
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${escapeIcsText(uid)}`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`SUMMARY:${escapeIcsText(ev.title || 'Untitled')}`);
      if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
      let notes = String(ev.notes || '');
      if (Array.isArray(ev.attendees) && ev.attendees.length) {
        const att = ev.attendees.map((a) => String(a || '').trim()).filter(Boolean).join(', ');
        /** Real newline before escape — escapeIcsText turns newlines into \\n in ICS TEXT. */
        if (att) notes = notes ? `${notes}\nAttendees: ${att}` : `Attendees: ${att}`;
      }
      if (notes) lines.push(`DESCRIPTION:${escapeIcsText(notes)}`);
      const wc = sanitizeHttpsUrl(ev.webcall_url || '');
      if (wc) lines.push(`URL:${wc}`);
      if (ev.all_day) {
        let endExclusive = new Date(de.getTime());
        const dStart = formatLocalDateValue(ds);
        const dEndProbe = formatLocalDateValue(endExclusive);
        if (!Number.isFinite(Number(dEndProbe)) || Number(dEndProbe) <= Number(dStart)) {
          endExclusive = new Date(ds.getTime() + 86400000);
        }
        const dEnd = formatLocalDateValue(endExclusive);
        lines.push(`DTSTART;VALUE=DATE:${dStart}`);
        lines.push(`DTEND;VALUE=DATE:${dEnd}`);
      } else {
        lines.push(`DTSTART:${formatUtcDateTime(ds)}`);
        lines.push(`DTEND:${formatUtcDateTime(de)}`);
      }
      const rrule = String(ev.rrule || '').trim();
      if (rrule) lines.push(`RRULE:${rrule.replace(/\s+/g, '')}`);
      const exdates = Array.isArray(ev.ics_exdates) ? ev.ics_exdates : [];
      exdates.forEach((x) => {
        const ex = String(x || '').trim().replace(/\s+/g, '');
        if (ex) lines.push(`EXDATE:${ex}`);
      });
      const rid = String(ev.ics_recurrence_id || '').trim();
      if (rid) lines.push(`RECURRENCE-ID:${rid.replace(/\s+/g, '')}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return `${lines.map((ln) => foldIcsLine(ln)).join('\r\n')}\r\n`;
  }

  function parseIcsFile(text) {
    const warnings = [];
    const blocks = [];
    let cur = null;
    for (const line of unfoldLines(text)) {
      const u = line.toUpperCase();
      if (u === 'BEGIN:VEVENT') {
        cur = { props: [] };
        blocks.push(cur);
      } else if (u === 'END:VEVENT') {
        cur = null;
      } else if (cur) {
        cur.props.push(parseLine(line));
      }
    }
    const events = [];
    for (const block of blocks) {
      const map = new Map();
      for (const p of block.props) {
        if (!p.name) continue;
        if (!map.has(p.name)) map.set(p.name, []);
        map.get(p.name).push(p);
      }
      const uid = String(((map.get('UID') || [])[0] || {}).value || '').trim();
      const summary = unescapeText(((map.get('SUMMARY') || [])[0] || {}).value || 'Untitled');
      const loc = unescapeText(((map.get('LOCATION') || [])[0] || {}).value || '');
      const desc = unescapeText(((map.get('DESCRIPTION') || [])[0] || {}).value || '');
      const dtStart = (map.get('DTSTART') || [])[0];
      const dtEnd = (map.get('DTEND') || [])[0];
      if (!dtStart) {
        warnings.push('Skipped VEVENT without DTSTART');
        continue;
      }
      const dts = parseIcsDate(dtStart.value);
      if (!dts) {
        warnings.push('Skipped VEVENT with bad DTSTART');
        continue;
      }
      let endDate = null;
      let allDay = dts.allDay;
      if (dtEnd) {
        const dte = parseIcsDate(dtEnd.value);
        if (dte) {
          endDate = dte.date;
          allDay = allDay || dte.allDay;
        }
      }
      if (!endDate && allDay) {
        endDate = new Date(dts.date.getTime() + 86400000);
      }
      if (!endDate) {
        endDate = new Date(dts.date.getTime() + 3600000);
      }
      const rruleRow = (map.get('RRULE') || [])[0];
      const exdateRows = map.get('EXDATE') || [];
      const icsExdates = exdateRows
        .map((r) => String(r.value || '').trim().replace(/\s+/g, ''))
        .filter(Boolean);
      const ridRow = (map.get('RECURRENCE-ID') || [])[0];
      const icsRecurrenceId = ridRow ? String(ridRow.value || '').trim() : '';
      const urlRow = (map.get('URL') || [])[0];
      let webcall = urlRow ? sanitizeHttpsUrl(urlRow.value) : '';
      if (!webcall) webcall = extractHttpsFromText(desc) || extractHttpsFromText(loc);
      const attendeeLines = map.get('ATTENDEE') || [];
      const attendees = attendeeLines.map((r) => unescapeText(r.value)).filter(Boolean);
      const icalUid = uid || `local-${Date.now()}-${events.length}`;
      events.push({
        ical_uid: icalUid,
        title: summary || 'Untitled',
        location: loc,
        notes: desc,
        attendees,
        webcall_url: webcall,
        start: dts.date.toISOString(),
        end: endDate.toISOString(),
        all_day: allDay,
        rrule: rruleRow ? String(rruleRow.value || '').trim() : '',
        ics_exdates: icsExdates,
        ics_recurrence_id: icsRecurrenceId,
        source_tz: String((dtStart.params && dtStart.params.TZID) || ''),
      });
    }
    return { events, warnings };
  }

  global.NotesAgendaIcs = {
    parseIcsFile,
    sanitizeHttpsUrl,
    extractHttpsFromText,
    escapeIcsText,
    foldIcsLine,
    buildIcsCalendarFromEvents,
    formatUtcDateTime,
  };
}(typeof window !== 'undefined' ? window : globalThis));
