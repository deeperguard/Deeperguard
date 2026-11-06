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
      return { date: new Date(Date.UTC(y, m, d)), allDay: true };
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
        source_tz: String((dtStart.params && dtStart.params.TZID) || ''),
      });
    }
    return { events, warnings };
  }

  global.NotesAgendaIcs = {
    parseIcsFile,
    sanitizeHttpsUrl,
    extractHttpsFromText,
  };
}(typeof window !== 'undefined' ? window : globalThis));
