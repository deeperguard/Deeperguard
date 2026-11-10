/**
 * Occurrence overrides + EXDATE (agenda-occurrence.js + expansion finalize).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const load = (rel) => vm.runInThisContext(fs.readFileSync(path.join(root, rel), 'utf8'), { filename: path.basename(rel) });

load('app/static/js/agenda-ics.js');
load('app/static/js/agenda-recurrence.js');
load('app/static/js/agenda-occurrence.js');

const Occ = global.NotesAgendaOccurrence;
const Ics = global.NotesAgendaIcs;

const master = {
  id: 'ev1',
  title: 'Stand-up',
  start: '2026-04-06T10:30:00.000Z',
  end: '2026-04-06T11:00:00.000Z',
  all_day: false,
  rrule: 'FREQ=WEEKLY;INTERVAL=1',
  ics_exdates: [],
  ics_occurrence_overrides: {},
};

function expandRaw(ev, rangeStart, rangeEnd) {
  const span = { start: new Date(ev.start), end: new Date(ev.end) };
  const out = [];
  let cur = new Date(span.start);
  const duration = span.end - span.start;
  while (cur < rangeEnd) {
    const ce = new Date(cur.getTime() + duration);
    if (ce > rangeStart && cur < rangeEnd) {
      out.push({ ev, start: new Date(cur), end: ce, recurring: true });
    }
    cur = new Date(cur.getTime() + 7 * 86400000);
  }
  return Occ.finalizeOccurrences(ev, out, rangeStart, rangeEnd);
}

const rangeStart = new Date('2026-04-01T00:00:00Z');
const rangeEnd = new Date('2026-04-30T00:00:00Z');

let occ = expandRaw(master, rangeStart, rangeEnd);
assert.strictEqual(occ.length, 4);

const instance = new Date('2026-04-20T10:30:00.000Z');
const rid = Occ.recurrenceIdForStart(instance, false);
master.ics_occurrence_overrides[rid] = {
  title: 'Stand-up (guest)',
  start: instance.toISOString(),
  end: '2026-04-20T11:00:00.000Z',
  all_day: false,
};
occ = expandRaw(master, rangeStart, rangeEnd);
const april20 = occ.find((o) => o.start.toISOString().startsWith('2026-04-20'));
assert.ok(april20, 'Apr 20 instance exists');
assert.strictEqual(april20.displayTitle, 'Stand-up (guest)');
const unchanged = occ.find((o) => o.start.toISOString().startsWith('2026-04-06'));
assert.strictEqual(unchanged.displayTitle, 'Stand-up');

const movedStart = new Date('2026-04-21T14:00:00.000Z');
master.ics_exdates = [rid];
master.ics_occurrence_overrides[rid] = {
  title: 'Stand-up moved',
  start: movedStart.toISOString(),
  end: '2026-04-21T14:30:00.000Z',
  all_day: false,
};
occ = expandRaw(master, rangeStart, rangeEnd);
assert.strictEqual(
  occ.filter((o) => o.start.toISOString().startsWith('2026-04-20T10:30')).length,
  0,
);
const moved = occ.find((o) => o.displayTitle === 'Stand-up moved');
assert.ok(moved);
assert.strictEqual(moved.start.toISOString(), movedStart.toISOString());

master.ics_exdates.push(Occ.recurrenceIdForStart(new Date('2026-04-13T10:30:00.000Z'), false));
occ = expandRaw(master, rangeStart, rangeEnd);
assert.strictEqual(occ.filter((o) => o.start.toISOString().startsWith('2026-04-13')).length, 0);

const exported = Ics.buildIcsCalendarFromEvents([
  master,
  {
    ...master,
    rrule: '',
    ics_exdates: [],
    ics_recurrence_id: rid,
    title: master.ics_occurrence_overrides[rid].title,
    start: master.ics_occurrence_overrides[rid].start,
    end: master.ics_occurrence_overrides[rid].end,
  },
]);
assert.ok(exported.includes('RECURRENCE-ID:'));
assert.ok(exported.includes('EXDATE:'));
assert.ok(exported.includes('FREQ=WEEKLY'));

const reimport = Ics.parseIcsFile(exported);
assert.ok(reimport.events.length >= 2);

const nov24 = new Date('2026-11-24T12:00:00.000Z');
const nov24Rid = Occ.recurrenceIdForStart(nov24, false);
const weeklyMaster = {
  ...master,
  title: 'Weekly sync',
  start: '2026-11-03T12:00:00.000Z',
  end: '2026-11-03T13:00:00.000Z',
  rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU',
  ics_exdates: [],
  ics_occurrence_overrides: {
    [nov24Rid]: {
      title: 'Beta v53 one-off',
      location: '',
      notes: '',
      start: nov24.toISOString(),
      end: '2026-11-24T13:00:00.000Z',
      all_day: false,
    },
  },
};

let afterTitle = Occ.preserveOverridesOnSeriesEdit(weeklyMaster, {
  start: weeklyMaster.start,
  end: weeklyMaster.end,
  all_day: false,
});
afterTitle = { ...weeklyMaster, title: 'Weekly sync (renamed)', ...afterTitle };
occ = expandRaw(afterTitle, new Date('2026-11-01'), new Date('2026-12-01'));
const nov24Occ = occ.find((o) => o.start.toISOString().startsWith('2026-11-24T12'));
assert.ok(nov24Occ, 'Nov 24 instance after series retitle');
assert.strictEqual(nov24Occ.displayTitle, 'Beta v53 one-off');

const shifted = Occ.preserveOverridesOnSeriesEdit(weeklyMaster, {
  start: '2026-11-03T13:00:00.000Z',
  end: '2026-11-03T14:00:00.000Z',
  all_day: false,
});
const shiftedMaster = { ...weeklyMaster, start: '2026-11-03T13:00:00.000Z', end: '2026-11-03T14:00:00.000Z', ...shifted };
occ = expandRaw(shiftedMaster, new Date('2026-11-01'), new Date('2026-12-01'));
const nov24Shifted = occ.find((o) => o.start.toISOString().startsWith('2026-11-24T13'));
assert.ok(nov24Shifted, 'Nov 24 follows +1h series shift');
assert.strictEqual(nov24Shifted.displayTitle, 'Beta v53 one-off');

const timeFixedRid = Occ.recurrenceIdForStart(new Date('2026-11-17T12:00:00.000Z'), false);
const timeFixedMaster = {
  ...weeklyMaster,
  ics_occurrence_overrides: {
    [timeFixedRid]: {
      title: 'Afternoon only',
      start: '2026-11-17T14:00:00.000Z',
      end: '2026-11-17T15:00:00.000Z',
      all_day: false,
    },
  },
  ics_exdates: [timeFixedRid],
};
const timeFixedPreserved = Occ.preserveOverridesOnSeriesEdit(timeFixedMaster, {
  start: '2026-11-03T13:00:00.000Z',
  end: '2026-11-03T14:00:00.000Z',
  all_day: false,
});
const timeFixedEv = {
  ...timeFixedMaster,
  start: '2026-11-03T13:00:00.000Z',
  end: '2026-11-03T14:00:00.000Z',
  ...timeFixedPreserved,
};
assert.strictEqual(timeFixedPreserved.ics_occurrence_overrides[timeFixedRid].title, 'Afternoon only');
assert.strictEqual(
  timeFixedPreserved.ics_occurrence_overrides[timeFixedRid].start,
  '2026-11-17T14:00:00.000Z',
);
assert.ok(timeFixedPreserved.ics_exdates.includes(timeFixedRid));
occ = expandRaw(timeFixedEv, new Date('2026-11-01'), new Date('2026-12-01'));
const afternoonNov17 = occ.find((o) => o.displayTitle === 'Afternoon only');
assert.ok(afternoonNov17);
assert.strictEqual(afternoonNov17.start.toISOString(), '2026-11-17T14:00:00.000Z');

const exdateMaster = {
  ...weeklyMaster,
  ics_exdates: [Occ.recurrenceIdForStart(new Date('2026-11-10T12:00:00.000Z'), false)],
  ics_occurrence_overrides: weeklyMaster.ics_occurrence_overrides,
};
const exShift = Occ.preserveOverridesOnSeriesEdit(exdateMaster, {
  start: '2026-11-03T13:00:00.000Z',
  end: '2026-11-03T14:00:00.000Z',
  all_day: false,
});
assert.strictEqual(exShift.ics_exdates.length, 1);
assert.strictEqual(exShift.ics_exdates[0], Occ.recurrenceIdForStart(new Date('2026-11-10T13:00:00.000Z'), false));
const exShiftEv = { ...exdateMaster, start: '2026-11-03T13:00:00.000Z', end: '2026-11-03T14:00:00.000Z', ...exShift };
occ = expandRaw(exShiftEv, new Date('2026-11-01'), new Date('2026-12-01'));
assert.strictEqual(occ.filter((o) => o.start.toISOString().startsWith('2026-11-10T13')).length, 0);

const exportMaster = { ...shiftedMaster };
const exportRows = [exportMaster];
for (const [rid, ov] of Object.entries(exportMaster.ics_occurrence_overrides)) {
  exportRows.push({
    ...exportMaster,
    rrule: '',
    ics_exdates: [],
    ics_occurrence_overrides: {},
    ics_recurrence_id: rid,
    title: ov.title,
    start: ov.start,
    end: ov.end,
    all_day: ov.all_day,
  });
}
const shiftedIcs = Ics.buildIcsCalendarFromEvents(exportRows);
assert.ok(shiftedIcs.includes('RECURRENCE-ID:'));
assert.ok(shiftedIcs.includes('Beta v53 one-off'));
assert.ok(shiftedIcs.includes(Occ.recurrenceIdForStart(new Date('2026-11-24T13:00:00.000Z'), false)));

assert.strictEqual(
  Occ.seriesOverrideResetMessage(1),
  '1 customized occurrence will be reset to the series',
);
assert.strictEqual(
  Occ.seriesOverrideResetMessage(3),
  '3 customized occurrences will be reset to the series',
);

const titleTimeRid = Occ.recurrenceIdForStart(new Date('2026-12-01T12:00:00.000Z'), false);
const titleTimeMaster = {
  ...weeklyMaster,
  ics_occurrence_overrides: {
    [titleTimeRid]: {
      title: 'Board + late',
      start: '2026-12-01T14:00:00.000Z',
      end: '2026-12-01T15:00:00.000Z',
      all_day: false,
    },
  },
  ics_exdates: [titleTimeRid],
};
const titleTimePlan = Occ.planPreserveOverridesOnSeriesEdit(titleTimeMaster, {
  start: '2026-11-03T13:00:00.000Z',
  end: '2026-11-03T14:00:00.000Z',
  all_day: false,
  title: titleTimeMaster.title,
  location: '',
  notes: '',
});
const titleTimeEv = {
  ...titleTimeMaster,
  start: '2026-11-03T13:00:00.000Z',
  end: '2026-11-03T14:00:00.000Z',
  ...titleTimePlan,
};
assert.strictEqual(titleTimePlan.resetCount, 0);
assert.strictEqual(titleTimePlan.ics_occurrence_overrides[titleTimeRid].title, 'Board + late');
assert.strictEqual(titleTimePlan.ics_occurrence_overrides[titleTimeRid].start, '2026-12-01T14:00:00.000Z');
occ = expandRaw(titleTimeEv, new Date('2026-11-01'), new Date('2026-12-15'));
const titleTimeOcc = occ.find((o) => o.displayTitle === 'Board + late');
assert.ok(titleTimeOcc);
assert.strictEqual(titleTimeOcc.start.toISOString(), '2026-12-01T14:00:00.000Z');

const timeOnlyRid = Occ.recurrenceIdForStart(new Date('2026-12-08T12:00:00.000Z'), false);
const timeOnlyMaster = {
  ...weeklyMaster,
  title: 'Weekly sync',
  ics_occurrence_overrides: {
    [timeOnlyRid]: {
      title: 'Weekly sync',
      start: '2026-12-08T14:00:00.000Z',
      end: '2026-12-08T15:00:00.000Z',
      all_day: false,
    },
  },
  ics_exdates: [timeOnlyRid],
};
const timeOnlyPlan = Occ.planPreserveOverridesOnSeriesEdit(timeOnlyMaster, {
  start: '2026-11-03T13:00:00.000Z',
  end: '2026-11-03T14:00:00.000Z',
  all_day: false,
  title: 'Weekly sync',
  location: '',
  notes: '',
});
assert.strictEqual(timeOnlyPlan.resetCount, 0);
assert.strictEqual(timeOnlyPlan.ics_occurrence_overrides[timeOnlyRid].start, '2026-12-08T14:00:00.000Z');
const timeOnlyEv = {
  ...timeOnlyMaster,
  start: '2026-11-03T13:00:00.000Z',
  end: '2026-11-03T14:00:00.000Z',
  ...timeOnlyPlan,
};
occ = expandRaw(timeOnlyEv, new Date('2026-11-01'), new Date('2026-12-15'));
const timeOnlyOcc = occ.find((o) => o.start.toISOString() === '2026-12-08T14:00:00.000Z');
assert.ok(timeOnlyOcc);
assert.strictEqual(timeOnlyOcc.displayTitle, 'Weekly sync');

const retitlePlan = Occ.planPreserveOverridesOnSeriesEdit(weeklyMaster, {
  start: weeklyMaster.start,
  end: weeklyMaster.end,
  all_day: false,
  title: 'New series title',
  location: '',
  notes: '',
});
const nov24NewRid = Occ.recurrenceIdForStart(nov24, false);
assert.strictEqual(
  retitlePlan.ics_occurrence_overrides[nov24NewRid].title,
  'Beta v53 one-off',
);

const allDayReset = Occ.planPreserveOverridesOnSeriesEdit(weeklyMaster, {
  start: '2026-11-03T00:00:00.000Z',
  end: '2026-11-04T00:00:00.000Z',
  all_day: true,
  title: weeklyMaster.title,
});
assert.strictEqual(allDayReset.resetCount, 1);
assert.deepStrictEqual(allDayReset.ics_occurrence_overrides, {});

const agendaSrc = fs.readFileSync(path.join(root, 'app/static/js/agenda.js'), 'utf8');
assert.ok(agendaSrc.includes('agenda-scope-reset-panel'));
assert.ok(agendaSrc.includes('openScopeChooserSeriesReset'));
assert.ok(agendaSrc.includes('seriesOverrideResetMessage'));

console.log('test_agenda_occurrence ok');
