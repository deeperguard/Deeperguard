/**
 * Deeperguard Agenda — week / day / 3-day / month / list views; vault-encrypted events.
 */
(function (global) {
  const MS_DAY = 86400000;
  const ACCENT_PALETTE = ['#3b82f6', '#2563eb', '#0ea5e9', '#6366f1', '#8b5cf6'];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function addDays(d, n) {
    return new Date(d.getTime() + n * MS_DAY);
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

  function hashHue(id) {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h) + s.charCodeAt(i);
    return Math.abs(h) % ACCENT_PALETTE.length;
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

  /** Expand instances for range [rangeStart, rangeEnd) — single + RRULE basic FREQ=DAILY/WEEKLY. */
  function expandEventOccurrences(ev, rangeStart, rangeEnd) {
    const span = eventSpan(ev);
    if (!span) return [];
    const out = [];
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

    if (!ev.rrule || !String(ev.rrule).trim()) {
      if (span.end <= rangeStart || span.start >= rangeEnd) return out;
      out.push({ ev, start: span.start, end: span.end, recurring: false });
      return out;
    }

    const rule = String(ev.rrule).toUpperCase();
    const freqDaily = /FREQ=DAILY/.test(rule);
    const freqWeekly = /FREQ=WEEKLY/.test(rule);
    const intervalMatch = rule.match(/INTERVAL=(\d+)/);
    const interval = intervalMatch ? Math.max(1, Number(intervalMatch[1]) || 1) : 1;
    const untilMatch = rule.match(/UNTIL=([^;:]+)/);
    let until = null;
    if (untilMatch) {
      const raw = untilMatch[1].replace(/Z$/, '');
      const p = Date.parse(raw);
      if (Number.isFinite(p)) until = new Date(p);
    }
    const countMatch = rule.match(/COUNT=(\d+)/);
    const maxCount = countMatch ? Math.max(1, Number(countMatch[1]) || 50) : 400;

    let curStart = new Date(span.start);
    let curEnd = new Date(span.end);
    const duration = curEnd - curStart;
    let n = 0;
    while (n < maxCount && curStart < rangeEnd) {
      const ce = new Date(curStart.getTime() + duration);
      if (ce > rangeStart && curStart < rangeEnd) {
        out.push({
          ev,
          start: new Date(curStart),
          end: ce,
          recurring: true,
        });
      }
      n += 1;
      if (until && curStart > until) break;
      if (freqDaily) {
        curStart = addDays(curStart, interval);
      } else if (freqWeekly) {
        curStart = addDays(curStart, 7 * interval);
      } else {
        break;
      }
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
    const cols = Math.max(1, colEnds.length);
    placed.forEach((p) => { p.colCount = cols; });
    return placed;
  }

  const state = {
    view: 'week',
    anchor: new Date(),
    search: '',
    selectedId: '',
  };

  let rootEl = null;
  let fileInput = null;
  let searchDebounce = 0;
  let editorWired = false;

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
      const gridEndWeek = startOfWeekMonday(addDays(last, 1));
      const weekStarts = [];
      let cur = gridStart;
      while (cur < gridEndWeek) {
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
    for (let t = s.getTime(); t < end.getTime(); t += MS_DAY) dayList.push(new Date(t));
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
      return monthTitle(state.anchor);
    }
    if (state.view === 'agenda') {
      return `Agenda · ${monthTitle(state.anchor)}`;
    }
    const w = isoWeekNumber(range.start);
    return `W${pad2(w)} · ${monthTitle(range.start)}`;
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
      { id: 'agenda', label: 'Agenda' },
    ];
    return views.map((v) => (
      `<button type="button" class="agenda-seg ${state.view === v.id ? 'is-active' : ''}" data-agenda-view="${esc(v.id)}">${esc(v.label)}</button>`
    )).join('');
  }

  function renderTimedGrid(days, occ) {
    const PX_PER_HOUR = 52;
    const hours = [];
    for (let h = 0; h < 24; h += 1) hours.push(h);

    const now = new Date();
    const todayStart = startOfDay(now);
    const minutesNow = (now - todayStart) / 60000;

    const allDayOcc = occ.filter((o) => o.ev.all_day);

    let body = '';
    body += '<div class="agenda-allday-row">';
    body += '<div class="agenda-allday-label muted">all day</div>';
    body += `<div class="agenda-allday-grid" style="--agenda-cols:${days.length}">`;
    allDayOcc.forEach((o) => {
      const ds = startOfDay(o.start).getTime();
      const de = startOfDay(o.end).getTime();
      let i0 = -1;
      let i1 = -1;
      days.forEach((d, i) => {
        const t0 = startOfDay(d).getTime();
        if (t0 >= ds && t0 < de) {
          if (i0 < 0) i0 = i;
          i1 = i;
        }
      });
      if (i0 < 0) return;
      const span = i1 - i0 + 1;
      const clr = ACCENT_PALETTE[hashHue(o.ev.id)];
      const rec = o.recurring || (o.ev.rrule && String(o.ev.rrule).trim());
      body += (
        `<button type="button" class="agenda-allday-chip" data-agenda-id="${esc(o.ev.id)}" style="grid-column:${i0 + 1} / span ${span}" title="${esc(o.ev.title)}">`
        + (rec ? '<span class="agenda-rec-glyph" aria-hidden="true">↻</span>' : '')
        + `<span class="agenda-chip-title">${esc(o.ev.title)}</span>`
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
        const clr = ACCENT_PALETTE[hashHue(o.ev.id)];
        const wPct = 100 / o.colCount;
        const leftPct = wPct * o.col;
        const rec = o.recurring || (o.ev.rrule && String(o.ev.rrule).trim());
        const timeRange = `${formatTime(o.a)} – ${formatTime(o.b)}`;
        body += (
          `<button type="button" class="agenda-event-chip" data-agenda-id="${esc(o.ev.id)}" style="top:${top}px;height:${h}px;left:${leftPct}%;width:${wPct}%;--agenda-accent:${clr}">`
          + `<span class="agenda-chip-accent" style="background:${clr}"></span>`
          + '<span class="agenda-chip-body">'
          + (rec ? '<span class="agenda-rec-glyph" aria-hidden="true">↻</span>' : '')
          + `<span class="agenda-chip-title">${esc(o.ev.title)}</span>`
          + (h >= 36 ? `<span class="agenda-chip-time muted">${esc(timeRange)}</span>` : '')
          + '</span></button>'
        );
      });
      body += '</div>';
    });
    body += '</div></div></div>';

    return body;
  }

  function renderAgendaList(occ) {
    const sorted = occ.filter((o) => !o.ev.all_day).sort((a, b) => a.start - b.start);
    const allDay = occ.filter((o) => o.ev.all_day).sort((a, b) => a.start - b.start);
    let html = '<div class="agenda-list-view">';
    if (allDay.length) {
      html += '<p class="agenda-list-section-label muted">All day</p><ul class="agenda-list">';
      allDay.forEach((o) => {
        html += (
          `<li><button type="button" class="agenda-list-row" data-agenda-id="${esc(o.ev.id)}">`
          + `<span class="agenda-list-date">${esc(o.start.toLocaleDateString())}</span>`
          + `<span class="agenda-list-title">${esc(o.ev.title)}</span>`
          + '</button></li>'
        );
      });
      html += '</ul>';
    }
    html += '<p class="agenda-list-section-label muted">Scheduled</p><ul class="agenda-list">';
    sorted.forEach((o) => {
      html += (
        `<li><button type="button" class="agenda-list-row" data-agenda-id="${esc(o.ev.id)}">`
        + `<span class="agenda-list-date">${esc(o.start.toLocaleString())}</span>`
        + `<span class="agenda-list-title">${esc(o.ev.title)}</span>`
        + '</button></li>'
      );
    });
    html += '</ul></div>';
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

  function renderMonthGrid(days, occ) {
    let nWeeks = Math.ceil(days.length / 7);
    const anchorMonth = state.anchor.getMonth();
    const anchorYear = state.anchor.getFullYear();
    while (nWeeks > 1 && !monthWeekHasVisibleContent(days, occ, nWeeks - 1, anchorMonth, anchorYear)) {
      nWeeks -= 1;
    }
    let html = '<div class="agenda-month-grid">';
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
        html += `<div class="agenda-month-cell ${inMonth ? '' : 'is-out'} ${isToday ? 'is-today' : ''}">`;
        html += `<div class="agenda-month-date">${day.getDate()}</div>`;
        html += '<div class="agenda-month-events">';
        show.forEach((o) => {
          const clr = ACCENT_PALETTE[hashHue(o.ev.id)];
          const rec = o.recurring || (o.ev.rrule && String(o.ev.rrule).trim());
          const tlabel = o.ev.all_day ? 'All day' : formatTime(o.start);
          html += (
            `<button type="button" class="agenda-month-ev" data-agenda-id="${esc(o.ev.id)}" title="${esc(o.ev.title)}">`
            + `<span class="agenda-month-ev-accent" style="background:${clr}"></span>`
            + '<span class="agenda-month-ev-body">'
            + (rec ? '<span class="agenda-rec-glyph" aria-hidden="true">↻</span>' : '')
            + `<span class="agenda-month-ev-title">${esc(o.ev.title)}</span>`
            + `<span class="agenda-month-ev-time muted">${esc(tlabel)}</span>`
            + '</span></button>'
          );
        });
        if (extra) html += `<span class="agenda-month-more muted" aria-hidden="true">+${extra} more</span>`;
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
      main = renderAgendaList(occ);
    } else if (state.view === 'month') {
      main = renderMonthGrid(days, occ);
    } else {
      main = (
        '<div class="agenda-week-layout">'
        + renderDayHeaders(days)
        + renderTimedGrid(days, occ)
        + '</div>'
      );
    }

    rootEl.innerHTML = (
      '<header class="agenda-top">'
      + '<div class="agenda-top-row">'
      + '<div class="agenda-nav">'
      + '<button type="button" class="btn icon agenda-icon-btn" id="agenda-prev" aria-label="Previous">‹</button>'
      + '<button type="button" class="btn icon agenda-icon-btn" id="agenda-next" aria-label="Next">›</button>'
      + `<h1 class="agenda-title">${esc(titleForNav(range))}</h1>`
      + '<button type="button" class="btn sm agenda-today" id="agenda-today">Today</button>'
      + '</div>'
      + '<div class="agenda-seg-wrap" role="group" aria-label="View">'
      + renderViewToggles()
      + '</div>'
      + '<div class="agenda-top-tools">'
      + '<label class="agenda-search-field">'
      + '<svg class="agenda-search-ico" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="M16 16l5 5"/></svg>'
      + `<input type="search" id="agenda-search" placeholder="Search" value="${esc(state.search)}" autocomplete="off" />`
      + '</label>'
      + '<button type="button" class="btn icon agenda-icon-btn" id="agenda-filter-placeholder" aria-label="Filters" title="Filters">⚙</button>'
      + '<button type="button" class="btn icon agenda-icon-btn" id="agenda-settings-placeholder" aria-label="Calendar settings" title="Settings">☰</button>'
      + '<button type="button" class="btn primary agenda-add" id="agenda-add-event">+ Event</button>'
      + '</div>'
      + '</div>'
      + '<div class="agenda-subrow">'
      + '<button type="button" class="btn sm ghost" id="agenda-import-ics">Import ICS…</button>'
      + '<p class="agenda-privacy-hint muted">Events stay encrypted in your vault. ICS import is a trust boundary — only https links are offered as join targets.</p>'
      + '</div>'
      + '</header>'
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
        state.view = btn.getAttribute('data-agenda-view') || 'week';
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

    rootEl.querySelector('#agenda-add-event')?.addEventListener('click', () => {
      openEditor(null);
    });
    rootEl.querySelector('#agenda-import-ics')?.addEventListener('click', () => {
      fileInput?.click();
    });
    rootEl.querySelector('#agenda-settings-placeholder')?.addEventListener('click', () => {
      if (typeof window.__notesOpenSettings === 'function') window.__notesOpenSettings();
      else document.getElementById('btn-settings-head')?.click();
    });

    rootEl.querySelectorAll('[data-agenda-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-agenda-id');
        openEditor(id);
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
  }

  function addMonthsAnchor(d, n) {
    const x = new Date(d);
    x.setMonth(x.getMonth() + n);
    return x;
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

  function openEditor(id) {
    const S = getStore();
    if (!S || typeof S.get !== 'function') return;
    let existing = id ? S.get(id) : null;
    if (!existing && id && typeof S.listAgendaEvents === 'function') {
      const ev = (listAgendaEvents() || []).find((e) => e.id === id);
      if (ev) {
        existing = { uuid: id, content: agendaRowToContent(ev) };
      }
    }
    const content = existing && existing.content?.type === 'agenda_event'
      ? existing.content
      : defaultEvent();
    state.selectedId = existing ? existing.uuid : id || '';

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

    const s = parseInstant(content.start) || new Date();
    const endParsed = parseInstant(content.end);
    const e = endParsed || new Date(s.getTime() + 3600000);

    if (titleEl) titleEl.value = content.title || '';
    if (locEl) locEl.value = content.location || '';
    if (startEl) startEl.value = toDatetimeLocal(s);
    if (endEl) endEl.value = toDatetimeLocal(e);
    if (allDayEl) {
      allDayEl.checked = !!content.all_day;
      [startEl, endEl].forEach((el) => {
        if (el) el.toggleAttribute('disabled', !!content.all_day);
      });
    }
    if (webcallEl) webcallEl.value = content.webcall_url || '';
    if (notesEl) notesEl.value = content.notes || '';
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
        joinEl.innerHTML = `Join: <a href="${esc(joinHref)}" target="_blank" rel="noopener noreferrer">${esc(joinHref)}</a>`;
      } else {
        joinEl.hidden = true;
        joinEl.textContent = '';
      }
    }

    document.getElementById('agenda-edit-delete')?.toggleAttribute('hidden', !state.selectedId);

    backdrop.hidden = false;
    dialog.hidden = false;
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
      start: s.toISOString(),
      end: e.toISOString(),
      all_day: false,
      rrule: '',
      ical_uid: '',
    };
  }

  function closeEditor() {
    const backdrop = document.getElementById('agenda-editor-backdrop');
    const dialog = document.getElementById('agenda-editor');
    if (backdrop) backdrop.hidden = true;
    if (dialog) dialog.hidden = true;
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

    const start = fromDatetimeLocal(startEl && startEl.value);
    let end = fromDatetimeLocal(endEl && endEl.value);
    if (end <= start) end = new Date(start.getTime() + 3600000);

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

    S.upsertAgendaEvent(id, {
      ...base,
      title: String(titleEl && titleEl.value || '').trim() || 'Untitled',
      location: String(locEl && locEl.value || ''),
      notes: String(notesEl && notesEl.value || ''),
      webcall_url: wc,
      attendees,
      start: start.toISOString(),
      end: end.toISOString(),
      all_day: !!(allDayEl && allDayEl.checked),
    });
    closeEditor();
    render();
  }

  function deleteEditor() {
    const S = getStore();
    if (!state.selectedId || !S || typeof S.removeAgendaEvent !== 'function') return;
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
    document.getElementById('agenda-edit-cancel')?.addEventListener('click', closeEditor);
    document.getElementById('agenda-edit-save')?.addEventListener('click', saveEditor);
    document.getElementById('agenda-edit-delete')?.addEventListener('click', deleteEditor);
    document.getElementById('agenda-editor-backdrop')?.addEventListener('click', closeEditor);
    const ad = document.getElementById('agenda-edit-allday');
    const startEl = document.getElementById('agenda-edit-start');
    const endEl = document.getElementById('agenda-edit-end');
    if (ad && startEl && endEl) {
      ad.addEventListener('change', () => {
        const on = !!ad.checked;
        startEl.toggleAttribute('disabled', on);
        endEl.toggleAttribute('disabled', on);
      });
    }
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
            joinEl.innerHTML = `Join: <a href="${esc(fromDesc)}" target="_blank" rel="noopener noreferrer">${esc(fromDesc)}</a>`;
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
          joinEl.innerHTML = `Join: <a href="${esc(wc)}" target="_blank" rel="noopener noreferrer">${esc(wc)}</a>`;
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
    } catch (err) { /* ignore */ }
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
  };
}(typeof window !== 'undefined' ? window : globalThis));
