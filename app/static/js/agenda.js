/**
 * Deeperguard Agenda — week / day / 3-day / month / list views; vault-encrypted events.
 */
(function (global) {
  const MS_DAY = 86400000;
  const EVENT_COLORS = [
    '#3b82f6', '#2563eb', '#0ea5e9', '#10b981',
    '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899',
  ];
  const ACCENT_PALETTE = EVENT_COLORS;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  /** Add calendar days; keeps local wall-clock time across clock changes (a day is not always 24 h). */
  function addDays(d, n) {
    return new Date(
      d.getFullYear(), d.getMonth(), d.getDate() + n,
      d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(),
    );
  }

  /** Monday-based week start (local). */
  function startOfWeekMonday(d) {
    const x = startOfDay(d);
    const day = x.getDay();
    const diff = (day + 6) % 7;
    return addDays(x, -diff);
  }

  function isoWeekNumber(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date - yearStart) / MS_DAY + 1) / 7);
  }

  function monthTitle(d) {
    return d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  }

  function shortWeekday(d) {
    return d.toLocaleString(undefined, { weekday: 'short' }).toUpperCase();
  }

  function formatTime(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function formatShortDate(d) {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatRangeTitle(days) {
    if (!days || !days.length) return monthTitle(state.anchor);
    const a = days[0];
    const b = days[days.length - 1];
    const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    if (sameMonth) {
      const mid = b.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      return `${a.getDate()}–${b.getDate()} ${mid}`;
    }
    return `${formatShortDate(a)} – ${formatShortDate(b)}`;
  }

  function isAgendaPhoneLayout() {
    return typeof global.matchMedia === 'function' && global.matchMedia('(max-width: 768px)').matches;
  }

  function defaultAgendaView() {
    if (typeof global.matchMedia !== 'function') return 'week';
    if (global.matchMedia('(max-width: 430px)').matches) return 'day';
    if (global.matchMedia('(max-width: 768px)').matches) return '3day';
    return 'week';
  }

  function agendaUiLocale() {
    const lang = document?.documentElement?.lang;
    return lang && String(lang).trim() ? String(lang).trim() : 'en';
  }

  function hashHue(id) {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h) + s.charCodeAt(i);
    return Math.abs(h) % EVENT_COLORS.length;
  }

  function eventAccentColor(ev) {
    const pick = String(ev?.color || '').trim().toLowerCase();
    if (EVENT_COLORS.some((c) => c.toLowerCase() === pick)) return pick;
    return EVENT_COLORS[hashHue(ev?.id || '')];
  }

  function parseInstant(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t) : null;
  }

  function eventSpan(ev) {
    const a = parseInstant(ev.start);
    const b = parseInstant(ev.end);
    if (!a || !b) return null;
    return { start: a, end: b };
  }

  function occDisplayTitle(o) {
    return String(o.displayTitle || o.ev.title || '');
  }

  function occurrenceChipAttrs(o) {
    if (!o.recurring) return '';
    const ser = o.seriesInstanceStart || o.start;
    if (!ser || !Number.isFinite(ser.getTime())) return '';
    return ` data-agenda-occurrence-ms="${ser.getTime()}"`;
  }

  /** Expand instances for range [rangeStart, rangeEnd): single events plus repeat rules (see agenda-recurrence.js). */
  function expandEventOccurrences(ev, rangeStart, rangeEnd) {
    const span = eventSpan(ev);
    if (!span) return [];
    const out = [];
    const hasRule = !!(ev.rrule && String(ev.rrule).trim());
    if (!hasRule) {
      if (ev.all_day) {
        const ds = startOfDay(span.start).getTime();
        const de = startOfDay(span.end).getTime();
        const rs = startOfDay(rangeStart).getTime();
        const re = rangeEnd.getTime();
        if (de <= rs || ds >= re) return out;
        const clipStart = Math.max(ds, rs);
        const clipEnd = Math.min(de, re);
        if (clipEnd <= clipStart) return out;
        out.push({ ev, start: new Date(clipStart), end: new Date(clipEnd), recurring: false });
        return out;
      }
      if (span.end <= rangeStart || span.start >= rangeEnd) return out;
      out.push({ ev, start: span.start, end: span.end, recurring: false });
      return out;
    }

    // Repeating events (timed and all-day): one shared, calendar-based expander.
    const R = global.NotesAgendaRecurrence;
    if (R && typeof R.expandSeries === 'function') {
      R.expandSeries(ev, rangeStart, rangeEnd).forEach((row) => out.push({ ev, ...row }));
    } else if (span.end > rangeStart && span.start < rangeEnd) {
      out.push({ ev, start: span.start, end: span.end, recurring: true, partial: true });
    }
    const Occ = global.NotesAgendaOccurrence;
    if (Occ && typeof Occ.finalizeOccurrences === 'function') {
      return Occ.finalizeOccurrences(ev, out, rangeStart, rangeEnd);
    }
    return out;
  }

  function layoutDayColumns(dayOcc, dayStart) {
    const dayEnd = addDays(dayStart, 1);
    const items = dayOcc
      .filter((o) => o.end > dayStart && o.start < dayEnd && !o.ev.all_day)
      .map((o) => ({
        ...o,
        a: o.start < dayStart ? dayStart : o.start,
        b: o.end > dayEnd ? dayEnd : o.end,
      }))
      .sort((x, y) => x.a - y.a || x.b - y.b);
    const colEnds = [];
    const placed = [];
    for (const o of items) {
      let c = 0;
      while (c < colEnds.length && colEnds[c] > o.a) c += 1;
      if (c === colEnds.length) colEnds.push(o.b);
      else colEnds[c] = o.b;
      placed.push({ ...o, col: c });
    }
    const parent = placed.map((_, idx) => idx);
    const find = (idx) => {
      let root = idx;
      while (parent[root] !== root) {
        parent[root] = parent[parent[root]];
        root = parent[root];
      }
      return root;
    };
    const unite = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };
    const overlap = (a, b) => a.b > b.a && a.a < b.b;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        if (overlap(placed[i], placed[j])) unite(i, j);
      }
    }
    const clusterMaxCol = new Map();
    placed.forEach((p, i) => {
      const root = find(i);
      const prev = clusterMaxCol.has(root) ? clusterMaxCol.get(root) : -1;
      clusterMaxCol.set(root, Math.max(prev, p.col));
    });
    placed.forEach((p, i) => {
      p.colCount = clusterMaxCol.get(find(i)) + 1;
    });
    return placed;
  }

  function listDayHeading(d) {
    const ds = startOfDay(d);
    const today = startOfDay(new Date());
    const loc = agendaUiLocale();
    const when = ds.toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short' });
    if (ds.getTime() === today.getTime()) return `Today · ${when}`;
    return when;
  }

  function listEmptyMessage() {
    if (state.view === 'day') return 'No events this day.';
    if (state.view === '3day') return 'No events in this range.';
    if (state.view === 'week') return 'No events this week.';
    return 'No events in this period.';
  }

  function layoutAllDayLanes(allDayOcc, days) {
    const placed = [];
    for (const o of allDayOcc) {
      const ds = startOfDay(o.start).getTime();
      const de = startOfDay(o.end).getTime();
      let i0 = -1;
      let i1 = -1;
      days.forEach((d, i) => {
        const t0 = startOfDay(d).getTime();
        const t1 = addDays(startOfDay(d), 1).getTime();
        if (de > t0 && ds < t1) {
          if (i0 < 0) i0 = i;
          i1 = i;
        }
      });
      if (i0 < 0) continue;
      placed.push({ o, i0, i1, span: i1 - i0 + 1 });
    }
    const laneEnds = [];
    placed.forEach((p) => {
      let lane = 0;
      while (lane < laneEnds.length) {
        const blocked = laneEnds[lane].some((x) => !(p.i1 < x.i0 || p.i0 > x.i1));
        if (!blocked) break;
        lane += 1;
      }
      if (!laneEnds[lane]) laneEnds[lane] = [];
      laneEnds[lane].push({ i0: p.i0, i1: p.i1 });
      p.lane = lane;
    });
    return placed;
  }

  const state = {
    view: 'week',
    anchor: new Date(),
    monthPickDay: 0,
    search: '',
    selectedId: '',
    editorScope: 'series',
    editorOccurrenceStartMs: 0,
    pendingEditor: null,
    editorReturnFocusId: '',
    editorReturnFocusOccurrenceMs: 0,
    seriesOverrideResetConfirmed: false,
    editorColor: '',
  };

  let rootEl = null;
  let fileInput = null;
  let searchDebounce = 0;
  let editorWired = false;
  let calendarSettingsWired = false;
  let agendaSwipeWired = false;
  let agendaFabWired = false;
  /** @type {HTMLElement | null} */
  let editorReturnFocus = null;
  /** @type {HTMLElement | null} */
  let calendarSettingsReturnFocus = null;
  /** @type {{ active: boolean, x: number, y: number, t: number, locked: string }} */
  let swipe = { active: false, x: 0, y: 0, t: 0, locked: '' };
  const PX_PER_HOUR = 52;
  const DEFAULT_DAY_START_HOUR = 8;
  const SWIPE_MIN_PX = 56;
  const SWIPE_MAX_MS = 900;
  const WHEEL_NAV_MIN_DX = 42;

  function closeCalendarSettingsPanel() {
    const calPanel = document.getElementById('agenda-calendar-settings');
    const calBackdrop = document.getElementById('agenda-calendar-settings-backdrop');
    const calBtn = document.getElementById('agenda-calendar-settings-btn');
    const returnFocus = calendarSettingsReturnFocus;
    calendarSettingsReturnFocus = null;
    if (calPanel) {
      calPanel.hidden = true;
      calPanel.setAttribute('aria-hidden', 'true');
    }
    if (calBackdrop) {
      calBackdrop.hidden = true;
      calBackdrop.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('agenda-calendar-settings-open');
    if (calBtn) calBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }

  function openCalendarSettingsPanel() {
    const calPanel = document.getElementById('agenda-calendar-settings');
    const calBackdrop = document.getElementById('agenda-calendar-settings-backdrop');
    const calBtn = document.getElementById('agenda-calendar-settings-btn');
    calendarSettingsReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (calPanel) {
      calPanel.hidden = false;
      calPanel.removeAttribute('aria-hidden');
    }
    if (calBackdrop) {
      calBackdrop.hidden = false;
      calBackdrop.removeAttribute('aria-hidden');
    }
    document.body.classList.add('agenda-calendar-settings-open');
    if (calBtn) calBtn.setAttribute('aria-expanded', 'true');
    const closeBtn = document.getElementById('agenda-calendar-settings-close');
    if (closeBtn) closeBtn.focus();
  }

  function wireCalendarSettingsOnce() {
    if (calendarSettingsWired) return;
    calendarSettingsWired = true;
    document.getElementById('agenda-calendar-settings-backdrop')
      ?.addEventListener('click', closeCalendarSettingsPanel);
    document.getElementById('agenda-calendar-settings-close')
      ?.addEventListener('click', closeCalendarSettingsPanel);
    document.getElementById('agenda-calendar-import-ics')?.addEventListener('click', () => {
      closeCalendarSettingsPanel();
      fileInput?.click();
    });
    document.getElementById('agenda-calendar-export-ics')?.addEventListener('click', () => {
      exportAgendaToIcs();
    });
    document.getElementById('agenda-open-app-settings')?.addEventListener('click', () => {
      closeCalendarSettingsPanel();
      if (typeof window.__notesOpenSettings === 'function') window.__notesOpenSettings();
      else document.getElementById('btn-settings-head')?.click();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !document.body.classList.contains('agenda-calendar-settings-open')) return;
      closeCalendarSettingsPanel();
    });
  }

  function getStore() {
    return global.NotesStore;
  }

  function listAgendaEvents() {
    const S = getStore();
    if (!S || typeof S.listAgendaEvents !== 'function') return [];
    return S.listAgendaEvents();
  }

  function rangeForView() {
    const v = state.view;
    if (v === 'day') {
      const s = startOfDay(state.anchor);
      return { start: s, end: addDays(s, 1), days: [s] };
    }
    if (v === '3day') {
      const s = startOfDay(state.anchor);
      const days = [s, addDays(s, 1), addDays(s, 2)];
      return { start: s, end: addDays(s, 3), days };
    }
    if (v === 'week') {
      const s = startOfWeekMonday(state.anchor);
      const days = [];
      for (let i = 0; i < 7; i += 1) days.push(addDays(s, i));
      return { start: s, end: addDays(s, 7), days };
    }
    if (v === 'month') {
      const y = state.anchor.getFullYear();
      const m = state.anchor.getMonth();
      const first = new Date(y, m, 1);
      const last = new Date(y, m + 1, 0);
      const gridStart = startOfWeekMonday(first);
      // Exclusive end: first Monday strictly after the week that contains `last`.
      // Using startOfWeekMonday(addDays(last, 1)) wrongly collapses to `last`'s week
      // when `last` is a Monday, so that week is never iterated.
      const gridEndWeekExclusive = addDays(startOfWeekMonday(last), 7);
      const weekStarts = [];
      let cur = gridStart;
      while (cur < gridEndWeekExclusive) {
        weekStarts.push(cur);
        cur = addDays(cur, 7);
      }
      const nWeeks = Math.max(1, weekStarts.length);
      const out = [];
      for (let i = 0; i < nWeeks * 7; i += 1) out.push(addDays(gridStart, i));
      return {
        start: out[0],
        end: addDays(out[out.length - 1], 1),
        days: out,
      };
    }
    const s = startOfDay(state.anchor);
    const end = addDays(s, 14);
    const dayList = [];
    for (let i = 0; i < 14; i += 1) dayList.push(addDays(s, i));
    return { start: s, end, days: dayList };
  }

  function filterEvents(query, events) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) => {
      const hay = [
        e.title, e.location, e.notes, (e.attendees || []).join(' '),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function scrollPeriodKey(range) {
    if (!range) return '';
    if (state.view === 'month') {
      const y = state.anchor.getFullYear();
      const m = state.anchor.getMonth();
      return `${state.view}|${y}-${m}`;
    }
    if (state.view === 'agenda') {
      return `${state.view}|${startOfDay(state.anchor).getTime()}`;
    }
    return `${state.view}|${range.start.getTime()}`;
  }

  function scrollStorageKey(range) {
    const k = scrollPeriodKey(range);
    return k ? `notes_agenda_scroll_${k}` : '';
  }

  /** SessionStorage key for schedule fingerprint paired with scroll top (same period as scrollStorageKey). */
  function scrollFingerprintStorageKey(range) {
    const k = scrollPeriodKey(range);
    return k ? `notes_agenda_scroll_fp_${k}` : '';
  }

  function buildOccurrencesUnfiltered(rangeStart, rangeEnd) {
    const events = listAgendaEvents();
    const occ = [];
    for (const ev of events) {
      occ.push(...expandEventOccurrences(ev, rangeStart, rangeEnd));
    }
    return occ;
  }

  /** Fingerprint from full vault schedule in period (ignores Agenda search filter). */
  function scrollScheduleFingerprint(range) {
    const Core = global.NotesAgendaScroll;
    if (!Core || typeof Core.scheduleFingerprint !== 'function') return '';
    const occ = buildOccurrencesUnfiltered(range.start, range.end);
    return Core.scheduleFingerprint(occ, range.start, range.end);
  }

  function preferredTimeGridScrollTop(occ, range) {
    const Core = global.NotesAgendaScroll;
    if (!Core || typeof Core.preferredTimeGridScrollTop !== 'function') {
      return DEFAULT_DAY_START_HOUR * PX_PER_HOUR;
    }
    const wrap = rootEl?.querySelector?.('.agenda-scroll-wrap');
    const viewportHeight = wrap ? wrap.clientHeight : 0;
    return Core.preferredTimeGridScrollTop(occ, range, {
      pxPerHour: PX_PER_HOUR,
      defaultDayStartHour: DEFAULT_DAY_START_HOUR,
      viewportHeight,
    });
  }

  let timeGridScrollPlacementGen = 0;
  let timeGridScrollResizeObs = null;

  function applyTimeGridScroll(range, occ) {
    const placementGen = ++timeGridScrollPlacementGen;
    const placementLive = () => placementGen === timeGridScrollPlacementGen;
    if (timeGridScrollResizeObs) {
      try { timeGridScrollResizeObs.disconnect(); } catch (e) { /* ignore */ }
      timeGridScrollResizeObs = null;
    }
    const wrap = rootEl?.querySelector?.('.agenda-scroll-wrap');
    if (!wrap) return;
    const sk = scrollStorageKey(range);
    const fk = scrollFingerprintStorageKey(range);
    const Core = global.NotesAgendaScroll;
    const placeScroll = () => {
      const viewportHeight = wrap.clientHeight || 0;
      const scrollOpts = {
        pxPerHour: PX_PER_HOUR,
        defaultDayStartHour: DEFAULT_DAY_START_HOUR,
        viewportHeight,
      };
      const fp = scrollScheduleFingerprint(range);
      let top = preferredTimeGridScrollTop(occ, range);
      if (sk && fk) {
        try {
          const storedFp = sessionStorage.getItem(fk);
          const raw = sessionStorage.getItem(sk);
          if (Core && typeof Core.pickTimeGridScrollTop === 'function') {
            top = Core.pickTimeGridScrollTop({
              currentFingerprint: fp,
              storedFingerprint: storedFp,
              storedScrollTop: raw,
              displayOcc: occ,
              range,
              opts: scrollOpts,
            });
          } else if (
            storedFp
            && fp
            && storedFp === fp
            && raw !== null
            && raw !== ''
          ) {
            const n = Number(raw);
            if (Number.isFinite(n)) top = n;
          }
        } catch (e) { /* ignore */ }
      }
      try {
        wrap.dataset.agendaScrollApplying = '1';
        if (Core && typeof Core.clampTimeGridScrollTop === 'function') {
          wrap.scrollTop = Core.clampTimeGridScrollTop(top, wrap.scrollHeight, wrap.clientHeight);
        } else {
          const max = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
          wrap.scrollTop = Math.max(0, Math.min(top, max));
        }
      } finally {
        delete wrap.dataset.agendaScrollApplying;
      }
      if (wrap.scrollTop > 0) persistPlacedScroll();
    };
    const persistPlacedScroll = () => {
      if (!sk || !fk) return;
      const top = wrap.scrollTop;
      if (top <= 0) return;
      try {
        const fp = scrollScheduleFingerprint(range);
        if (!fp) return;
        sessionStorage.setItem(fk, fp);
        sessionStorage.setItem(sk, String(top));
      } catch (e) { /* ignore */ }
    };
    let placedAtScrollHeight = 0;
    const tryPlace = () => {
      if (!placementLive() || !wrap.isConnected) return;
      const sh = wrap.scrollHeight;
      const ch = wrap.clientHeight;
      const ready = Core && typeof Core.isTimeGridLayoutReady === 'function'
        ? Core.isTimeGridLayoutReady(sh, ch)
        : ch > 0 && sh > ch;
      if (!ready) return;
      if (placedAtScrollHeight > 0 && sh <= placedAtScrollHeight + 2) return;
      placedAtScrollHeight = sh;
      placeScroll();
      persistPlacedScroll();
    };
    let resizeObs = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => tryPlace());
      resizeObs.observe(wrap);
      timeGridScrollResizeObs = resizeObs;
    }
    const finishPlacement = () => {
      if (!placementLive()) return;
      if (resizeObs) {
        try { resizeObs.disconnect(); } catch (e) { /* ignore */ }
        if (timeGridScrollResizeObs === resizeObs) timeGridScrollResizeObs = null;
      }
    };
    const run = (attempt) => {
      if (!placementLive()) return;
      tryPlace();
      const stable = placedAtScrollHeight > 0 && wrap.scrollHeight <= placedAtScrollHeight + 2;
      if (stable) {
        finishPlacement();
        return;
      }
      if (attempt >= 64) return;
      requestAnimationFrame(() => run(attempt + 1));
    };
    tryPlace();
    requestAnimationFrame(() => run(0));
  }

  function saveTimeGridScrollSnapshot() {
    const wrap = rootEl?.querySelector?.('.agenda-scroll-wrap');
    if (!wrap) return;
    const range = rangeForView();
    const sk = scrollStorageKey(range);
    const fk = scrollFingerprintStorageKey(range);
    if (!sk || !fk) return;
    const top = wrap.scrollTop;
    if (top < 0) return;
    try {
      const fp = scrollScheduleFingerprint(range);
      if (!fp) return;
      sessionStorage.setItem(fk, fp);
      sessionStorage.setItem(sk, String(top));
    } catch (e) { /* ignore */ }
  }

  function wireTimeGridScrollPersistence(range) {
    const wrap = rootEl?.querySelector?.('.agenda-scroll-wrap');
    if (!wrap) return;
    const sk = scrollStorageKey(range);
    const fk = scrollFingerprintStorageKey(range);
    if (!sk || !fk) return;
    wrap.dataset.agendaScrollKey = sk;
    wrap.onscroll = () => {
      if (wrap.dataset.agendaScrollApplying === '1') return;
      try {
        const fp = scrollScheduleFingerprint(range);
        if (!fp) return;
        sessionStorage.setItem(fk, fp);
        sessionStorage.setItem(sk, String(wrap.scrollTop));
      } catch (e) { /* ignore */ }
    };
  }

  function exportAgendaToIcs() {
    const Ics = global.NotesAgendaIcs;
    const S = getStore();
    if (!Ics || typeof Ics.buildIcsCalendarFromEvents !== 'function' || !S || typeof S.listAgendaEvents !== 'function') {
      if (typeof global.notesAgendaToast === 'function') global.notesAgendaToast('Export unavailable', true);
      return;
    }
    const rows = listAgendaEvents() || [];
    if (!rows.length) {
      if (typeof global.notesAgendaToast === 'function') global.notesAgendaToast('No events to export', true);
      return;
    }
    const icsText = Ics.buildIcsCalendarFromEvents(flattenEventsForIcsExport(rows));
    const blob = new Blob([icsText], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `deeperguard-calendar-${stamp}.ics`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
    if (typeof global.notesAgendaToast === 'function') {
      global.notesAgendaToast('Exported .ics — file is plaintext; keep it private.');
    }
    closeCalendarSettingsPanel();
  }

  function agendaSwipeBlockedTarget(el) {
    if (!el || !el.closest) return true;
    return !!el.closest(
      '#agenda-editor, #agenda-editor-backdrop, #agenda-calendar-settings, #agenda-calendar-settings-backdrop,'
      + ' .confirm-dialog, #agenda-search, input, textarea, select, option,'
      + ' .agenda-icon-btn, .agenda-add, .agenda-calendar-menu-btn, .agenda-today, [data-agenda-view]',
    );
  }

  function wireAgendaSwipeOnce() {
    if (agendaSwipeWired) return;
    const pane = document.getElementById('agenda-pane');
    if (!pane) return;
    agendaSwipeWired = true;

    const tryNavigate = (dir) => {
      if (dir > 0) shiftAnchor(1);
      else if (dir < 0) shiftAnchor(-1);
      render();
    };

    const finishPan = (startX, startY, startT, endX, endY, locked) => {
      const dt = Date.now() - startT;
      const dx = endX - startX;
      const dy = endY - startY;
      if (locked === 'vertical') return;
      if (dt > SWIPE_MAX_MS) return;
      if (Math.abs(dy) > 80) return;
      if (Math.abs(dx) < SWIPE_MIN_PX) return;
      const horizontalIntent = locked === 'horizontal'
        || (Math.abs(dx) > Math.abs(dy) * 1.25 && Math.abs(dx) >= SWIPE_MIN_PX);
      if (!horizontalIntent) return;
      if (dx < 0) tryNavigate(1);
      else tryNavigate(-1);
    };

    const onPanMove = (dx, dy) => {
      if (!swipe.active) return;
      if (!swipe.locked) {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (ax < 12 && ay < 12) return;
        if (ay > ax * 1.25) {
          swipe.locked = 'vertical';
          return;
        }
        if (ax > ay * 1.25 && ax > 18) swipe.locked = 'horizontal';
      }
    };

    const onPanStart = (clientX, clientY, target) => {
      if (document.body.classList.contains('agenda-calendar-settings-open')) return;
      if (document.body.classList.contains('agenda-editor-open')) return;
      if (pane.hidden) return;
      if (agendaSwipeBlockedTarget(target)) {
        swipe.active = false;
        return;
      }
      swipe = {
        active: true,
        x: clientX,
        y: clientY,
        t: Date.now(),
        locked: '',
      };
    };

    pane.addEventListener(
      'touchstart',
      (ev) => {
        if (!ev.touches || ev.touches.length !== 1) return;
        const t = ev.touches[0];
        const el = document.elementFromPoint(t.clientX, t.clientY);
        onPanStart(t.clientX, t.clientY, el);
      },
      { passive: true },
    );

    pane.addEventListener(
      'touchmove',
      (ev) => {
        if (!swipe.active || !ev.touches || ev.touches.length !== 1) return;
        const t = ev.touches[0];
        onPanMove(t.clientX - swipe.x, t.clientY - swipe.y);
      },
      { passive: true },
    );

    pane.addEventListener(
      'touchend',
      (ev) => {
        if (!swipe.active) return;
        const changed = ev.changedTouches && ev.changedTouches[0];
        if (!changed) {
          swipe.active = false;
          return;
        }
        const locked = swipe.locked;
        finishPan(swipe.x, swipe.y, swipe.t, changed.clientX, changed.clientY, locked);
        swipe.active = false;
        swipe.locked = '';
      },
      { passive: true },
    );

    pane.addEventListener(
      'pointerdown',
      (ev) => {
        if (ev.pointerType === 'touch') return;
        if (!ev.isPrimary) return;
        onPanStart(ev.clientX, ev.clientY, ev.target);
        swipe.pointerId = ev.pointerId;
      },
      { passive: true },
    );

    pane.addEventListener(
      'pointermove',
      (ev) => {
        if (!swipe.active || ev.pointerId !== swipe.pointerId) return;
        if (ev.pointerType === 'touch') return;
        onPanMove(ev.clientX - swipe.x, ev.clientY - swipe.y);
      },
      { passive: true },
    );

    pane.addEventListener(
      'pointerup',
      (ev) => {
        if (!swipe.active || ev.pointerId !== swipe.pointerId) return;
        if (ev.pointerType === 'touch') return;
        const locked = swipe.locked;
        finishPan(swipe.x, swipe.y, swipe.t, ev.clientX, ev.clientY, locked);
        swipe.active = false;
        swipe.locked = '';
        swipe.pointerId = undefined;
      },
      { passive: true },
    );

    pane.addEventListener(
      'pointercancel',
      () => {
        swipe.active = false;
        swipe.locked = '';
        swipe.pointerId = undefined;
      },
      { passive: true },
    );

    pane.addEventListener(
      'wheel',
      (ev) => {
        if (pane.hidden) return;
        if (agendaSwipeBlockedTarget(ev.target)) return;
        if (Math.abs(ev.deltaX) < WHEEL_NAV_MIN_DX) return;
        if (Math.abs(ev.deltaX) < Math.abs(ev.deltaY) * 1.1) return;
        if (ev.deltaX < 0) tryNavigate(1);
        else tryNavigate(-1);
        ev.preventDefault();
      },
      { passive: false },
    );
  }

  function buildOccurrences(rangeStart, rangeEnd) {
    const events = filterEvents(state.search, listAgendaEvents());
    const occ = [];
    for (const ev of events) {
      occ.push(...expandEventOccurrences(ev, rangeStart, rangeEnd));
    }
    return occ;
  }

  function titleForNav(range) {
    if (state.view === 'month') {
      return { primary: monthTitle(state.anchor), week: '' };
    }
    if (state.view === 'agenda') {
      return { primary: `List · ${monthTitle(state.anchor)}`, week: '' };
    }
    if (state.view === 'day') {
      return { primary: formatShortDate(state.anchor), week: '' };
    }
    return {
      primary: formatRangeTitle(range.days),
      week: `Week ${isoWeekNumber(range.start)}`,
    };
  }

  function renderTitleHtml(range) {
    const t = titleForNav(range);
    if (t.week) {
      return (
        `<h1 class="agenda-title">`
        + `<span class="agenda-title-primary">${esc(t.primary)}</span>`
        + `<span class="agenda-title-week muted">${esc(t.week)}</span>`
        + '</h1>'
      );
    }
    return `<h1 class="agenda-title"><span class="agenda-title-primary">${esc(t.primary)}</span></h1>`;
  }

  function renderSearchField() {
    return (
      '<label class="agenda-search-field">'
      + '<svg class="agenda-search-ico" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="M16 16l5 5"/></svg>'
      + `<input type="search" id="agenda-search" placeholder="Search" aria-label="Search events" value="${esc(state.search)}" autocomplete="off" />`
      + '</label>'
    );
  }

  function closePhoneMenu() {
    document.body.classList.remove('agenda-phone-menu-open');
    const backdrop = rootEl?.querySelector?.('#agenda-phone-menu-backdrop');
    const btn = rootEl?.querySelector?.('#agenda-phone-more');
    if (backdrop) backdrop.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function togglePhoneMenu(force) {
    const open = typeof force === 'boolean'
      ? force
      : !document.body.classList.contains('agenda-phone-menu-open');
    document.body.classList.toggle('agenda-phone-menu-open', open);
    const backdrop = rootEl?.querySelector?.('#agenda-phone-menu-backdrop');
    const btn = rootEl?.querySelector?.('#agenda-phone-more');
    if (backdrop) backdrop.hidden = !open;
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function syncAgendaFab() {
    const fab = document.getElementById('agenda-fab-add');
    const pane = document.getElementById('agenda-pane');
    if (!fab) return;
    const visible = !!(pane && !pane.hidden && isAgendaPhoneLayout());
    fab.hidden = !visible;
  }

  function wireAgendaFabOnce() {
    if (agendaFabWired) return;
    const fab = document.getElementById('agenda-fab-add');
    if (!fab) return;
    agendaFabWired = true;
    fab.addEventListener('click', (ev) => {
      const btn = ev.currentTarget;
      rememberEditorReturnFocus(btn instanceof HTMLElement ? btn : null, '', 0);
      openEditor(null);
    });
  }

  function renderDesktopHeader(range) {
    return (
      '<header class="agenda-top agenda-top-desktop">'
      + '<div class="agenda-top-row">'
      + '<div class="agenda-nav">'
      + '<button type="button" class="btn icon agenda-icon-btn" id="agenda-prev" aria-label="Previous">‹</button>'
      + '<button type="button" class="btn icon agenda-icon-btn" id="agenda-next" aria-label="Next">›</button>'
      + renderTitleHtml(range)
      + '<button type="button" class="btn sm agenda-today" id="agenda-today">Today</button>'
      + '</div>'
      + '<div class="agenda-seg-wrap" role="group" aria-label="View">'
      + renderViewToggles()
      + '</div>'
      + '<div class="agenda-top-tools">'
      + renderSearchField()
      + '<button type="button" class="btn sm ghost agenda-calendar-menu-btn" id="agenda-calendar-settings-btn" aria-expanded="false" aria-controls="agenda-calendar-settings">Calendar menu</button>'
      + '<button type="button" class="btn primary agenda-add" id="agenda-add-event">+ Event</button>'
      + '</div></div></header>'
    );
  }

  function renderPhoneMenuPanel() {
    return (
      '<div id="agenda-phone-menu-backdrop" class="agenda-phone-menu-backdrop" hidden aria-hidden="true"></div>'
      + '<div id="agenda-phone-menu" class="agenda-phone-menu" role="dialog" aria-label="Agenda menu" aria-modal="true">'
      + renderSearchField()
      + '<div class="agenda-seg-wrap" role="group" aria-label="View">' + renderViewToggles() + '</div>'
      + '<button type="button" class="btn sm ghost agenda-calendar-menu-btn" id="agenda-calendar-settings-btn" aria-expanded="false" aria-controls="agenda-calendar-settings">Calendar menu</button>'
      + '<button type="button" class="btn primary agenda-cal-action" id="agenda-phone-import">Import calendar (.ics)</button>'
      + '<button type="button" class="btn ghost agenda-cal-action" id="agenda-phone-export">Export calendar (.ics)</button>'
      + '</div>'
    );
  }

  function renderPhoneHeader(range) {
    const menuOpen = document.body.classList.contains('agenda-phone-menu-open');
    return (
      '<header class="agenda-top agenda-top-phone">'
      + '<div class="agenda-top-row-phone">'
      + renderTitleHtml(range)
      + '<button type="button" class="btn sm agenda-today" id="agenda-today">Today</button>'
      + `<button type="button" class="btn icon agenda-icon-btn agenda-phone-more" id="agenda-phone-more" aria-label="Agenda menu" aria-expanded="${menuOpen ? 'true' : 'false'}" aria-controls="agenda-phone-menu">⋯</button>`
      + '</div></header>'
      + renderPhoneMenuPanel()
    );
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderViewToggles() {
    const views = [
      { id: 'month', label: 'Month' },
      { id: 'week', label: 'Week' },
      { id: '3day', label: '3 day' },
      { id: 'day', label: 'Day' },
      { id: 'agenda', label: 'List' },
    ];
    return views.map((v) => (
      `<button type="button" class="agenda-seg ${state.view === v.id ? 'is-active' : ''}" data-agenda-view="${esc(v.id)}">${esc(v.label)}</button>`
    )).join('');
  }

  function renderTimedGrid(days, occ) {
    const hours = [];
    for (let h = 0; h < 24; h += 1) hours.push(h);

    const now = new Date();
    const todayStart = startOfDay(now);
    const minutesNow = (now - todayStart) / 60000;

    const allDayOcc = occ.filter((o) => o.ev.all_day);

    let body = '';
    body += '<div class="agenda-allday-row">';
    body += '<div class="agenda-allday-label muted">all day</div>';
    const allDayLanes = layoutAllDayLanes(allDayOcc, days);
    const laneCount = Math.max(1, allDayLanes.reduce((m, p) => Math.max(m, p.lane + 1), 0));
    body += `<div class="agenda-allday-grid" style="--agenda-cols:${days.length};--agenda-allday-lanes:${laneCount}">`;
    allDayLanes.forEach(({ o, i0, span, lane }) => {
      const clr = eventAccentColor(o.ev);
      const rec = o.recurring || (o.ev.rrule && String(o.ev.rrule).trim());
      const title = rec
        ? `<span class="agenda-chip-title">${'<span class="agenda-rec-glyph" aria-hidden="true">↻</span>'}${esc(occDisplayTitle(o))}</span>`
        : `<span class="agenda-chip-title">${esc(occDisplayTitle(o))}</span>`;
      body += (
        `<button type="button" class="agenda-allday-chip" data-agenda-id="${esc(o.ev.id)}"${occurrenceChipAttrs(o)} style="grid-column:${i0 + 1} / span ${span};grid-row:${lane + 1}" title="${esc(occDisplayTitle(o))}">`
        + title
        + `<span class="agenda-chip-accent" style="background:${clr}"></span>`
        + '</button>'
      );
    });
    body += '</div>';
    body += '</div>';

    body += '<div class="agenda-scroll-wrap"><div class="agenda-time-grid">';
    body += '<div class="agenda-time-rail">';
    hours.forEach((h) => {
      body += `<div class="agenda-time-tick" style="height:${PX_PER_HOUR}px"><span>${pad2(h)}:00</span></div>`;
    });
    body += '</div>';

    body += `<div class="agenda-day-cols" style="--agenda-cols:${days.length}">`;
    days.forEach((day) => {
      const ds = startOfDay(day);
      const de = addDays(ds, 1);
      const isToday = ds.getTime() === todayStart.getTime();
      const dayOcc = occ.filter((o) => !o.ev.all_day && o.end > ds && o.start < de);
      const laid = layoutDayColumns(dayOcc, ds);

      body += `<div class="agenda-day-col" data-agenda-day="${ds.getTime()}">`;
      body += '<div class="agenda-hour-layer">';
      hours.forEach(() => {
        body += `<div class="agenda-hour-cell" style="height:${PX_PER_HOUR}px"></div>`;
      });
      if (isToday) {
        const top = (minutesNow / 60) * PX_PER_HOUR;
        body += `<div class="agenda-now-line" style="top:${top}px"></div>`;
      }
      body += '</div>';

      laid.forEach((o) => {
        const top = ((o.a - ds) / 3600000) * PX_PER_HOUR;
        const h = Math.max(18, ((o.b - o.a) / 3600000) * PX_PER_HOUR);
        const clr = eventAccentColor(o.ev);
        const wPct = 100 / o.colCount;
        const leftPct = wPct * o.col;
        const rec = o.recurring || (o.ev.rrule && String(o.ev.rrule).trim());
        const timeRange = `${formatTime(o.a)} – ${formatTime(o.b)}`;
        const titleHtml = rec
          ? `<span class="agenda-chip-title">${'<span class="agenda-rec-glyph" aria-hidden="true">↻</span>'}${esc(occDisplayTitle(o))}</span>`
          : `<span class="agenda-chip-title">${esc(occDisplayTitle(o))}</span>`;
        const compact = h < 36;
        body += (
          `<button type="button" class="agenda-event-chip${compact ? ' is-compact' : ''}" data-agenda-id="${esc(o.ev.id)}"${occurrenceChipAttrs(o)} style="top:${top}px;height:${h}px;left:${leftPct}%;width:${wPct}%;--agenda-accent:${clr}">`
          + `<span class="agenda-chip-accent" style="background:${clr}"></span>`
          + '<span class="agenda-chip-body">'
          + titleHtml
          + (!compact ? `<span class="agenda-chip-time">${esc(timeRange)}</span>` : '')
          + '</span></button>'
        );
      });
      body += '</div>';
    });
    body += '</div></div></div>';

    return body;
  }

  function renderAgendaList(occ, range) {
    const rs = range && range.start ? range.start.getTime() : 0;
    const re = range && range.end ? range.end.getTime() : 0;
    const byDay = new Map();
    for (const o of occ) {
      const key = startOfDay(o.start).getTime();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(o);
    }
    const dayKeys = [...byDay.keys()].sort((a, b) => a - b);
    let html = `<div class="agenda-list-view" data-agenda-range-start="${rs}" data-agenda-range-end="${re}">`;
    if (!dayKeys.length) {
      html += `<p class="agenda-list-empty muted">${esc(listEmptyMessage())}</p>`;
      html += '</div>';
      return html;
    }
    dayKeys.forEach((key) => {
      const day = new Date(key);
      const items = sortOccForMonthDay(byDay.get(key));
      html += `<section class="agenda-list-day"><h2 class="agenda-list-day-head">${esc(listDayHeading(day))}</h2><ul class="agenda-list">`;
      items.forEach((o) => {
        const when = o.ev.all_day
          ? 'All day'
          : `${formatTime(o.start)}–${formatTime(o.end)}`;
        const loc = String(o.ev.location || '').trim();
        const rec = o.recurring || (o.ev.rrule && String(o.ev.rrule).trim());
        const title = rec
          ? `${'<span class="agenda-rec-glyph" aria-hidden="true">↻</span>'}${esc(occDisplayTitle(o))}`
          : esc(occDisplayTitle(o));
        html += (
          '<li class="agenda-list-item">'
          + `<button type="button" class="agenda-list-row" data-agenda-id="${esc(o.ev.id)}"${occurrenceChipAttrs(o)}>`
          + `<span class="agenda-list-when">${esc(when)}</span>`
          + '<span class="agenda-list-row-main">'
          + `<span class="agenda-list-title">${title}</span>`
          + (loc ? `<span class="agenda-list-loc muted">${esc(loc)}</span>` : '')
          + '</span></button></li>'
        );
      });
      html += '</ul></section>';
    });
    html += '</div>';
    return html;
  }

  function sortOccForMonthDay(dayOcc) {
    return [...dayOcc].sort((a, b) => {
      if (!!a.ev.all_day !== !!b.ev.all_day) return a.ev.all_day ? -1 : 1;
      return a.start - b.start;
    });
  }

  function monthWeekHasVisibleContent(days, occ, weekIndex, anchorMonth, anchorYear) {
    for (let c = 0; c < 7; c += 1) {
      const day = days[weekIndex * 7 + c];
      const ds = startOfDay(day);
      const de = addDays(ds, 1);
      const inMonth = day.getMonth() === anchorMonth && day.getFullYear() === anchorYear;
      const hasEvents = occ.some((o) => o.end > ds && o.start < de);
      if (inMonth || hasEvents) return true;
    }
    return false;
  }

  function renderMonthDayList(occ) {
    const pickMs = state.monthPickDay || startOfDay(new Date()).getTime();
    const pick = new Date(pickMs);
    const ds = startOfDay(pick);
    const de = addDays(ds, 1);
    const dayOcc = sortOccForMonthDay(occ.filter((o) => o.end > ds && o.start < de));
    let html = `<div class="agenda-month-daylist" data-agenda-month-pick="${ds.getTime()}">`;
    html += `<h2 class="agenda-month-daylist-title">${esc(pick.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>`;
    if (!dayOcc.length) {
      html += '<p class="muted agenda-month-daylist-empty">No events</p>';
    } else {
      html += '<ul class="agenda-list">';
      dayOcc.forEach((o) => {
        const tlabel = o.ev.all_day ? 'All day' : `${formatTime(o.start)} – ${formatTime(o.end)}`;
        html += (
          `<li><button type="button" class="agenda-list-row" data-agenda-id="${esc(o.ev.id)}"${occurrenceChipAttrs(o)}>`
          + `<span class="agenda-list-date">${esc(tlabel)}</span>`
          + `<span class="agenda-list-title">${esc(occDisplayTitle(o))}</span>`
          + '</button></li>'
        );
      });
      html += '</ul>';
    }
    html += '</div>';
    return html;
  }

  function renderMonthGrid(days, occ) {
    const phoneMonth = isAgendaPhoneLayout();
    let nWeeks = Math.ceil(days.length / 7);
    const anchorMonth = state.anchor.getMonth();
    const anchorYear = state.anchor.getFullYear();
    while (nWeeks > 1 && !monthWeekHasVisibleContent(days, occ, nWeeks - 1, anchorMonth, anchorYear)) {
      nWeeks -= 1;
    }
    const rs = startOfDay(days[0]).getTime();
    const re = addDays(startOfDay(days[days.length - 1]), 1).getTime();
    let html = `<div class="agenda-month-grid" data-agenda-range-start="${rs}" data-agenda-range-end="${re}">`;
    const weekRow = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    html += '<div class="agenda-month-head">';
    weekRow.forEach((w) => { html += `<div class="agenda-month-dow muted">${w}</div>`; });
    html += '</div>';
    const MAX_CHIPS = 3;
    for (let r = 0; r < nWeeks; r += 1) {
      html += '<div class="agenda-month-row">';
      for (let c = 0; c < 7; c += 1) {
        const day = days[r * 7 + c];
        const ds = startOfDay(day);
        const de = addDays(ds, 1);
        const inMonth = day.getMonth() === anchorMonth && day.getFullYear() === anchorYear;
        const dayOcc = occ.filter((o) => o.end > ds && o.start < de);
        const sorted = sortOccForMonthDay(dayOcc);
        const show = sorted.slice(0, MAX_CHIPS);
        const extra = sorted.length > MAX_CHIPS ? sorted.length - MAX_CHIPS : 0;
        const isToday = ds.getTime() === startOfDay(new Date()).getTime();
        const pickActive = state.monthPickDay === ds.getTime();
        html += `<div class="agenda-month-cell ${inMonth ? '' : 'is-out'} ${isToday ? 'is-today' : ''} ${pickActive ? 'is-pick' : ''}" data-agenda-month-day="${ds.getTime()}">`;
        html += `<div class="agenda-month-date">${day.getDate()}</div>`;
        html += '<div class="agenda-month-events">';
        if (phoneMonth) {
          sorted.forEach((o) => {
            const clr = eventAccentColor(o.ev);
            html += `<span class="agenda-month-dot" style="--agenda-dot:${clr}" title="${esc(occDisplayTitle(o))}"></span>`;
          });
        } else {
          show.forEach((o) => {
            const clr = eventAccentColor(o.ev);
            const rec = o.recurring || (o.ev.rrule && String(o.ev.rrule).trim());
            const tlabel = o.displayAllDay ?? o.ev.all_day ? 'All day' : formatTime(o.start);
            html += (
              `<button type="button" class="agenda-month-ev" data-agenda-id="${esc(o.ev.id)}"${occurrenceChipAttrs(o)} title="${esc(occDisplayTitle(o))}">`
              + `<span class="agenda-month-ev-accent" style="background:${clr}"></span>`
              + '<span class="agenda-month-ev-body">'
              + (rec ? '<span class="agenda-rec-glyph" aria-hidden="true">↻</span>' : '')
              + `<span class="agenda-month-ev-title">${esc(occDisplayTitle(o))}</span>`
              + `<span class="agenda-month-ev-time muted">${esc(tlabel)}</span>`
              + '</span></button>'
            );
          });
        }
        if (extra) {
          const aria = `Show all events for ${day.toLocaleDateString()}`;
          html += (
            `<button type="button" class="agenda-month-more-btn" data-agenda-goto-day="${ds.getTime()}" aria-label="${esc(aria)}">+${extra} more</button>`
          );
        }
        html += '</div></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderDayHeaders(days) {
    let html = '<div class="agenda-col-head">';
    html += '<div class="agenda-corner" aria-hidden="true"></div>';
    html += `<div class="agenda-col-head-cols" style="--agenda-cols:${days.length}">`;
    days.forEach((d) => {
      const isToday = startOfDay(d).getTime() === startOfDay(new Date()).getTime();
      html += (
        `<div class="agenda-col-head-cell ${isToday ? 'is-today' : ''}">`
        + `<span class="agenda-dow muted">${esc(shortWeekday(d))}</span>`
        + `<span class="agenda-dom">${d.getDate()}</span>`
        + '</div>'
      );
    });
    html += '</div></div>';
    return html;
  }

  function render() {
    if (!rootEl) return;
    const range = rangeForView();
    const occ = buildOccurrences(range.start, range.end);
    const days = range.days;

    let main = '';
    if (state.view === 'agenda') {
      main = renderAgendaList(occ, range);
    } else if (state.view === 'month') {
      main = renderMonthGrid(days, occ);
      if (isAgendaPhoneLayout()) main += renderMonthDayList(occ);
    } else {
      main = (
        '<div class="agenda-week-layout">'
        + renderDayHeaders(days)
        + renderTimedGrid(days, occ)
        + '</div>'
      );
    }

    const phone = isAgendaPhoneLayout();
    rootEl.classList.toggle('agenda-root--phone', phone);
    const header = phone ? renderPhoneHeader(range) : renderDesktopHeader(range);
    rootEl.innerHTML = (
      header
      + `<div class="agenda-body agenda-view-${esc(state.view)}">${main}</div>`
    );

    const prev = rootEl.querySelector('#agenda-prev');
    const next = rootEl.querySelector('#agenda-next');
    const todayB = rootEl.querySelector('#agenda-today');
    if (prev) prev.onclick = () => { shiftAnchor(-1); render(); };
    if (next) next.onclick = () => { shiftAnchor(1); render(); };
    if (todayB) todayB.onclick = () => { state.anchor = new Date(); render(); };

    rootEl.querySelectorAll('[data-agenda-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('data-agenda-view') || 'week';
        if (['day', '3day', 'week'].includes(state.view)) saveTimeGridScrollSnapshot();
        state.view = next;
        closePhoneMenu();
        try { sessionStorage.setItem('notes_agenda_view', state.view); } catch (e) { /* ignore */ }
        render();
      });
    });

    const search = rootEl.querySelector('#agenda-search');
    if (search) {
      search.addEventListener('input', () => {
        state.search = search.value || '';
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          searchDebounce = 0;
          render();
        }, 160);
      });
    }

    rootEl.querySelector('#agenda-add-event')?.addEventListener('click', (ev) => {
      const btn = ev.currentTarget;
      rememberEditorReturnFocus(btn instanceof HTMLElement ? btn : null, '', 0);
      openEditor(null);
    });
    rootEl.querySelector('#agenda-calendar-settings-btn')?.addEventListener('click', () => {
      closePhoneMenu();
      const open = document.body.classList.contains('agenda-calendar-settings-open');
      if (open) closeCalendarSettingsPanel();
      else openCalendarSettingsPanel();
    });
    rootEl.querySelector('#agenda-phone-more')?.addEventListener('click', () => {
      togglePhoneMenu();
    });
    rootEl.querySelector('#agenda-phone-menu-backdrop')?.addEventListener('click', () => {
      closePhoneMenu();
    });
    rootEl.querySelector('#agenda-phone-import')?.addEventListener('click', () => {
      closePhoneMenu();
      fileInput?.click();
    });
    rootEl.querySelector('#agenda-phone-export')?.addEventListener('click', () => {
      closePhoneMenu();
      exportAgendaToIcs();
    });
    rootEl.querySelectorAll('[data-agenda-month-day]').forEach((cell) => {
      cell.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-agenda-id], [data-agenda-goto-day]')) return;
        const raw = cell.getAttribute('data-agenda-month-day');
        const t = raw ? Number(raw) : NaN;
        if (!Number.isFinite(t)) return;
        state.monthPickDay = t;
        render();
      });
    });

    rootEl.querySelectorAll('[data-agenda-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-agenda-id');
        const rawMs = btn.getAttribute('data-agenda-occurrence-ms');
        const occurrenceMs = rawMs ? Number(rawMs) : 0;
        rememberEditorReturnFocus(btn, id, occurrenceMs);
        beginEditFromClick(id, occurrenceMs);
      });
    });

    rootEl.querySelectorAll('.agenda-day-col').forEach((col) => {
      col.addEventListener('dblclick', (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest('[data-agenda-id]')) return;
        if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) return;
        const raw = col.getAttribute('data-agenda-day');
        const dayMs = raw ? Number(raw) : NaN;
        if (!Number.isFinite(dayMs)) return;
        const rect = col.getBoundingClientRect();
        const y = ev.clientY - rect.top;
        const hourPx = PX_PER_HOUR;
        const minutes = Math.max(0, Math.min(24 * 60 - 30, Math.round(((y / hourPx) * 60) / 30) * 30));
        const start = new Date(dayMs);
        start.setHours(0, 0, 0, 0);
        start.setMinutes(minutes);
        const end = new Date(start.getTime() + 3600000);
        rememberEditorReturnFocus(null, '', 0);
        openEditor(null, { scope: 'series', draftStart: start, draftEnd: end });
      });
    });

    rootEl.querySelectorAll('[data-agenda-goto-day]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const raw = btn.getAttribute('data-agenda-goto-day');
        const t = raw ? Number(raw) : NaN;
        if (!Number.isFinite(t)) return;
        state.anchor = new Date(t);
        state.view = 'day';
        render();
      });
    });

    if (['day', '3day', 'week'].includes(state.view)) {
      wireTimeGridScrollPersistence(range);
      applyTimeGridScroll(range, occ);
    }
    syncAgendaFab();
    if (document.body.classList.contains('agenda-phone-menu-open')) {
      togglePhoneMenu(true);
    } else {
      closePhoneMenu();
    }
  }

  function addMonthsAnchor(d, n) {
    // Clip the day so 31 Jan + 1 month is 28/29 Feb, not 3 Mar.
    const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last), d.getHours(), d.getMinutes());
  }

  function shiftAnchor(dir) {
    const v = state.view;
    if (v === 'month') {
      state.anchor = addMonthsAnchor(state.anchor, dir);
      return;
    }
    if (v === 'agenda') {
      state.anchor = addDays(state.anchor, dir * 7);
      return;
    }
    const step = v === 'week' ? 7 : v === '3day' ? 3 : 1;
    state.anchor = addDays(state.anchor, dir * step);
  }

  function agendaRowToContent(row) {
    if (!row || row.type !== 'agenda_event') return defaultEvent();
    const { id: _drop, ...rest } = row;
    return { ...rest, type: 'agenda_event' };
  }

  function syncEditorDatetimeMode(allDay) {
    const startEl = document.getElementById('agenda-edit-start');
    const endEl = document.getElementById('agenda-edit-end');
    [startEl, endEl].forEach((el) => {
      if (!el) return;
      const was = el.value;
      if (allDay) {
        el.type = 'date';
        if (was && was.includes('T')) el.value = was.slice(0, 10);
      } else {
        el.type = 'datetime-local';
        if (was && /^\d{4}-\d{2}-\d{2}$/.test(was)) el.value = `${was}T09:00`;
      }
    });
  }

  function fillRecurrenceEditor(content) {
    const R = global.NotesAgendaRecurrence;
    const rrule = (content && content.rrule) || '';
    const exdates = (content && Array.isArray(content.ics_exdates)) ? content.ics_exdates : [];
    const sel = document.getElementById('agenda-edit-repeat');
    const untilEl = document.getElementById('agenda-edit-until');
    const status = document.getElementById('agenda-edit-rrule-status');
    const adv = document.getElementById('agenda-edit-rrule-advanced');
    const raw = document.getElementById('agenda-edit-rrule-raw');
    const exNote = document.getElementById('agenda-edit-exdates-note');
    const notice = document.getElementById('agenda-edit-series-notice');
    if (!R || !sel) return;
    const p = R.parseAgendaRrule(rrule);
    sel.value = p.kind;
    if (untilEl) untilEl.value = p.until ? R.toDateInputValue(p.until) : '';
    const showAdv = p.kind === 'advanced' && !!p.raw;
    if (adv) adv.hidden = !showAdv;
    if (raw) raw.textContent = showAdv ? p.raw : '';
    if (status) {
      if (p.kind === 'weekly') status.textContent = 'Repeats every week.';
      else if (p.kind === 'biweekly') status.textContent = 'Repeats every 2 weeks.';
      else if (p.kind === 'advanced') status.textContent = 'Imported/custom rule — preserved unless you choose a pattern above.';
      else status.textContent = '';
    }
    if (notice) notice.hidden = !String(rrule || '').trim();
    if (exNote) {
      const n = exdates.filter(Boolean).length;
      if (p.kind === 'advanced' && n > 0) {
        exNote.hidden = false;
        exNote.textContent = `${n} imported EXDATE exclusion(s) preserved on save/export.`;
      } else {
        exNote.hidden = true;
        exNote.textContent = '';
      }
    }
  }

  function readRecurrenceForSave(prevRrule) {
    const R = global.NotesAgendaRecurrence;
    const sel = document.getElementById('agenda-edit-repeat');
    const untilEl = document.getElementById('agenda-edit-until');
    if (!R || !sel) return String(prevRrule || '');
    const kind = sel.value;
    if (kind === 'advanced') return String(prevRrule || '').trim();
    if (kind === 'none') return '';
    const untilD = untilEl && untilEl.value
      ? new Date(`${untilEl.value}T12:00:00`)
      : null;
    return R.buildAgendaRrule(kind, untilD) || '';
  }

  function updateRecurrenceStatus() {
    const sel = document.getElementById('agenda-edit-repeat');
    const status = document.getElementById('agenda-edit-rrule-status');
    const adv = document.getElementById('agenda-edit-rrule-advanced');
    if (!sel || !status) return;
    const kind = sel.value;
    if (kind === 'weekly') status.textContent = 'Repeats every week.';
    else if (kind === 'biweekly') status.textContent = 'Repeats every 2 weeks.';
    else if (kind === 'advanced') status.textContent = 'Custom rule kept from import.';
    else status.textContent = '';
    if (adv) adv.hidden = kind !== 'advanced';
  }

  function cssAttrEscape(value) {
    const s = String(value || '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function rememberEditorReturnFocus(fromEl, id, occurrenceMs) {
    if (fromEl instanceof HTMLElement) editorReturnFocus = fromEl;
    state.editorReturnFocusId = String(id || '');
    state.editorReturnFocusOccurrenceMs = Number.isFinite(Number(occurrenceMs)) ? Number(occurrenceMs) : 0;
  }

  function queryEditorReturnFocusChip() {
    const id = state.editorReturnFocusId;
    if (!id) return null;
    const root = rootEl || document.getElementById('agenda-root');
    if (!root) return null;
    const escId = cssAttrEscape(id);
    const ms = state.editorReturnFocusOccurrenceMs;
    let chip = null;
    if (ms > 0) {
      chip = root.querySelector(`[data-agenda-id="${escId}"][data-agenda-occurrence-ms="${ms}"]`);
    }
    if (!chip) chip = root.querySelector(`[data-agenda-id="${escId}"]`);
    return chip instanceof HTMLElement ? chip : null;
  }

  function focusEditorReturnTarget() {
    const chip = queryEditorReturnFocusChip();
    const el = chip
      || (editorReturnFocus && editorReturnFocus.isConnected ? editorReturnFocus : null)
      || (rootEl && rootEl.querySelector('.agenda-add'))
      || document.querySelector('.agenda-add');
    editorReturnFocus = null;
    state.editorReturnFocusId = '';
    state.editorReturnFocusOccurrenceMs = 0;
    if (el instanceof HTMLElement) el.focus({ preventScroll: false });
  }

  let detailContext = { id: '', occurrenceMs: 0 };

  function closeDetailCard() {
    const backdrop = document.getElementById('agenda-detail-backdrop');
    const card = document.getElementById('agenda-detail-card');
    if (backdrop) backdrop.hidden = true;
    if (card) card.hidden = true;
    document.body.classList.remove('agenda-detail-open');
    detailContext = { id: '', occurrenceMs: 0 };
  }

  function findOccurrenceForDetail(ev, occurrenceMs) {
    if (!ev || !(occurrenceMs > 0)) return null;
    const anchor = new Date(occurrenceMs);
    const rangeStart = addDays(startOfDay(anchor), -1);
    const rangeEnd = addDays(startOfDay(anchor), 60);
    const hits = expandEventOccurrences(ev, rangeStart, rangeEnd);
    return hits.find((o) => {
      const ser = o.seriesInstanceStart || o.start;
      return ser.getTime() === occurrenceMs || o.start.getTime() === occurrenceMs;
    }) || null;
  }

  function openDetailCard(id, occurrenceMs) {
    const ev = (listAgendaEvents() || []).find((e) => e.id === id);
    if (!ev) return;
    const occ = findOccurrenceForDetail(ev, occurrenceMs);
    const start = occ ? occ.start : (occurrenceMs > 0 ? new Date(occurrenceMs) : parseInstant(ev.start));
    const end = occ ? occ.end : parseInstant(ev.end);
    const titleEl = document.getElementById('agenda-detail-title');
    const when = document.getElementById('agenda-detail-when');
    const loc = document.getElementById('agenda-detail-location');
    const notes = document.getElementById('agenda-detail-notes');
    const backdrop = document.getElementById('agenda-detail-backdrop');
    const card = document.getElementById('agenda-detail-card');
    const displayTitle = occ ? occDisplayTitle(occ) : (ev.title || 'Event');
    const allDay = occ ? (occ.displayAllDay ?? !!occ.ev.all_day) : !!ev.all_day;
    if (titleEl) titleEl.textContent = displayTitle;
    if (when) {
      when.textContent = allDay
        ? 'All day'
        : `${formatTime(start)} – ${formatTime(end)}`;
    }
    const locText = String(ev.location || '').trim();
    if (loc) {
      loc.hidden = !locText;
      loc.textContent = locText;
    }
    const noteText = String(ev.notes || '').trim();
    if (notes) {
      notes.hidden = !noteText;
      notes.textContent = noteText;
    }
    detailContext = { id, occurrenceMs: occurrenceMs || 0 };
    if (backdrop) backdrop.hidden = false;
    if (card) card.hidden = false;
    document.body.classList.add('agenda-detail-open');
  }

  function beginEditFromClick(id, occurrenceMs) {
    if (!id) {
      openEditor(null, { scope: 'series' });
      return;
    }
    const useDetail = typeof window !== 'undefined'
      && window.matchMedia('(min-width: 769px)').matches;
    if (useDetail) {
      openDetailCard(id, occurrenceMs);
      return;
    }
    const ev = (listAgendaEvents() || []).find((e) => e.id === id);
    const Occ = global.NotesAgendaOccurrence;
    const hasRrule = ev && String(ev.rrule || '').trim();
    const occOk = Occ && Occ.supportsOccurrenceEdit(ev && ev.rrule)
      && Number.isFinite(occurrenceMs) && occurrenceMs > 0;
    if (hasRrule && occOk) {
      state.pendingEditor = { id, occurrenceMs };
      openScopeChooser(ev);
      return;
    }
    openEditor(id, { scope: 'series' });
  }

  function continueEditFromDetail() {
    const { id, occurrenceMs } = detailContext;
    closeDetailCard();
    if (!id) return;
    const ev = (listAgendaEvents() || []).find((e) => e.id === id);
    const Occ = global.NotesAgendaOccurrence;
    const hasRrule = ev && String(ev.rrule || '').trim();
    const occOk = Occ && Occ.supportsOccurrenceEdit(ev && ev.rrule)
      && Number.isFinite(occurrenceMs) && occurrenceMs > 0;
    if (hasRrule && occOk) {
      state.pendingEditor = { id, occurrenceMs };
      openScopeChooser(ev);
      return;
    }
    openEditor(id, { scope: 'series', occurrenceMs });
  }

  function setScopeChooserMode(mode) {
    const pick = document.getElementById('agenda-scope-pick-panel');
    const reset = document.getElementById('agenda-scope-reset-panel');
    const heading = document.getElementById('agenda-scope-heading');
    if (pick) pick.hidden = mode === 'reset';
    if (reset) reset.hidden = mode !== 'reset';
    if (heading) {
      heading.textContent = mode === 'reset' ? 'Save series changes' : 'Edit recurring event';
    }
  }

  function closeScopeChooser({ restoreFocus = true } = {}) {
    const backdrop = document.getElementById('agenda-scope-backdrop');
    const dialog = document.getElementById('agenda-scope-chooser');
    if (backdrop) backdrop.hidden = true;
    if (dialog) dialog.hidden = true;
    document.body.classList.remove('agenda-scope-open');
    state.pendingEditor = null;
    state.seriesOverrideResetConfirmed = false;
    setScopeChooserMode('pick');
    if (restoreFocus) focusEditorReturnTarget();
  }

  function openScopeChooser(ev) {
    const backdrop = document.getElementById('agenda-scope-backdrop');
    const dialog = document.getElementById('agenda-scope-chooser');
    const title = document.getElementById('agenda-scope-title');
    const adv = document.getElementById('agenda-scope-advanced-note');
    const customHint = document.getElementById('agenda-scope-customized-hint');
    if (!backdrop || !dialog) {
      const pending = state.pendingEditor;
      state.pendingEditor = null;
      if (pending) openEditor(pending.id, { scope: 'series', occurrenceMs: pending.occurrenceMs });
      return;
    }
    setScopeChooserMode('pick');
    if (title) title.textContent = ev && ev.title ? `“${ev.title}”` : 'This event';
    const Occ = global.NotesAgendaOccurrence;
    const occBtn = document.querySelector('[data-agenda-edit-scope="occurrence"]');
    const occSupported = !!(Occ && Occ.supportsOccurrenceEdit(ev && ev.rrule));
    if (occBtn) occBtn.hidden = !occSupported;
    if (adv) adv.hidden = occSupported;
    const customN = Occ && typeof Occ.countCustomizedOverrides === 'function'
      ? Occ.countCustomizedOverrides(ev && ev.ics_occurrence_overrides, ev)
      : 0;
    if (customHint) {
      if (customN > 0) {
        customHint.hidden = false;
        customHint.textContent = customN === 1
          ? 'This series has 1 customized occurrence.'
          : `This series has ${customN} customized occurrences.`;
      } else {
        customHint.hidden = true;
        customHint.textContent = '';
      }
    }
    backdrop.hidden = false;
    dialog.hidden = false;
    document.body.classList.add('agenda-scope-open');
  }

  function openScopeChooserSeriesReset(resetCount) {
    const backdrop = document.getElementById('agenda-scope-backdrop');
    const dialog = document.getElementById('agenda-scope-chooser');
    const msg = document.getElementById('agenda-scope-reset-message');
    const Occ = global.NotesAgendaOccurrence;
    if (!backdrop || !dialog || !Occ) return false;
    const text = typeof Occ.seriesOverrideResetMessage === 'function'
      ? Occ.seriesOverrideResetMessage(resetCount)
      : '';
    if (!text) return false;
    setScopeChooserMode('reset');
    if (msg) msg.textContent = text;
    backdrop.hidden = false;
    dialog.hidden = false;
    document.body.classList.add('agenda-scope-open');
    return true;
  }

  function wireScopeChooser() {
    if (wireScopeChooser._done) return;
    wireScopeChooser._done = true;
    document.getElementById('agenda-scope-cancel')?.addEventListener('click', () => closeScopeChooser());
    document.getElementById('agenda-scope-reset-cancel')?.addEventListener('click', () => {
      setScopeChooserMode('pick');
      const backdrop = document.getElementById('agenda-scope-backdrop');
      const dialog = document.getElementById('agenda-scope-chooser');
      if (backdrop) backdrop.hidden = true;
      if (dialog) dialog.hidden = true;
      document.body.classList.remove('agenda-scope-open');
      state.seriesOverrideResetConfirmed = false;
      setScopeChooserMode('pick');
      const saveBtn = document.getElementById('agenda-edit-save');
      if (saveBtn) saveBtn.focus();
    });
    document.getElementById('agenda-scope-reset-confirm')?.addEventListener('click', () => {
      state.seriesOverrideResetConfirmed = true;
      setScopeChooserMode('pick');
      const backdrop = document.getElementById('agenda-scope-backdrop');
      const dialog = document.getElementById('agenda-scope-chooser');
      if (backdrop) backdrop.hidden = true;
      if (dialog) dialog.hidden = true;
      document.body.classList.remove('agenda-scope-open');
      saveEditor();
    });
    document.getElementById('agenda-scope-backdrop')?.addEventListener('click', () => {
      const resetPanel = document.getElementById('agenda-scope-reset-panel');
      if (resetPanel && !resetPanel.hidden) {
        setScopeChooserMode('pick');
      }
      closeScopeChooser();
    });
    document.querySelectorAll('[data-agenda-edit-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pending = state.pendingEditor;
        if (!pending) return closeScopeChooser();
        const scope = btn.getAttribute('data-agenda-edit-scope') || 'series';
        closeScopeChooser({ restoreFocus: false });
        openEditor(pending.id, { scope, occurrenceMs: pending.occurrenceMs });
      });
    });
  }

  function seriesNoticeForEditor(scope, rrule) {
    const hasRrule = Boolean(String(rrule || '').trim());
    if (!hasRrule) {
      return { hidden: true, text: '' };
    }
    if (scope === 'occurrence') {
      return {
        hidden: false,
        text: 'Editing this occurrence only. Other dates in the series stay unchanged.',
      };
    }
    return {
      hidden: false,
      text: 'Changes apply to the entire recurring series.',
    };
  }

  function applyEditorScopeUi(scope, rrule) {
    const isOcc = scope === 'occurrence';
    const notice = document.getElementById('agenda-edit-series-notice');
    const recur = document.querySelector('#agenda-editor .agenda-editor-recurrence');
    const del = document.getElementById('agenda-edit-delete');
    const heading = document.getElementById('agenda-edit-visible-title');
    const seriesNotice = seriesNoticeForEditor(scope, rrule);
    if (notice) {
      notice.hidden = seriesNotice.hidden;
      notice.textContent = seriesNotice.text;
    }
    if (recur) recur.hidden = isOcc;
    if (del) del.textContent = isOcc ? 'Delete occurrence' : 'Delete';
    if (heading) heading.textContent = isOcc ? 'Edit occurrence' : 'Event';
  }

  function openEditor(id, opts) {
    const S = getStore();
    if (!S || typeof S.get !== 'function') return;
    let existing = id ? S.get(id) : null;
    if (!existing && id && typeof S.listAgendaEvents === 'function') {
      const ev = (listAgendaEvents() || []).find((e) => e.id === id);
      if (ev) {
        existing = { uuid: id, content: agendaRowToContent(ev) };
      }
    }
    const options = opts && typeof opts === 'object' ? opts : {};
    const content = existing && existing.content?.type === 'agenda_event'
      ? existing.content
      : defaultEvent();
    state.selectedId = existing ? existing.uuid : id || '';
    const scope = options.scope === 'occurrence' ? 'occurrence' : 'series';
    state.editorScope = scope;
    const occMs = Number(options.occurrenceMs) || 0;
    state.editorOccurrenceStartMs = scope === 'occurrence' ? occMs : 0;
    wireScopeChooser();

    const backdrop = document.getElementById('agenda-editor-backdrop');
    const dialog = document.getElementById('agenda-editor');
    if (!backdrop || !dialog) return;

    const titleEl = document.getElementById('agenda-edit-title');
    const locEl = document.getElementById('agenda-edit-location');
    const startEl = document.getElementById('agenda-edit-start');
    const endEl = document.getElementById('agenda-edit-end');
    const allDayEl = document.getElementById('agenda-edit-allday');
    const webcallEl = document.getElementById('agenda-edit-webcall');
    const notesEl = document.getElementById('agenda-edit-notes');
    const attEl = document.getElementById('agenda-edit-attendees');
    const joinEl = document.getElementById('agenda-edit-join');

    let s = parseInstant(content.start) || new Date();
    let endParsed = parseInstant(content.end);
    let e = endParsed || new Date(s.getTime() + 3600000);
    const Occ = global.NotesAgendaOccurrence;
    let overlay = null;
    if (scope === 'occurrence' && occMs > 0 && Occ) {
      const seriesStart = new Date(occMs);
      const rid = Occ.recurrenceIdForStart(seriesStart, content.all_day);
      overlay = (content.ics_occurrence_overrides && content.ics_occurrence_overrides[rid]) || null;
      const masterS = parseInstant(content.start) || seriesStart;
      const masterE = parseInstant(content.end) || new Date(masterS.getTime() + 3600000);
      const dur = masterE.getTime() - masterS.getTime();
      s = overlay && overlay.start ? (parseInstant(overlay.start) || seriesStart) : seriesStart;
      e = overlay && overlay.end ? (parseInstant(overlay.end) || new Date(s.getTime() + dur)) : new Date(s.getTime() + dur);
    }
    if (!id && options.draftStart instanceof Date) {
      s = options.draftStart;
      e = options.draftEnd instanceof Date ? options.draftEnd : new Date(s.getTime() + 3600000);
    }
    if (titleEl) {
      titleEl.value = (scope === 'occurrence' && overlay && overlay.title)
        ? overlay.title
        : (content.title || '');
    }
    if (locEl) {
      locEl.value = (scope === 'occurrence' && overlay && overlay.location != null)
        ? overlay.location
        : (content.location || '');
    }
    const allDay = (scope === 'occurrence' && overlay && typeof overlay.all_day === 'boolean')
      ? overlay.all_day
      : !!content.all_day;
    if (allDayEl) allDayEl.checked = allDay;
    syncEditorDatetimeMode(allDay);
    if (allDay) {
      const ds = startOfDay(s);
      let lastInclusive = ds;
      if (e.getTime() > ds.getTime() + MS_DAY) {
        lastInclusive = addDays(startOfDay(e), -1);
      }
      if (startEl) {
        startEl.value = `${ds.getFullYear()}-${pad2(ds.getMonth() + 1)}-${pad2(ds.getDate())}`;
      }
      if (endEl) {
        endEl.value = `${lastInclusive.getFullYear()}-${pad2(lastInclusive.getMonth() + 1)}-${pad2(lastInclusive.getDate())}`;
      }
    } else {
      if (startEl) startEl.value = toDatetimeLocal(s);
      if (endEl) endEl.value = toDatetimeLocal(e);
    }
    if (scope === 'series') fillRecurrenceEditor(content);
    else fillRecurrenceEditor({ ...content, rrule: content.rrule || '' });
    if (webcallEl) webcallEl.value = content.webcall_url || '';
    if (notesEl) {
      notesEl.value = (scope === 'occurrence' && overlay && overlay.notes != null)
        ? overlay.notes
        : (content.notes || '');
    }
    if (attEl) attEl.value = (content.attendees || []).join(', ');

    const wc = (global.NotesAgendaIcs && NotesAgendaIcs.sanitizeHttpsUrl)
      ? NotesAgendaIcs.sanitizeHttpsUrl(content.webcall_url || '')
      : (String(content.webcall_url || '').startsWith('https://') ? content.webcall_url : '');
    const descHint = (!wc && notesEl)
      ? NotesAgendaIcs.extractHttpsFromText(notesEl.value || '')
      : '';
    const joinHref = wc || descHint;
    if (joinEl) {
      if (joinHref) {
        joinEl.hidden = false;
        joinEl.innerHTML = `Meeting link: <a href="${esc(joinHref)}" target="_blank" rel="noopener noreferrer">${esc(joinHref)}</a>`;
      } else {
        joinEl.hidden = true;
        joinEl.textContent = '';
      }
    }

    document.getElementById('agenda-edit-delete')?.toggleAttribute('hidden', !state.selectedId);
    state.editorColor = eventAccentColor({ id: state.selectedId || 'new', color: content.color });
    renderColorSwatches(state.editorColor);
    applyEditorScopeUi(scope, content.rrule || '');

    if (!editorReturnFocus) {
      const ae = document.activeElement;
      if (ae instanceof HTMLElement) editorReturnFocus = ae;
    }
    backdrop.hidden = false;
    dialog.hidden = false;
    document.body.classList.add('agenda-editor-open');
    if (titleEl) {
      requestAnimationFrame(() => {
        titleEl.focus({ preventScroll: true });
      });
    }
  }

  function toDatetimeLocal(d) {
    const x = new Date(d);
    return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}T${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
  }

  function fromDatetimeLocal(s) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : new Date();
  }

  function defaultEvent() {
    const s = new Date();
    s.setMinutes(0, 0, 0);
    const e = new Date(s.getTime() + 3600000);
    return {
      type: 'agenda_event',
      version: 1,
      title: 'Team sync',
      location: '',
      notes: '',
      webcall_url: '',
      attendees: [],
      color: '',
      start: s.toISOString(),
      end: e.toISOString(),
      all_day: false,
      rrule: '',
      ical_uid: '',
      ics_exdates: [],
      ics_occurrence_overrides: {},
    };
  }

  function flattenEventsForIcsExport(rows) {
    const out = [];
    for (const ev of rows || []) {
      out.push(ev);
      const overrides = ev.ics_occurrence_overrides;
      if (!overrides || typeof overrides !== 'object') continue;
      Object.keys(overrides).forEach((rid) => {
        const ov = overrides[rid];
        if (!ov || ov.cancelled) return;
        out.push({
          ...ev,
          rrule: '',
          ics_exdates: [],
          ics_occurrence_overrides: {},
          ics_recurrence_id: rid,
          title: ov.title || ev.title,
          location: ov.location != null ? ov.location : ev.location,
          notes: ov.notes != null ? ov.notes : ev.notes,
          start: ov.start || ev.start,
          end: ov.end || ev.end,
          all_day: typeof ov.all_day === 'boolean' ? ov.all_day : ev.all_day,
        });
      });
    }
    return out;
  }

  function closeEditor() {
    const backdrop = document.getElementById('agenda-editor-backdrop');
    const dialog = document.getElementById('agenda-editor');
    if (backdrop) backdrop.hidden = true;
    if (dialog) dialog.hidden = true;
    document.body.classList.remove('agenda-editor-open');
    state.editorScope = 'series';
    state.editorOccurrenceStartMs = 0;
    focusEditorReturnTarget();
  }

  function handleEscapeKey(ev) {
    if (!ev || ev.key !== 'Escape') return false;
    if (document.body.classList.contains('agenda-phone-menu-open')) {
      ev.preventDefault();
      ev.stopPropagation();
      closePhoneMenu();
      return true;
    }
    const scopeDialog = document.getElementById('agenda-scope-chooser');
    if (scopeDialog && !scopeDialog.hidden) {
      ev.preventDefault();
      ev.stopPropagation();
      closeScopeChooser();
      return true;
    }
    const detail = document.getElementById('agenda-detail-card');
    if (document.body.classList.contains('agenda-detail-open') && detail && !detail.hidden) {
      ev.preventDefault();
      ev.stopPropagation();
      closeDetailCard();
      return true;
    }
    const dialog = document.getElementById('agenda-editor');
    if (document.body.classList.contains('agenda-editor-open') && dialog && !dialog.hidden) {
      ev.preventDefault();
      ev.stopPropagation();
      closeEditor();
      return true;
    }
    return false;
  }

  function saveEditor() {
    const S = getStore();
    if (!S || typeof S.upsertAgendaEvent !== 'function') return;

    const titleEl = document.getElementById('agenda-edit-title');
    const locEl = document.getElementById('agenda-edit-location');
    const startEl = document.getElementById('agenda-edit-start');
    const endEl = document.getElementById('agenda-edit-end');
    const allDayEl = document.getElementById('agenda-edit-allday');
    const webcallEl = document.getElementById('agenda-edit-webcall');
    const notesEl = document.getElementById('agenda-edit-notes');
    const attEl = document.getElementById('agenda-edit-attendees');

    const allDay = !!(allDayEl && allDayEl.checked);
    let start;
    let end;
    if (allDay) {
      const sd = startEl && startEl.value
        ? new Date(`${startEl.value}T00:00:00`)
        : new Date();
      let ed = endEl && endEl.value
        ? new Date(`${endEl.value}T00:00:00`)
        : sd;
      if (ed < sd) ed = new Date(sd);
      start = startOfDay(sd);
      end = addDays(startOfDay(ed), 1);
    } else {
      start = fromDatetimeLocal(startEl && startEl.value);
      end = fromDatetimeLocal(endEl && endEl.value);
      if (end <= start) end = new Date(start.getTime() + 3600000);
    }

    const wcRaw = String(webcallEl && webcallEl.value || '').trim();
    const wc = global.NotesAgendaIcs && NotesAgendaIcs.sanitizeHttpsUrl
      ? NotesAgendaIcs.sanitizeHttpsUrl(wcRaw)
      : (wcRaw.startsWith('https://') ? wcRaw : '');

    const attendees = String(attEl && attEl.value || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const id = state.selectedId || S.newUuid();
    const prev = S.get(id);
    let base = (prev && prev.content?.type === 'agenda_event') ? prev.content : null;
    if (!base && state.selectedId) {
      const row = (listAgendaEvents() || []).find((e) => e.id === state.selectedId);
      base = row ? agendaRowToContent(row) : defaultEvent();
    }
    if (!base) base = defaultEvent();

    const Occ = global.NotesAgendaOccurrence;
    const Ics = global.NotesAgendaIcs;
    if (
      state.editorScope === 'occurrence'
      && state.editorOccurrenceStartMs > 0
      && Occ
    ) {
      const seriesStart = new Date(state.editorOccurrenceStartMs);
      const rid = Occ.recurrenceIdForStart(seriesStart, !!base.all_day);
      const exdates = Occ.normalizeExdates(base.ics_exdates);
      const overrides = { ...(base.ics_occurrence_overrides || {}) };
      const moved = allDay !== !!base.all_day
        || Occ.recurrenceIdForStart(start, allDay) !== Occ.recurrenceIdForStart(seriesStart, !!base.all_day);
      if (moved && !Occ.isExcludedByExdate(seriesStart, exdates, !!base.all_day)) {
        exdates.push(rid);
      }
      overrides[rid] = {
        title: String(titleEl && titleEl.value || '').trim() || 'Untitled',
        location: String(locEl && locEl.value || ''),
        notes: String(notesEl && notesEl.value || ''),
        start: start.toISOString(),
        end: end.toISOString(),
        all_day: allDay,
      };
      const icalUid = Occ.ensureIcalUid(base, id);
      S.upsertAgendaEvent(id, {
        ...base,
        ics_exdates: exdates,
        ics_occurrence_overrides: overrides,
        ical_uid: icalUid,
      });
      closeEditor();
      render();
      return;
    }

    const rrule = readRecurrenceForSave(base.rrule || '');
    const icalUid = Occ ? Occ.ensureIcalUid(base, id) : (base.ical_uid || '');
    const nextStart = start.toISOString();
    const nextEnd = end.toISOString();
    const nextTitle = String(titleEl && titleEl.value || '').trim() || 'Untitled';
    const nextLocation = String(locEl && locEl.value || '');
    const nextNotes = String(notesEl && notesEl.value || '');
    const nextPatch = {
      start: nextStart,
      end: nextEnd,
      all_day: allDay,
      title: nextTitle,
      location: nextLocation,
      notes: nextNotes,
    };
    const preserved = Occ && typeof Occ.planPreserveOverridesOnSeriesEdit === 'function'
      ? Occ.planPreserveOverridesOnSeriesEdit(base, nextPatch)
      : {
        ics_exdates: base.ics_exdates,
        ics_occurrence_overrides: base.ics_occurrence_overrides,
        resetCount: 0,
      };
    const resetCount = Number(preserved.resetCount) || 0;
    if (
      resetCount > 0
      && !state.seriesOverrideResetConfirmed
      && openScopeChooserSeriesReset(resetCount)
    ) {
      return;
    }
    state.seriesOverrideResetConfirmed = false;
    S.upsertAgendaEvent(id, {
      ...base,
      title: nextTitle,
      location: nextLocation,
      notes: nextNotes,
      webcall_url: wc,
      attendees,
      color: state.editorColor || '',
      start: nextStart,
      end: nextEnd,
      all_day: allDay,
      rrule,
      ical_uid: icalUid || base.ical_uid || '',
      ics_exdates: preserved.ics_exdates,
      ics_occurrence_overrides: preserved.ics_occurrence_overrides,
    });
    closeEditor();
    render();
  }

  function renderColorSwatches(selected) {
    const wrap = document.getElementById('agenda-edit-colors');
    if (!wrap) return;
    wrap.innerHTML = EVENT_COLORS.map(
      (c) => `<button type="button" class="agenda-color-swatch${selected === c ? ' is-selected' : ''}" data-agenda-color="${esc(c)}" style="--swatch:${esc(c)}" aria-label="Event color"></button>`,
    ).join('');
    wrap.querySelectorAll('[data-agenda-color]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.editorColor = btn.getAttribute('data-agenda-color') || '';
        renderColorSwatches(state.editorColor);
      });
    });
  }

  function deleteEditor() {
    const S = getStore();
    if (!state.selectedId || !S || typeof S.upsertAgendaEvent !== 'function') return;
    if (typeof window !== 'undefined' && !window.confirm('Delete this event? This cannot be undone.')) return;
    const Occ = global.NotesAgendaOccurrence;
    if (
      state.editorScope === 'occurrence'
      && state.editorOccurrenceStartMs > 0
      && Occ
    ) {
      const prev = S.get(state.selectedId);
      const base = (prev && prev.content?.type === 'agenda_event')
        ? prev.content
        : agendaRowToContent((listAgendaEvents() || []).find((e) => e.id === state.selectedId));
      const seriesStart = new Date(state.editorOccurrenceStartMs);
      const rid = Occ.recurrenceIdForStart(seriesStart, !!base.all_day);
      const exdates = Occ.normalizeExdates(base.ics_exdates);
      if (!Occ.isExcludedByExdate(seriesStart, exdates, !!base.all_day)) exdates.push(rid);
      const overrides = { ...(base.ics_occurrence_overrides || {}) };
      delete overrides[rid];
      S.upsertAgendaEvent(state.selectedId, {
        ...base,
        ics_exdates: exdates,
        ics_occurrence_overrides: overrides,
      });
      closeEditor();
      render();
      return;
    }
    if (typeof S.removeAgendaEvent !== 'function') return;
    S.removeAgendaEvent(state.selectedId);
    closeEditor();
    render();
  }

  async function importIcsFile(file) {
    const S = getStore();
    const Ics = global.NotesAgendaIcs;
    if (!file || !S || !Ics || typeof S.importAgendaFromIcs !== 'function') return;
    const text = await file.text();
    const { events, warnings } = Ics.parseIcsFile(text);
    const res = S.importAgendaFromIcs(events);
    let msg = `Imported ${res.imported} event${res.imported === 1 ? '' : 's'}`;
    if (res.skipped) msg += `, skipped ${res.skipped} duplicate${res.skipped === 1 ? '' : 's'}`;
    if (warnings.length) msg += `. ${warnings.length} parse warning(s).`;
    if (typeof global.notesAgendaToast === 'function') global.notesAgendaToast(msg);
    render();
  }

  function wireEditor() {
    if (editorWired) return;
    editorWired = true;
    wireScopeChooser();
    document.getElementById('agenda-edit-cancel')?.addEventListener('click', closeEditor);
    document.getElementById('agenda-edit-save')?.addEventListener('click', saveEditor);
    document.getElementById('agenda-edit-delete')?.addEventListener('click', deleteEditor);
    document.getElementById('agenda-detail-close')?.addEventListener('click', closeDetailCard);
    document.getElementById('agenda-detail-edit')?.addEventListener('click', continueEditFromDetail);
    document.getElementById('agenda-detail-backdrop')?.addEventListener('click', closeDetailCard);
    document.getElementById('agenda-editor-backdrop')?.addEventListener('click', closeEditor);
    document.addEventListener('keydown', handleEscapeKey, true);
    const ad = document.getElementById('agenda-edit-allday');
    if (ad) {
      ad.addEventListener('change', () => {
        syncEditorDatetimeMode(!!ad.checked);
      });
    }
    document.getElementById('agenda-edit-repeat')?.addEventListener('change', updateRecurrenceStatus);
    const notesEl = document.getElementById('agenda-edit-notes');
    if (notesEl) {
      notesEl.addEventListener('input', () => {
        const joinEl = document.getElementById('agenda-edit-join');
        const web = document.getElementById('agenda-edit-webcall');
        const wc = global.NotesAgendaIcs && NotesAgendaIcs.sanitizeHttpsUrl
          ? NotesAgendaIcs.sanitizeHttpsUrl((web && web.value) || '')
          : '';
        const fromDesc = wc || (NotesAgendaIcs.extractHttpsFromText(notesEl.value || ''));
        if (joinEl) {
          if (fromDesc) {
            joinEl.hidden = false;
            joinEl.innerHTML = `Meeting link: <a href="${esc(fromDesc)}" target="_blank" rel="noopener noreferrer">${esc(fromDesc)}</a>`;
          } else {
            joinEl.hidden = true;
          }
        }
      });
    }
    const webcallEl = document.getElementById('agenda-edit-webcall');
    if (webcallEl) {
      webcallEl.addEventListener('input', () => {
        const joinEl = document.getElementById('agenda-edit-join');
        const wc = global.NotesAgendaIcs && NotesAgendaIcs.sanitizeHttpsUrl
          ? NotesAgendaIcs.sanitizeHttpsUrl(webcallEl.value || '')
          : '';
        if (joinEl && wc) {
          joinEl.hidden = false;
          joinEl.innerHTML = `Meeting link: <a href="${esc(wc)}" target="_blank" rel="noopener noreferrer">${esc(wc)}</a>`;
        }
      });
    }
  }

  function openNewEvent() {
    state.selectedId = '';
    openEditor(null);
  }

  function init() {
    rootEl = document.getElementById('agenda-root');
    if (!rootEl) return;
    wireCalendarSettingsOnce();
    wireAgendaSwipeOnce();
    wireAgendaFabOnce();
    wireEditor();
    fileInput = document.getElementById('agenda-ics-input');
    if (fileInput) {
      fileInput.addEventListener('change', (ev) => {
        const f = ev.target.files && ev.target.files[0];
        ev.target.value = '';
        if (f) importIcsFile(f).catch((err) => {
          if (typeof global.notesAgendaToast === 'function') {
            global.notesAgendaToast(err.message || 'ICS import failed', true);
          }
        });
      });
    }
    try {
      const saved = sessionStorage.getItem('notes_agenda_view');
      if (saved && /^(day|3day|week|month|agenda)$/.test(saved)) state.view = saved;
      else state.view = defaultAgendaView();
    } catch (err) { /* ignore */ }
    state.monthPickDay = startOfDay(new Date()).getTime();
    render();
  }

  function onTabShown() {
    try { sessionStorage.setItem('notes_agenda_view', state.view); } catch (e) { /* ignore */ }
    render();
  }

  global.NotesAgenda = {
    init,
    render,
    onTabShown,
    openNewEvent,
    isAgendaPhoneLayout,
    formatRangeTitle,
    defaultAgendaView,
    seriesNoticeForEditor,
    handleEscapeKey,
    closeEditor,
    closeScopeChooser,
    _layoutDayColumns: layoutDayColumns,
  };
  global.__notesCloseAgendaCalendarSettings = closeCalendarSettingsPanel;
}(typeof window !== 'undefined' ? window : globalThis));
