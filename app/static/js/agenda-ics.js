/**
 * ICS (iCalendar) parser for on-device import: VEVENT, RRULE string preservation,
 * VALARM/VTIMEZONE blocks skipped. No network; ATTACH, IMAGE, URL-fetch and CONFERENCE are ignored. https URLs only for join hints.
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

  /** Windows zone names (Outlook / Exchange) for the zones invites most often come from. */
  const WINDOWS_ZONES = {
    'w. europe standard time': 'Europe/Berlin',
    'romance standard time': 'Europe/Paris',
    'central europe standard time': 'Europe/Budapest',
    'central european standard time': 'Europe/Warsaw',
    'gmt standard time': 'Europe/London',
    'greenwich standard time': 'Atlantic/Reykjavik',
    'e. europe standard time': 'Europe/Chisinau',
    'fle standard time': 'Europe/Kiev',
    'gtb standard time': 'Europe/Bucharest',
    'russian standard time': 'Europe/Moscow',
    'turkey standard time': 'Europe/Istanbul',
    'israel standard time': 'Asia/Jerusalem',
    'arabian standard time': 'Asia/Dubai',
    'india standard time': 'Asia/Kolkata',
    'china standard time': 'Asia/Shanghai',
    'singapore standard time': 'Asia/Singapore',
    'tokyo standard time': 'Asia/Tokyo',
    'korea standard time': 'Asia/Seoul',
    'aus eastern standard time': 'Australia/Sydney',
    'new zealand standard time': 'Pacific/Auckland',
    'eastern standard time': 'America/New_York',
    'central standard time': 'America/Chicago',
    'mountain standard time': 'America/Denver',
    'us mountain standard time': 'America/Phoenix',
    'pacific standard time': 'America/Los_Angeles',
    'alaskan standard time': 'America/Anchorage',
    'hawaiian standard time': 'Pacific/Honolulu',
    'atlantic standard time': 'America/Halifax',
    'e. south america standard time': 'America/Sao_Paulo',
    'south africa standard time': 'Africa/Johannesburg',
    'utc': 'UTC',
  };

  const zoneFormatters = new Map();

  function zoneFormatter(zone) {
    if (zoneFormatters.has(zone)) return zoneFormatters.get(zone);
    let fmt = null;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (err) {
      fmt = null;
    }
    zoneFormatters.set(zone, fmt);
    return fmt;
  }

  /** IANA zone for an ICS TZID, or '' when it is unknown (then the time is read as local). */
  function resolveTimeZone(tzid) {
    let s = String(tzid || '').trim().replace(/^"+|"+$/g, '');
    if (!s) return '';
    if (s.startsWith('/')) s = s.split('/').filter(Boolean).slice(-2).join('/');
    if (zoneFormatter(s)) return s;
    const win = WINDOWS_ZONES[s.toLowerCase()];
    if (win && zoneFormatter(win)) return win;
    return '';
  }

  /** Offset of `zone` from UTC at instant `ms`, in ms (positive east of Greenwich). */
  function zoneOffsetMs(zone, ms) {
    const fmt = zoneFormatter(zone);
    if (!fmt) return 0;
    const parts = {};
    for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
    );
    return asUtc - Math.floor(ms / 1000) * 1000;
  }

  /** The instant at which the clock in `zone` shows this wall time. Times in a DST gap move forward. */
  function zonedWallTimeToDate(y, mo, d, h, mi, se, zone) {
    const wall = Date.UTC(y, mo, d, h, mi, se);
    const first = wall - zoneOffsetMs(zone, wall);
    const second = wall - zoneOffsetMs(zone, first);
    if (second === first) return new Date(first);
    // Offset changed between the guesses (near a transition): take the one that round-trips,
    // otherwise the later instant (wall time skipped by a spring-forward gap).
    if (second + zoneOffsetMs(zone, second) === wall) return new Date(second);
    return new Date(Math.max(first, second));
  }

  function parseIcsDate(val, tzid) {
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
      const zone = resolveTimeZone(tzid);
      if (zone) return { date: zonedWallTimeToDate(y, mo, d, h, mi, se, zone), allDay: false, zone };
      /** No TZID (floating) or an unknown zone: local wall time. */
      return { date: new Date(y, mo, d, h, mi, se), allDay: false };
    }
    return null;
  }

  /**
   * EXDATE / RECURRENCE-ID values as keys that match occurrences: timed values become UTC
   * (`YYYYMMDDTHHMMSSZ`) so a TZID or floating value still matches; dates stay as they are.
   */
  function normalizeInstanceTokens(row) {
    if (!row) return [];
    const tzid = row.params && row.params.TZID;
    return String(row.value || '')
      .split(',')
      .map((part) => part.trim().replace(/\s+/g, ''))
      .filter(Boolean)
      .map((tok) => {
        if (/^\d{8}$/.test(tok) || /Z$/i.test(tok)) return tok.toUpperCase();
        const parsed = parseIcsDate(tok, tzid);
        return parsed && !parsed.allDay ? formatUtcDateTime(parsed.date) : tok;
      });
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
  function deviceTimeZone() {
    try {
      return resolveTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch (err) {
      return '';
    }
  }

  /** Wall-clock parts of instant `ms` in `zone`. */
  function zoneWallParts(ms, zone) {
    const w = new Date(ms + zoneOffsetMs(zone, ms));
    return {
      y: w.getUTCFullYear(), mo: w.getUTCMonth() + 1, d: w.getUTCDate(),
      h: w.getUTCHours(), mi: w.getUTCMinutes(), se: w.getUTCSeconds(),
    };
  }

  function formatZonedDateTime(ms, zone) {
    const p = zoneWallParts(ms, zone);
    return `${pad4(p.y)}${pad2(p.mo)}${pad2(p.d)}T${pad2(p.h)}${pad2(p.mi)}${pad2(p.se)}`;
  }

  function formatUtcOffset(offsetMs) {
    const sign = offsetMs < 0 ? '-' : '+';
    const mins = Math.round(Math.abs(offsetMs) / 60000);
    return `${sign}${pad2(Math.floor(mins / 60))}${pad2(mins % 60)}`;
  }

  /** Clock changes of `zone` within `year`: [{ at (ms), from, to (offsets in ms) }]. */
  function zoneTransitions(zone, year) {
    const out = [];
    const dayMs = 86400000;
    let t = Date.UTC(year, 0, 1);
    const end = Date.UTC(year + 1, 0, 1);
    let prev = zoneOffsetMs(zone, t);
    while (t < end) {
      const next = t + dayMs;
      const off = zoneOffsetMs(zone, next);
      if (off !== prev) {
        let lo = t;
        let hi = next;
        while (hi - lo > 1000) {
          const mid = Math.floor((lo + hi) / 2);
          if (zoneOffsetMs(zone, mid) === prev) lo = mid; else hi = mid;
        }
        out.push({ at: hi, from: prev, to: off });
        prev = off;
      }
      t = next;
    }
    return out;
  }

  function zoneAbbrev(zone, ms) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms));
      const p = parts.find((x) => x.type === 'timeZoneName');
      return p ? p.value : '';
    } catch (err) {
      return '';
    }
  }

  /** nth (1..4, or -1 = last) `weekday` (0 = Sunday) of month/year as a UTC calendar day number. */
  function nthWeekdayOfMonth(year, month1, weekday, n) {
    if (n > 0) {
      const first = new Date(Date.UTC(year, month1 - 1, 1)).getUTCDay();
      return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    }
    const days = new Date(Date.UTC(year, month1, 0)).getUTCDate();
    const lastDow = new Date(Date.UTC(year, month1 - 1, days)).getUTCDay();
    return days - ((lastDow - weekday + 7) % 7);
  }

  const ICS_WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

  /**
   * VTIMEZONE block for `zone`, with yearly rules derived from the clock changes of `year`
   * (e.g. last Sunday of March / October in Europe). Zones without clock changes get one
   * fixed observance. Returns [] when the zone has an unusual pattern (then TZID alone is used).
   */
  function buildVTimezoneLines(zone, year) {
    const trans = zoneTransitions(zone, year);
    const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
    if (!trans.length) {
      const off = formatUtcOffset(zoneOffsetMs(zone, Date.UTC(year, 0, 1)));
      lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`);
      const nm = zoneAbbrev(zone, Date.UTC(year, 0, 1));
      if (nm) lines.push(`TZNAME:${nm}`);
      lines.push('END:STANDARD', 'END:VTIMEZONE');
      return lines;
    }
    if (trans.length !== 2) return [];
    for (const tr of trans) {
      const wallBefore = new Date(tr.at + tr.from); // local time just before the change
      const month = wallBefore.getUTCMonth() + 1;
      const day = wallBefore.getUTCDate();
      const weekday = wallBefore.getUTCDay();
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const n = day + 7 > days ? -1 : Math.ceil(day / 7);
      const first = nthWeekdayOfMonth(1970, month, weekday, n);
      const hh = pad2(wallBefore.getUTCHours());
      const mm = pad2(wallBefore.getUTCMinutes());
      const kind = tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD';
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:1970${pad2(month)}${pad2(first)}T${hh}${mm}00`,
        `TZOFFSETFROM:${formatUtcOffset(tr.from)}`,
        `TZOFFSETTO:${formatUtcOffset(tr.to)}`,
        `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${n}${ICS_WEEKDAYS[weekday]}`,
      );
      const nm = zoneAbbrev(zone, tr.at + 86400000);
      if (nm) lines.push(`TZNAME:${nm}`);
      lines.push(`END:${kind}`);
    }
    lines.push('END:VTIMEZONE');
    return lines;
  }

  /**
   * opts.timeZone: IANA zone for repeating timed events (default: this device's zone).
   * Repeating events (and edited occurrences of them) are written as local time with TZID,
   * so "every Monday 09:00" stays 09:00 in other calendar apps across clock changes.
   * One-off timed events stay in UTC.
   */
  function buildIcsCalendarFromEvents(rows, opts) {
    const zoneOpt = opts && opts.timeZone != null ? resolveTimeZone(opts.timeZone) : deviceTimeZone();
    const zone = zoneOpt && zoneOpt !== 'UTC' && zoneOpt !== 'Etc/UTC' ? zoneOpt : '';
    let usesZone = false;
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
      const zoneForEvent = !!zone && !ev.all_day
        && !!(String(ev.rrule || '').trim() || String(ev.ics_recurrence_id || '').trim());
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
      if (/^#[0-9a-f]{6}$/i.test(String(ev.color || ''))) lines.push(`X-DEEPERGUARD-COLOR:${String(ev.color).toLowerCase()}`);
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
      } else if (zoneForEvent) {
        usesZone = true;
        lines.push(`DTSTART;TZID=${zone}:${formatZonedDateTime(ds.getTime(), zone)}`);
        lines.push(`DTEND;TZID=${zone}:${formatZonedDateTime(de.getTime(), zone)}`);
      } else {
        lines.push(`DTSTART:${formatUtcDateTime(ds)}`);
        lines.push(`DTEND:${formatUtcDateTime(de)}`);
      }
      const rrule = String(ev.rrule || '').trim();
      if (rrule) lines.push(`RRULE:${rrule.replace(/\s+/g, '')}`);
      // Instance keys are stored in UTC; for TZID events write them in the same zone.
      const instanceLine = (name, raw) => {
        const tok = String(raw || '').trim().replace(/\s+/g, '');
        if (!tok) return '';
        if (zoneForEvent && /^\d{8}T\d{6}Z$/i.test(tok)) {
          const t = Date.UTC(
            Number(tok.slice(0, 4)), Number(tok.slice(4, 6)) - 1, Number(tok.slice(6, 8)),
            Number(tok.slice(9, 11)), Number(tok.slice(11, 13)), Number(tok.slice(13, 15)),
          );
          return `${name};TZID=${zone}:${formatZonedDateTime(t, zone)}`;
        }
        return `${name}:${tok}`;
      };
      const exdates = Array.isArray(ev.ics_exdates) ? ev.ics_exdates : [];
      exdates.forEach((x) => {
        const ln = instanceLine('EXDATE', x);
        if (ln) lines.push(ln);
      });
      const rid = String(ev.ics_recurrence_id || '').trim();
      if (rid) lines.push(instanceLine('RECURRENCE-ID', rid));
      lines.push('END:VEVENT');
    }
    if (usesZone) {
      const tzLines = buildVTimezoneLines(zone, new Date().getFullYear());
      // VTIMEZONE goes before the events (right after the calendar header, 5 lines).
      if (tzLines.length) lines.splice(5, 0, ...tzLines);
    }
    lines.push('END:VCALENDAR');
    return `${lines.map((ln) => foldIcsLine(ln)).join('\r\n')}\r\n`;
  }

  const MAX_ICS_BYTES = 10 * 1024 * 1024;
  const MAX_ICS_EVENTS = 10000;

  /** Throws a user-facing Error when a file is too big or does not look like text/calendar. */
  function validateIcsFile(file) {
    if (!file) throw new Error('No file selected.');
    if (Number(file.size) > MAX_ICS_BYTES) {
      throw new Error('This file is larger than 10 MB and was not imported.');
    }
    const name = String(file.name || '').toLowerCase();
    const type = String(file.type || '').toLowerCase().split(';')[0].trim();
    const okType = !type || type === 'text/calendar' || type === 'text/plain' || type === 'application/ics';
    if (!okType || (name && !/\.(ics|ical|ifb|txt)$/.test(name))) {
      throw new Error('Only .ics calendar text files can be imported.');
    }
  }

  /** True when the text looks binary (NUL bytes or many control/replacement characters). */
  function looksBinary(text) {
    const s = String(text || '').slice(0, 8192);
    if (s.indexOf('\u0000') >= 0) return true;
    let bad = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) bad += 1;
    }
    return s.length > 0 && bad / s.length > 0.02;
  }

  /** Stable (non-crypto) 53-bit string hash, used for events that have no UID. */
  function stableHash(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i += 1) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  function parseIcsFile(text) {
    if (String(text || '').length > MAX_ICS_BYTES) {
      throw new Error('This file is larger than 10 MB and was not imported.');
    }
    if (looksBinary(text)) {
      throw new Error('This file is not a text calendar and was not imported.');
    }
    const warnings = [];
    const blocks = [];
    let cur = null;
    for (const line of unfoldLines(text)) {
      const u = line.toUpperCase();
      if (u === 'BEGIN:VEVENT') {
        if (blocks.length >= MAX_ICS_EVENTS) {
          throw new Error(`This calendar has more than ${MAX_ICS_EVENTS.toLocaleString('en-US')} events and was not imported.`);
        }
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
      const dts = parseIcsDate(dtStart.value, dtStart.params && dtStart.params.TZID);
      if (!dts) {
        warnings.push('Skipped VEVENT with bad DTSTART');
        continue;
      }
      let endDate = null;
      let allDay = dts.allDay;
      if (dtEnd) {
        const dte = parseIcsDate(dtEnd.value, dtEnd.params && dtEnd.params.TZID);
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
      const icsExdates = exdateRows.flatMap((r) => normalizeInstanceTokens(r));
      const ridRow = (map.get('RECURRENCE-ID') || [])[0];
      const icsRecurrenceId = ridRow ? (normalizeInstanceTokens(ridRow)[0] || '') : '';
      const tzidRaw = String((dtStart.params && dtStart.params.TZID) || '');
      if (tzidRaw && !dts.allDay && !dts.zone) {
        warnings.push(`Unknown time zone "${tzidRaw}" for "${summary || 'Untitled'}": times read as local time`);
      }
      const urlRow = (map.get('URL') || [])[0];
      let webcall = urlRow ? sanitizeHttpsUrl(urlRow.value) : '';
      if (!webcall) webcall = extractHttpsFromText(desc) || extractHttpsFromText(loc);
      const attendeeLines = map.get('ATTENDEE') || [];
      const attendees = attendeeLines.map((r) => unescapeText(r.value)).filter(Boolean);
      const colorRaw = String(((map.get('X-DEEPERGUARD-COLOR') || [])[0] || {}).value || '').trim().toLowerCase();
      const color = /^#[0-9a-f]{6}$/.test(colorRaw) ? colorRaw : '';
      const icalUid = uid || `nouid-${stableHash(`${dtStart.value}|${summary}`)}`;
      events.push({
        ical_uid: icalUid,
        title: summary || 'Untitled',
        location: loc,
        notes: desc,
        attendees,
        webcall_url: webcall,
        color,
        start: dts.date.toISOString(),
        end: endDate.toISOString(),
        all_day: allDay,
        rrule: rruleRow ? String(rruleRow.value || '').trim() : '',
        ics_exdates: icsExdates,
        ics_recurrence_id: icsRecurrenceId,
        source_tz: dts.zone || tzidRaw,
      });
    }
    return { events, warnings };
  }

  function importFields(r) {
    return JSON.stringify([
      r.title || '', r.start || '', r.end || '', r.location || '', r.notes || '',
      r.rrule || '', !!r.all_day, (r.ics_exdates || []).slice().sort(),
    ]);
  }

  /** Build key -> comparable signature for stored events (masters plus per-occurrence overrides). */
  function existingImportIndex(existingEvents) {
    const idx = new Map();
    for (const ev of existingEvents || []) {
      const uid = String(ev && ev.ical_uid || '').trim();
      if (!uid) continue;
      idx.set(uid, importFields(ev));
      const ov = ev.ics_occurrence_overrides || {};
      for (const rid of Object.keys(ov)) {
        idx.set(`${uid}|${rid}`, importFields({ ...ov[rid], rrule: '', ics_exdates: [] }));
      }
    }
    return idx;
  }

  /**
   * Compare parsed rows with stored events. Key = ical_uid (+ "|" + ics_recurrence_id for overrides).
   * Pure: returns {new, changed, unchanged}, each a list of the parsed rows.
   */
  function diffImport(existingEvents, parsedEvents) {
    const idx = existingImportIndex(existingEvents);
    const out = { new: [], changed: [], unchanged: [] };
    for (const row of parsedEvents || []) {
      const uid = String(row && row.ical_uid || '').trim();
      const rid = String(row && row.ics_recurrence_id || '').trim();
      const key = rid ? `${uid}|${rid}` : uid;
      if (!idx.has(key)) out.new.push(row);
      else if (idx.get(key) === importFields(rid ? { ...row, rrule: '', ics_exdates: [] } : row)) out.unchanged.push(row);
      else out.changed.push(row);
    }
    return out;
  }

  /** Label such as "work.ics (2026-11-13)"; stored inside the encrypted event data only. */
  function makeSourceLabel(fileName, now) {
    const d = (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
    const name = String(fileName || 'import').replace(/[\u0000-\u001f]/g, '').slice(0, 120);
    return `${name} (${d})`;
  }

  /** Ids of stored events whose source label equals `label` (non-empty). */
  function idsWithSource(existingEvents, label) {
    const l = String(label || '');
    if (!l) return [];
    return (existingEvents || []).filter((e) => e && e.source === l).map((e) => e.id);
  }

  /**
   * Pure: copy of rows with the chosen fields removed before saving.
   * opts: { description, attendees, locations } (true = drop). Dropping the description also
   * drops a join link that was only taken from it; an explicit URL property is kept.
   */
  function stripImportFields(rows, opts) {
    const o = opts || {};
    return (rows || []).map((r) => {
      const c = { ...r };
      if (o.description) {
        c.notes = '';
        if (c.webcall_url && !c.url_from_property && c.webcall_url === extractHttpsFromText(r.notes || '')) c.webcall_url = '';
      }
      if (o.attendees) c.attendees = [];
      if (o.locations) c.location = '';
      return c;
    });
  }

  /**
   * Run several already-read files through the existing parser (and its limits).
   * entries: [{ name, text }]. A bad file yields {name, error} and does not stop the others.
   */
  function parseIcsEntries(entries) {
    const files = [];
    for (const e of entries || []) {
      const name = String((e && e.name) || 'import');
      try {
        const { events, warnings } = parseIcsFile(e.text);
        files.push({ name, events, warnings, error: '' });
      } catch (err) {
        files.push({ name, events: [], warnings: [], error: String((err && err.message) || err) });
      }
    }
    return files;
  }

  global.NotesAgendaIcs = {
    stripImportFields,
    parseIcsEntries,
    diffImport,
    makeSourceLabel,
    idsWithSource,
    stableHash,
    parseIcsFile,
    validateIcsFile,
    looksBinary,
    MAX_ICS_BYTES,
    MAX_ICS_EVENTS,
    sanitizeHttpsUrl,
    extractHttpsFromText,
    escapeIcsText,
    foldIcsLine,
    buildIcsCalendarFromEvents,
    formatUtcDateTime,
    formatLocalDateValue,
    resolveTimeZone,
    zonedWallTimeToDate,
    buildVTimezoneLines,
  };
}(typeof window !== 'undefined' ? window : globalThis));
