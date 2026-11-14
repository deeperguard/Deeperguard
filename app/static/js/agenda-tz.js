/**
 * Per-event IANA timezone helpers for the Agenda (docs/design/calendar-multi.md).
 * Intl only: no external timezone service, nothing is sent anywhere. An event stores a UTC
 * instant plus an optional `tz` name inside the encrypted agenda_pack; a missing `tz` means
 * the device timezone, so old events show exactly as before.
 */
(function (global) {
  const FALLBACK_ZONES = [
    'UTC', 'Europe/Amsterdam', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid',
    'Europe/Rome', 'Europe/Brussels', 'Europe/Lisbon', 'Europe/Athens', 'Europe/Moscow',
    'Africa/Cairo', 'Africa/Johannesburg', 'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Los_Angeles', 'America/Toronto', 'America/Sao_Paulo', 'Asia/Dubai', 'Asia/Kolkata',
    'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
  ];

  const fmtCache = new Map();
  function formatter(tz) {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      fmtCache.set(tz, f);
    }
    return f;
  }

  function isValidTz(tz) {
    if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
    try {
      formatter(tz);
      return true;
    } catch (_) {
      return false;
    }
  }

  function deviceTz() {
    try {
      const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (isValidTz(z)) return z;
    } catch (_) { /* fall through */ }
    return 'UTC';
  }

  /** Effective zone of an event: its own valid tz, else the device zone. */
  function effectiveTz(tz) {
    return isValidTz(tz) ? tz : deviceTz();
  }

  function listZones() {
    let list = [];
    try {
      if (typeof Intl.supportedValuesOf === 'function') list = Intl.supportedValuesOf('timeZone');
    } catch (_) {
      list = [];
    }
    if (!list || !list.length) list = FALLBACK_ZONES.slice();
    if (!list.includes('UTC')) list = ['UTC'].concat(list);
    return list.filter(isValidTz);
  }

  /** Wall clock of an instant in `tz`. */
  function wallParts(ms, tz) {
    const o = {};
    for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
    return {
      y: Number(o.year),
      mo: Number(o.month),
      d: Number(o.day),
      h: Number(o.hour) % 24,
      mi: Number(o.minute),
      s: Number(o.second),
    };
  }

  function offsetMs(ms, tz) {
    const w = wallParts(ms, tz);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
  }

  /**
   * Instant for a wall-clock time in `tz`. In the autumn overlap the first (summer-time)
   * pass wins; in the spring gap the time moves forward by the length of the gap.
   */
  function zonedToInstant(y, mo, d, h, mi, tz) {
    const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
    const before = offsetMs(naive - 86400000, tz);
    const after = offsetMs(naive + 86400000, tz);
    const valid = [naive - before, naive - after].filter((t) => {
      const w = wallParts(t, tz);
      return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
    });
    if (valid.length) return Math.min(...valid);
    return naive - before;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  /** 'YYYY-MM-DDTHH:mm' wall time of an instant in `tz` (for datetime-local inputs). */
  function toLocalInput(ms, tz) {
    const w = wallParts(ms, tz);
    return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}T${pad2(w.h)}:${pad2(w.mi)}`;
  }

  /** Inverse of toLocalInput; returns ms or NaN. */
  function fromLocalInput(str, tz) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(str || ''));
    if (!m) return NaN;
    return zonedToInstant(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz);
  }

  function hm(ms, tz) {
    const w = wallParts(ms, tz);
    return `${pad2(w.h)}:${pad2(w.mi)}`;
  }

  /** City part of an IANA name: 'America/New_York' -> 'New York'. */
  function zoneCity(tz) {
    return String(tz).split('/').pop().replace(/_/g, ' ');
  }

  /**
   * Original-time annotation like '09:00 New York', or '' when the event has no valid tz
   * or its zone is the device zone.
   */
  function originalTimeLabel(startMs, tz, device) {
    if (!isValidTz(tz)) return '';
    if (tz === (device || deviceTz())) return '';
    return `${hm(startMs, tz)} ${zoneCity(tz)}`;
  }

  global.NotesAgendaTz = {
    deviceTz,
    isValidTz,
    effectiveTz,
    listZones,
    wallParts,
    zonedToInstant,
    toLocalInput,
    fromLocalInput,
    originalTimeLabel,
    zoneCity,
    FALLBACK_ZONES,
  };
}(typeof window !== 'undefined' ? window : globalThis));
