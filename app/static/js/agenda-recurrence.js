/**
 * Parse/build simple WEEKLY RRULE strings for Agenda editor.
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

  function parseAgendaRrule(raw) {
    const original = String(raw || '').trim();
    if (!original) {
      return { kind: 'none', raw: '', until: null, interval: 1 };
    }
    const rule = original.toUpperCase();
    if (!/^FREQ=WEEKLY/.test(rule)) {
      return { kind: 'advanced', raw: original, until: parseUntil(rule.match(/UNTIL=([^;:]+)/)?.[1]), interval: 1 };
    }
    if (/BYDAY=|BYMONTH=|BYSETPOS=|COUNT=|FREQ=(?!WEEKLY)/.test(rule)) {
      return { kind: 'advanced', raw: original, until: parseUntil(rule.match(/UNTIL=([^;:]+)/)?.[1]), interval: 1 };
    }
    const intervalMatch = rule.match(/INTERVAL=(\d+)/);
    const interval = intervalMatch ? Math.max(1, Number(intervalMatch[1]) || 1) : 1;
    const until = parseUntil(rule.match(/UNTIL=([^;:]+)/)?.[1]);
    if (interval === 2) return { kind: 'biweekly', raw: original, until, interval: 2 };
    if (interval === 1) return { kind: 'weekly', raw: original, until, interval: 1 };
    return { kind: 'advanced', raw: original, until, interval };
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
    const interval = kind === 'biweekly' ? 2 : 1;
    let out = `FREQ=WEEKLY;INTERVAL=${interval}`;
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
