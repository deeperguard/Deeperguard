/**
 * Docs + copy: .ics import help explains direct feed subscriptions and the manual fallback,
 * and SECURITY.md / PRIVACY.md state the import model with the real caps.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('app/templates/app.html');
const security = read('SECURITY.md');
const privacy = read('docs/PRIVACY.md');
const ics = read('app/static/js/agenda-ics.js');

// In-app help for feed-only calendars.
assert.ok(html.includes('Your browser fetches it straight from the provider; the link never passes through Deeperguard'));
assert.ok(html.includes('Open the link in a new browser tab, save the .ics file, then import it here.'));
assert.ok(html.includes('the link never passes through Deeperguard'));
assert.ok(html.includes('On iOS, the system may offer to add the events to the Calendar app instead of saving a file.'));

// Caps quoted in the docs match the parser.
assert.ok(/MAX_ICS_BYTES = 10 \* 1024 \* 1024/.test(ics));
assert.ok(/MAX_ICS_EVENTS = 10000/.test(ics));
for (const doc of [security, privacy]) {
  assert.ok(doc.includes('10 MB'));
  assert.ok(doc.includes('10,000'));
  assert.ok(/fetche[sd] directly by your browser|your browser fetches it directly/i.test(doc));
  assert.ok(/does not fetch feed URLs on the server|no(?:t use)? server-side fetching/i.test(doc));
  assert.ok(/encrypted before storage/i.test(doc));
}

// Section anchor used by PRIVACY.md resolves to a heading in SECURITY.md.
assert.ok(security.includes('## Calendar (.ics) import'));
assert.ok(privacy.includes('../SECURITY.md#calendar-ics-import'));

// Docs must not contain feed URLs or tokens.
assert.ok(!/https?:\/\/[^\s)]*\?token=/i.test(security + privacy));
assert.ok(!/webcal:\/\//i.test(security + privacy));

console.log('ok test_agenda_ics_feed_help_doc');
