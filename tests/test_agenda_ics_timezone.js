/**
 * ICS timed export uses UTC Z; verify roundtrip under UTC and America/Los_Angeles.
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const icsPath = path.join(root, 'app/static/js/agenda-ics.js');

function runWithTz(tz) {
  const script = `
    process.env.TZ = ${JSON.stringify(tz)};
    const fs = require('fs');
    const vm = require('vm');
    const Ics = (() => {
      vm.runInThisContext(fs.readFileSync(${JSON.stringify(icsPath)}), 'utf8');
      return global.NotesAgendaIcs;
    })();
    const start = new Date(2026, 2, 8, 10, 30, 0);
    const end = new Date(2026, 2, 8, 11, 0, 0);
    const cal = Ics.buildIcsCalendarFromEvents([{
      id: 'dst',
      ical_uid: 'dst-1',
      title: 'Spring',
      start: start.toISOString(),
      end: end.toISOString(),
      all_day: false,
    }]);
    const back = Ics.parseIcsFile(cal).events[0];
    if (back.start !== start.toISOString() || back.end !== end.toISOString()) {
      process.exit(1);
    }
    if (!cal.includes('DTSTART:20260308') || !cal.includes('Z')) process.exit(2);
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`TZ ${tz} failed: ${r.status} stderr=${r.stderr} stdout=${r.stdout}`);
  }
}

runWithTz('UTC');
runWithTz('America/Los_Angeles');

console.log('test_agenda_ics_timezone ok');
