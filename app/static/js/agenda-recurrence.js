/**
 * Parse/build simple RRULE strings for Agenda editor.
 * Unsupported/imported rules are preserved verbatim when kind is "advanced".
 */
(function (global) {
  function parseUntil(raw) {
    if (!raw) return null;
    const s = String(raw).trim().replace(/Z$/i, '');
    if (/^\d{8}$/.test(s)) {
      const y = Number(s.slice(0, 4));
      const m = Number(s.slice(4, 6)) - 1;
      const d = Number(s.slice(6, 8));
      return new Date(y, m, d, 23, 59, 59);
    }
    if (/^\d{8}T\d{6}$/.test(s)) {
      const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
      const t = Date.parse(iso);
      return Number.isFinite(t) ? new Date(t) : null;
    }
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
  }

  function parseInterval(rule) {
    const intervalMatch = rule.match(/INTERVAL=(\d+)/);
    return intervalMatch ? Math.max(1, Number(intervalMatch[1]) || 1) : 1;
  }

  function parseAgendaRrule(raw) {
    const original = String(raw || '').trim();
    if (!original) {
      return { kind: 'none', raw: '', until: null, interval: 1 };
    }
    const rule = original.toUpperCase();
    const until = parseUntil(rule.match(/UNTIL=([^;:]+)/)?.[1]);
    if (/BY[A-Z]+=|COUNT=|WKST=/.test(rule)) {
      if (!/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY);INTERVAL=\d+(;UNTIL=[^;:]+)?$/.test(rule)) {
        return { kind: 'advanced', raw: original, until, interval: parseInterval(rule) };
      }
    }
    const interval = parseInterval(rule);
    if (/^FREQ=DAILY/.test(rule)) {
      if (interval !== 1) return { kind: 'advanced', raw: original, until, interval };
      return { kind: 'daily', raw: original, until, interval };
    }
    if (/^FREQ=WEEKLY/.test(rule)) {
      if (interval === 2) return { kind: 'biweekly', raw: original, until, interval: 2 };
      if (interval === 1) return { kind: 'weekly', raw: original, until, interval: 1 };
      return { kind: 'advanced', raw: original, until, interval };
    }
    if (/^FREQ=MONTHLY/.test(rule)) {
      if (interval !== 1) return { kind: 'advanced', raw: original, until, interval };
      return { kind: 'monthly', raw: original, until, interval };
    }
    if (/^FREQ=YEARLY/.test(rule)) {
      if (interval !== 1) return { kind: 'advanced', raw: original, until, interval };
      return { kind: 'yearly', raw: original, until, interval };
    }
    return { kind: 'advanced', raw: original, until, interval: 1 };
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatUntilUtc(d) {
    if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return '';
    return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T235959Z`;
  }

  function buildAgendaRrule(kind, untilDate) {
    if (!kind || kind === 'none') return '';
    if (kind === 'advanced') return null;
    const freqMap = {
      daily: 'DAILY',
      weekly: 'WEEKLY',
      biweekly: 'WEEKLY',
      monthly: 'MONTHLY',
      yearly: 'YEARLY',
    };
    const freq = freqMap[kind];
    if (!freq) return null;
    const interval = kind === 'biweekly' ? 2 : 1;
    let out = `FREQ=${freq};INTERVAL=${interval}`;
    if (untilDate) {
      const d = untilDate instanceof Date ? untilDate : new Date(untilDate);
      if (!Number.isNaN(d.getTime())) out += `;UNTIL=${formatUntilUtc(d)}`;
    }
    return out;
  }

  /** Advance by calendar months; clip day-of-month to target month's last day (31 Jan → 28/29 Feb). */
  function addMonthsClipped(d, delta) {
    const day = d.getDate();
    const next = new Date(d.getTime());
    next.setDate(1);
    next.setMonth(next.getMonth() + delta);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
    return next;
  }

  const MS_DAY = 86400000;
  const WEEKDAY_INDEX = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const EXPAND_STEP_CAP = 5000;
  /** Hard limits so an endless or huge rule cannot hang the browser. */
  const MAX_OCCURRENCES_PER_RULE = 2000;
  const MAX_HORIZON_YEARS = 50;

  function daysInMonth(y, m) {
    return new Date(y, m + 1, 0).getDate();
  }

  /** Whole calendar days between two local dates (ignores clock changes). */
  function dayNumber(d) {
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_DAY);
  }

  /** Add calendar days, keeping the local wall-clock time across clock changes. */
  function addCalendarDays(d, n) {
    return new Date(
      d.getFullYear(), d.getMonth(), d.getDate() + n,
      d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(),
    );
  }

  /** Add calendar months; the day is clipped to the target month (31 Jan + 1 → 28/29 Feb). */
  function addCalendarMonths(d, n) {
    const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const day = Math.min(d.getDate(), daysInMonth(first.getFullYear(), first.getMonth()));
    return new Date(
      first.getFullYear(), first.getMonth(), day,
      d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(),
    );
  }

  function parseRuleParts(raw) {
    const parts = {};
    String(raw || '').trim().toUpperCase().replace(/^RRULE:/, '').split(';').forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
    return parts;
  }

  /**
   * Describe how a rule can be expanded.
   * `supported: false` means the rule uses parts this expander does not implement; callers
   * must then show the first occurrence only and never rewrite the stored rule.
   */
  function describeRule(raw, seriesStart) {
    const parts = parseRuleParts(raw);
    const freq = parts.FREQ || '';
    const out = {
      freq,
      interval: Math.max(1, Number(parts.INTERVAL) || 1),
      until: parts.UNTIL ? parseUntil(parts.UNTIL) : null,
      count: parts.COUNT ? Math.max(1, Number(parts.COUNT) || 1) : 0,
      weekdays: null,
      nthWeekdays: null,
      monthDay: 0,
      weekStart: 1,
      supported: ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq),
    };
    if (!out.supported) return out;
    const known = new Set(['FREQ', 'INTERVAL', 'UNTIL', 'COUNT', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);
    if (Object.keys(parts).some((k) => !known.has(k))) {
      out.supported = false;
      return out;
    }
    if (parts.WKST) {
      if (WEEKDAY_INDEX[parts.WKST] == null) { out.supported = false; return out; }
      out.weekStart = WEEKDAY_INDEX[parts.WKST];
    }
    const start = seriesStart instanceof Date ? seriesStart : new Date(seriesStart);
    if (parts.BYDAY) {
      const plain = [];
      const nth = [];
      for (const tok of parts.BYDAY.split(',')) {
        const m = tok.trim().match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
        if (!m) { out.supported = false; return out; }
        if (m[1]) nth.push({ n: Number(m[1]), wd: WEEKDAY_INDEX[m[2]] });
        else plain.push(WEEKDAY_INDEX[m[2]]);
      }
      if (plain.length && nth.length) { out.supported = false; return out; }
      if (plain.length) {
        if (freq !== 'WEEKLY' && freq !== 'DAILY') { out.supported = false; return out; }
        out.weekdays = [...new Set(plain)];
      } else {
        if (freq !== 'MONTHLY' || nth.some((x) => x.n === 0 || Math.abs(x.n) > 5)) {
          out.supported = false;
          return out;
        }
        out.nthWeekdays = nth;
      }
    }
    if (parts.BYMONTHDAY) {
      const md = Number(parts.BYMONTHDAY);
      const okMonthly = freq === 'MONTHLY' && !out.nthWeekdays && /^\d{1,2}$/.test(parts.BYMONTHDAY) && md >= 1 && md <= 31;
      const okYearly = freq === 'YEARLY' && Number.isFinite(start.getTime()) && md === start.getDate();
      if (okMonthly) out.monthDay = md;
      else if (!okYearly) { out.supported = false; return out; }
    }
    if (parts.BYMONTH) {
      const okYearly = freq === 'YEARLY' && Number.isFinite(start.getTime())
        && /^\d{1,2}$/.test(parts.BYMONTH) && Number(parts.BYMONTH) === start.getMonth() + 1;
      if (!okYearly) { out.supported = false; return out; }
    }
    return out;
  }

  function nthWeekdayOfMonth(y, m, n, wd) {
    const dim = daysInMonth(y, m);
    if (n > 0) {
      const first = new Date(y, m, 1).getDay();
      const day = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
      return day <= dim ? day : 0;
    }
    const last = new Date(y, m, dim).getDay();
    const day = dim - ((last - wd + 7) % 7) + (n + 1) * 7;
    return day >= 1 ? day : 0;
  }

  /**
   * Expand a repeating event into raw occurrences that overlap [rangeStart, rangeEnd).
   *
   * Every occurrence is computed from the series start (never from the previous occurrence),
   * in local calendar fields, so the wall-clock time survives clock changes and month-end
   * clipping does not accumulate. Works for all-day events (whole calendar days).
   *
   * Returns [{ start, end, recurring: true, legacyStart?, partial? }].
   * `legacyStart` is the instant older clients used for the same slot (fixed 24 h steps);
   * it lets stored per-occurrence edits made before this fix keep matching.
   */
  function expandSeries(ev, rangeStart, rangeEnd) {
    const s0 = new Date(ev && ev.start);
    const e0 = new Date(ev && ev.end);
    if (!Number.isFinite(s0.getTime()) || !Number.isFinite(e0.getTime())) return [];
    const allDay = !!(ev && ev.all_day);
    const base = allDay ? new Date(s0.getFullYear(), s0.getMonth(), s0.getDate()) : s0;
    const durMs = Math.max(0, e0.getTime() - s0.getTime());
    const durDays = allDay ? Math.max(1, dayNumber(e0) - dayNumber(s0)) : 0;
    const endFor = (start) => (allDay ? addCalendarDays(start, durDays) : new Date(start.getTime() + durMs));
    const rule = describeRule(ev.rrule, base);
    const out = [];
    const horizon = new Date(base.getTime());
    horizon.setFullYear(horizon.getFullYear() + MAX_HORIZON_YEARS);
    if (rangeEnd > horizon) rangeEnd = horizon;
    const emit = (start, legacyMs) => {
      if (out.length >= MAX_OCCURRENCES_PER_RULE) return;
      const end = endFor(start);
      if (end > rangeStart && start < rangeEnd) {
        const row = { start, end, recurring: true };
        if (!allDay && Number.isFinite(legacyMs) && legacyMs !== start.getTime()) {
          row.legacyStart = new Date(legacyMs);
        }
        out.push(row);
      }
    };
    if (!rule.supported) {
      const end = endFor(base);
      if (end > rangeStart && base < rangeEnd) out.push({ start: base, end, recurring: true, partial: true });
      return out;
    }
    const until = rule.until;
    const pastEnd = (start) => start >= rangeEnd || (until && start > until);
    // How far before rangeStart an occurrence may begin and still overlap the range.
    const lookbackDays = (allDay ? durDays : Math.ceil(durMs / MS_DAY)) + 1;
    const firstDay = dayNumber(rangeStart) - lookbackDays;
    const baseDay = dayNumber(base);
    const maxSteps = EXPAND_STEP_CAP;

    if (rule.freq === 'DAILY' || (rule.freq === 'WEEKLY' && !rule.weekdays)) {
      const stepDays = rule.freq === 'DAILY' ? rule.interval : 7 * rule.interval;
      const direct = !rule.weekdays; // DAILY;BYDAY filters days, so COUNT cannot map to an index
      let k = direct ? Math.max(0, Math.floor((firstDay - baseDay) / stepDays)) : 0;
      if (!direct && !rule.count) k = Math.max(0, Math.floor((firstDay - baseDay) / stepDays));
      let made = 0;
      for (let i = 0; i < maxSteps; i += 1, k += 1) {
        if (direct && rule.count && k >= rule.count) break;
        const start = addCalendarDays(base, k * stepDays);
        if (pastEnd(start)) break;
        if (rule.weekdays && !rule.weekdays.includes(start.getDay())) continue;
        if (!direct && rule.count) {
          made += 1;
          if (made > rule.count) break;
        }
        emit(start, base.getTime() + k * stepDays * MS_DAY);
      }
      return out;
    }

    if (rule.freq === 'WEEKLY') {
      const weekStartOffset = (base.getDay() - rule.weekStart + 7) % 7;
      const offsets = rule.weekdays
        .map((wd) => (wd - rule.weekStart + 7) % 7)
        .sort((a, b) => a - b);
      const stepDays = 7 * rule.interval;
      let w = rule.count ? 0 : Math.max(0, Math.floor((firstDay - (baseDay - weekStartOffset)) / stepDays));
      let made = 0;
      for (let i = 0; i < maxSteps; i += 1, w += 1) {
        let stop = false;
        for (const off of offsets) {
          const delta = w * stepDays + off - weekStartOffset;
          if (delta < 0) continue;
          const start = addCalendarDays(base, delta);
          if (pastEnd(start)) { stop = true; break; }
          if (rule.count) {
            made += 1;
            if (made > rule.count) { stop = true; break; }
          }
          emit(start);
        }
        if (stop) break;
      }
      return out;
    }

    const baseMonths = base.getFullYear() * 12 + base.getMonth();
    const first = new Date(rangeStart.getTime() - lookbackDays * MS_DAY);
    const firstMonths = first.getFullYear() * 12 + first.getMonth();
    const stepMonths = rule.freq === 'YEARLY' ? 12 * rule.interval : rule.interval;
    const skipping = !!(rule.nthWeekdays || rule.monthDay);
    let k = (rule.count && skipping) ? 0 : Math.max(0, Math.floor((firstMonths - baseMonths) / stepMonths) - 1);
    let made = 0;
    for (let i = 0; i < maxSteps; i += 1, k += 1) {
      if (rule.count && !skipping && k >= rule.count) break;
      const firstOfMonth = new Date(base.getFullYear(), base.getMonth() + k * stepMonths, 1);
      const y = firstOfMonth.getFullYear();
      const m = firstOfMonth.getMonth();
      let days;
      if (rule.nthWeekdays) {
        days = rule.nthWeekdays.map((x) => nthWeekdayOfMonth(y, m, x.n, x.wd)).filter(Boolean).sort((a, b) => a - b);
      } else if (rule.monthDay) {
        days = rule.monthDay <= daysInMonth(y, m) ? [rule.monthDay] : [];
      } else {
        days = [Math.min(base.getDate(), daysInMonth(y, m))];
      }
      let stop = false;
      for (const day of days) {
        const start = new Date(y, m, day, base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds());
        if (start < base) continue;
        if (pastEnd(start)) { stop = true; break; }
        if (rule.count && skipping) {
          made += 1;
          if (made > rule.count) { stop = true; break; }
        }
        emit(start);
      }
      if (stop) break;
      if (new Date(y, m, 1) >= rangeEnd) break;
    }
    return out;
  }

  function toDateInputValue(d) {
    if (!d || Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  global.NotesAgendaRecurrence = {
    parseAgendaRrule,
    buildAgendaRrule,
    formatUntilUtc,
    parseUntil,
    toDateInputValue,
    addMonthsClipped,
    addCalendarDays,
    addCalendarMonths,
    describeRule,
    expandSeries,
    MAX_OCCURRENCES_PER_RULE,
    MAX_HORIZON_YEARS,
  };
}(typeof window !== 'undefined' ? window : globalThis));
