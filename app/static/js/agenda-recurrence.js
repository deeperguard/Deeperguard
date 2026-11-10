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
    if (/BYDAY=|BYMONTH=|BYSETPOS=|COUNT=/.test(rule)) {
      if (!/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY);INTERVAL=\d+(;UNTIL=[^;:]+)?$/.test(rule)) {
        return { kind: 'advanced', raw: original, until, interval: parseInterval(rule) };
      }
    }
    const interval = parseInterval(rule);
    if (/^FREQ=DAILY/.test(rule)) {
      return { kind: 'daily', raw: original, until, interval };
    }
    if (/^FREQ=WEEKLY/.test(rule)) {
      if (interval === 2) return { kind: 'biweekly', raw: original, until, interval: 2 };
      if (interval === 1) return { kind: 'weekly', raw: original, until, interval: 1 };
      return { kind: 'advanced', raw: original, until, interval };
    }
    if (/^FREQ=MONTHLY/.test(rule)) {
      return { kind: 'monthly', raw: original, until, interval };
    }
    if (/^FREQ=YEARLY/.test(rule)) {
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
  };
}(typeof window !== 'undefined' ? window : globalThis));
