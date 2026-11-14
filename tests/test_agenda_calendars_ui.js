// Calendar list UI (docs/design/calendar-multi.md §1, milestone M2): create, recolor, rename,
// hide and delete calendars; events follow the change and always show the calendar name next to
// the color; every palette color has >= 4.5:1 contrast with its label text (checked with the
// shared helper tests/agenda_contrast_utils.js); all controls are native, keyboard-operable
// elements with aria-labels.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./sync_harness');
const { parseCssColor, contrastRatio } = require('./agenda_contrast_utils');
const Cals = require('../app/static/js/agenda-calendars.js');

const root = path.join(__dirname, '..');
const agendaJs = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
const calsJs = fs.readFileSync(path.join(root, 'app/static/js/agenda-calendars.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');

const { NotesStore } = h;
const DEF = NotesStore.DEFAULT_CALENDAR_ID;

function hexToCss(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assert.ok(m, `palette color ${hex} is a 6-digit hex`);
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`;
}

function rowOf(markup, id) {
  const at = markup.indexOf(`data-agenda-cal-id="${id}"`);
  assert.ok(at >= 0, `row for ${id} is rendered`);
  const start = markup.lastIndexOf('<li', at);
  const end = markup.indexOf('</li>', start);
  return markup.slice(start, end);
}

(async () => {
  // --- contrast: every palette color vs its label text, via the shared helper -------------
  assert.ok(Cals.PALETTE.length >= 8 && Cals.PALETTE.length <= 10, 'palette has 8-10 tints');
  const keys = new Set();
  for (const p of Cals.PALETTE) {
    assert.ok(!keys.has(p.key), `palette key ${p.key} is unique`);
    keys.add(p.key);
    const ratio = contrastRatio(parseCssColor(hexToCss(p.text)), parseCssColor(hexToCss(p.bg)));
    assert.ok(ratio >= 4.5, `${p.key}: contrast ${ratio.toFixed(2)}:1 must be >= 4.5:1`);
  }
  assert.ok(!/function\s+(relativeLuminance|contrastRatio|lin)\b/.test(calsJs), 'app reuses the shared contrast helper in tests');
  assert.strictEqual(Cals.paletteEntry('from-a-newer-app').key, Cals.PALETTE[0].key, 'unknown key falls back to first tint');

  // label font size never below 11px
  const sizes = [...css.matchAll(/\.agenda-cal-label[^{]*\{[^}]*font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length >= 1, 'label font size is set');
  sizes.forEach((px) => assert.ok(px >= 11, `calendar label font-size ${px}px must be >= 11px`));

  await h.unlockFresh();
  Cals._setStore(NotesStore);
  const T = '2026-11-20T09:00:00.000Z';
  const T2 = '2026-11-20T10:00:00.000Z';

  // --- create --------------------------------------------------------------------------
  assert.strictEqual(Cals.createCalendar('   ', 'teal'), '', 'empty name is refused');
  const work = Cals.createCalendar('  Werk  ', 'teal');
  assert.ok(work, 'calendar created');
  let list = Cals.listCalendars();
  assert.deepStrictEqual(list.map((c) => c.name), ['Agenda', 'Werk'], 'default + new calendar, in order');
  assert.strictEqual(list[1].color, 'teal');
  assert.strictEqual(list[1].visible, true);

  NotesStore.upsertAgendaEvent('e-work', {
    type: 'agenda_event', version: 1, title: 'Overleg', start: T, end: T2, all_day: false, rrule: '', calendarId: work,
  });
  NotesStore.upsertAgendaEvent('e-home', {
    type: 'agenda_event', version: 1, title: 'Tandarts', start: T, end: T2, all_day: false, rrule: '',
  });
  const ev = (id) => NotesStore.listAgendaEvents().find((e) => e.id === id);

  let label = Cals.labelHtml(Cals.calendarForEvent(ev('e-work')));
  assert.ok(label.includes('>Werk</span>'), 'event shows its calendar name, not only a color');
  assert.ok(label.includes('background:#0f766e'), 'label uses the calendar color');
  assert.ok(Cals.labelHtml(Cals.calendarForEvent(ev('e-home'))).includes('>Agenda</span>'), 'event without calendarId shows the default calendar');

  // UI markup for the list: native controls with aria-labels
  let markup = Cals.renderHtml();
  let row = rowOf(markup, work);
  assert.ok(row.includes('type="checkbox"') && row.includes('aria-label="Show Werk"') && row.includes(' checked'));
  assert.ok(row.includes('aria-label="Rename or recolor Werk"'));
  assert.ok(row.includes('aria-label="Delete Werk"'));
  assert.ok(!rowOf(markup, DEF).includes('data-agenda-cal-action="delete"'), 'default (last) calendar cannot be deleted');
  assert.ok(markup.includes('data-agenda-cal-action="new"'), 'create button present');

  Cals._ui.editing = 'new';
  markup = Cals.renderHtml();
  assert.ok(markup.includes('aria-label="New calendar"') && markup.includes('name="name"') && markup.includes('required'));
  assert.strictEqual((markup.match(/type="radio" name="agenda-cal-new-color"/g) || []).length, Cals.PALETTE.length,
    'color picker is a native radio group (arrow keys work)');
  Cals.PALETTE.forEach((p) => assert.ok(markup.includes(`<span class="sr-only">${p.name}</span>`), `color ${p.key} has a text name`));
  Cals._ui.editing = '';

  // --- change color ------------------------------------------------------------------------
  assert.ok(Cals.setCalendarColor(work, 'purple'));
  label = Cals.labelHtml(Cals.calendarForEvent(ev('e-work')));
  assert.ok(label.includes('background:#6d28d9') && label.includes('data-agenda-cal-color="purple"'), 'event follows new color');
  assert.strictEqual(Cals.listCalendars().find((c) => c.id === work).color, 'purple');

  // --- rename ------------------------------------------------------------------------
  assert.ok(!Cals.renameCalendar(work, ''), 'empty rename is refused');
  assert.ok(Cals.renameCalendar(work, 'Kantoor'));
  assert.ok(Cals.labelHtml(Cals.calendarForEvent(ev('e-work'))).includes('>Kantoor</span>'), 'event follows rename');
  assert.ok(Cals.renameCalendar(DEF, 'Privé'), 'default calendar can be renamed');

  // --- hide --------------------------------------------------------------------------
  assert.ok(Cals.setCalendarVisible(work, false));
  const map = Cals.calendarMap();
  assert.strictEqual(Cals.isEventVisible(ev('e-work'), map), false, 'event of hidden calendar is not drawn');
  assert.strictEqual(Cals.isEventVisible(ev('e-home'), map), true);
  row = rowOf(Cals.renderHtml(), work);
  assert.ok(row.includes('is-hidden') && !row.includes(' checked'), 'row shows hidden state');
  assert.ok(row.includes(', hidden</span>'), 'hidden state is announced in text, not only styling');
  assert.ok(Cals.setCalendarVisible(work, true));
  assert.strictEqual(Cals.isEventVisible(ev('e-work'), Cals.calendarMap()), true, 'shown again');

  // --- delete: the user chooses what happens to the events ----------------------------
  Cals._ui.deleting = work;
  markup = Cals.renderHtml();
  assert.ok(markup.includes('aria-label="Delete Kantoor"') && markup.includes('It has 1 event.'));
  assert.ok(markup.includes('name="mode" value="move" checked'), 'moving is the default choice');
  assert.ok(markup.includes('name="mode" value="delete"'), 'deleting the events is an explicit choice');
  assert.ok(markup.includes('aria-label="Calendar to move the events to"'));
  Cals._ui.deleting = '';

  assert.ok(!Cals.deleteCalendar(work, undefined).ok, 'no silent default: a mode is required');
  assert.ok(!Cals.deleteCalendar(DEF, 'move').ok, 'default calendar cannot be deleted');
  let res = Cals.deleteCalendar(work, 'move');
  assert.ok(res.ok && res.moved === 1);
  assert.strictEqual(NotesStore.agendaEventCalendarId(ev('e-work')), DEF, 'moved event now in default calendar');
  assert.ok(Cals.labelHtml(Cals.calendarForEvent(ev('e-work'))).includes('>Privé</span>'));
  assert.deepStrictEqual(Cals.listCalendars().map((c) => c.id), [DEF]);

  const tmp = Cals.createCalendar('Tijdelijk', 'red');
  NotesStore.upsertAgendaEvent('e-tmp', {
    type: 'agenda_event', version: 1, title: 'Weg', start: T, end: T2, all_day: false, rrule: '', calendarId: tmp,
  });
  res = Cals.deleteCalendar(tmp, 'delete');
  assert.ok(res.ok);
  assert.deepStrictEqual(res.deletedEventIds, ['e-tmp']);
  assert.strictEqual(ev('e-tmp'), undefined, 'events deleted with the calendar');
  assert.ok(ev('e-work') && ev('e-home'), 'other events untouched');

  // --- agenda view + editor integration -------------------------------------------------
  assert.ok((agendaJs.match(/calendarLabelHtml\(o\.ev/g) || []).length >= 5, 'every event view shows the calendar label');
  assert.ok(agendaJs.includes('filterEvents(state.search, visibleAgendaEvents())'), 'hidden calendars are filtered from the views');
  assert.ok(agendaJs.includes('calendarId: readCalendarSelect(base)'), 'editor saves the chosen calendar');
  assert.ok(agendaJs.includes('NotesAgendaCalendars?.wire?.({ onChange: render })'), 'panel re-renders the agenda');
  assert.ok(html.includes('<select id="agenda-edit-calendar">'), 'editor has a calendar picker');
  assert.ok(html.includes('id="agenda-calendars-list"') && html.includes('aria-live="polite"'));
  assert.ok(html.includes("asset_script('js/agenda-calendars.js')"));
  assert.ok(!/tabindex="-1"/.test(calsJs), 'no control is removed from the tab order');
  assert.ok(!/localStorage\.|console\.\w+\(/.test(calsJs), 'calendar names never go to localStorage or the console');

  console.log('agenda calendars ui ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
