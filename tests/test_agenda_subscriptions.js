/** Feed subscriptions: parser + dedupe reuse, refresh upsert/prune, delete, lock, no URL leaks. Fake links only. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');
const FEED_URL = 'https://feed.example.invalid/cal.ics?token=TEST';

// Capture every console call: the link must never show up there.
const logged = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  console[k] = (...args) => logged.push(args.map(String).join(' '));
}
const ok = (msg) => process.stdout.write(msg + '\n');

global.window = global;
global.addEventListener = () => {};
const mem = () => ({ s: {}, getItem(k) { return k in this.s ? this.s[k] : null; }, setItem(k, v) { this.s[k] = String(v); }, removeItem(k) { delete this.s[k]; } });
global.localStorage = mem();
global.sessionStorage = mem();
global.NotesIDB = new Proxy({}, { get: () => async () => null });
global.fetch = async () => { throw new Error('no network in tests'); };
global.NotesSanitize = require(path.join(jsRoot, 'sanitize.js'));
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'vendor', 'noble-crypto.js'), 'utf8'));
global.NotesCrypto = require(path.join(jsRoot, 'crypto.js'));
const RealStore = require(path.join(jsRoot, 'store.js'));
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'agenda-ics.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'agenda-subscriptions.js'), 'utf8'));
const Subs = global.NotesAgendaSubs;
const Ics = global.NotesAgendaIcs;

const ev = (uid, summary, extra) => 'BEGIN:VEVENT\r\nUID:' + uid + '\r\nSUMMARY:' + summary
  + '\r\nDTSTART:20260101T100000Z\r\nDTEND:20260101T110000Z\r\n' + (extra || '') + 'END:VEVENT\r\n';
const over = (uid, s) => 'BEGIN:VEVENT\r\nUID:' + uid + '\r\nRECURRENCE-ID:20260108T100000Z\r\nSUMMARY:' + s
  + '\r\nDTSTART:20260108T120000Z\r\nDTEND:20260108T130000Z\r\nEND:VEVENT\r\n';
const cal = (b) => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + b + 'END:VCALENDAR\r\n';

// Fake store: real pure pack functions from store.js, in-memory pack, lockable.
let pack = { type: 'agenda_pack', version: 1, events: {}, subscriptions: {} };
let isOpen = true;
const FakeStore = {
  isUnlocked: () => isOpen,
  listAgendaSubscriptions: () => Object.values(pack.subscriptions || {}),
  getAgendaSubscription: (id) => (pack.subscriptions || {})[id] || null,
  updateAgendaSubscription(id, patch) {
    pack.subscriptions[id] = { ...pack.subscriptions[id], ...patch };
  },
  refreshAgendaSubscriptionRows(id, rows, opts) {
    const r = RealStore.applySubscriptionRefresh(pack, id, rows, opts);
    if (r && r.content) pack = r.content;
    return r;
  },
  removeAgendaSubscription(id) {
    const r = RealStore.applySubscriptionRemoval(pack, id);
    pack = r.content;
    return r;
  },
};
Subs._setStore(FakeStore);
let feed = '';
let fetches = 0;
let parseCalls = 0;
const realParse = Ics.parseIcsFile;
Ics.parseIcsFile = (t) => { parseCalls += 1; return realParse(t); };
Subs._setFetcher(async (url) => {
  fetches += 1;
  assert.strictEqual(url, FEED_URL);
  return typeof feed === 'string' ? { ok: true, text: feed } : feed;
});

const subEvents = (id) => Object.entries(pack.events).filter(([, e]) => e.subscription_id === id);

(async () => {
  // URL normalisation: webcal → https, http and userinfo refused; error text has no URL.
  assert.strictEqual(Subs.normalizeFeedUrl('webcal://feed.example.invalid/cal.ics?token=TEST'), FEED_URL);
  assert.strictEqual(Subs.normalizeFeedUrl('webcals://feed.example.invalid/cal.ics?token=TEST'), FEED_URL);
  for (const bad of ['http://feed.example.invalid/cal.ics?token=TEST', 'https://u:p@feed.example.invalid/x?token=TEST',
    'https://feed.example.invalid:8443/x?token=TEST', 'ftp://feed.example.invalid/?token=TEST', 'not a link token=TEST']) {
    assert.throws(() => Subs.normalizeFeedUrl(bad), (err) => err.code === 'E_URL'
      && !err.message.includes('token=TEST') && !err.message.includes('example.invalid'));
  }
  ok('ok url normalisation');

  // A manual (file-imported) event with the same UID stays untouched.
  pack.events.manual = { type: 'agenda_event', ical_uid: 'a', title: 'Mine', start: 's', end: 'e' };
  pack.subscriptions.s1 = { id: 's1', name: 'Club', url: FEED_URL, mode: 'direct', last_refresh: null, last_error_code: null };

  // First refresh: series with an override + a plain event; goes through parseIcsFile.
  feed = cal(ev('a', 'One', 'RRULE:FREQ=WEEKLY\r\nEXDATE:20260115T100000Z\r\n') + over('a', 'Moved') + ev('b', 'Two'));
  let r = await Subs.refresh('s1');
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(parseCalls, 1);
  assert.deepStrictEqual([r.added, r.changed, r.removed], [2, 0, 0]);
  let mine = subEvents('s1');
  assert.strictEqual(mine.length, 2);
  const a = mine.find(([, e]) => e.ical_uid === 'a')[1];
  assert.strictEqual(Object.keys(a.ics_occurrence_overrides).length, 1, 'RECURRENCE-ID override merged into master');
  assert.strictEqual(a.ics_exdates.length, 1);
  assert.strictEqual(a.source, 'Club');
  assert.strictEqual(pack.events.manual.title, 'Mine');
  assert.ok(pack.subscriptions.s1.last_refresh);
  const idA = mine.find(([, e]) => e.ical_uid === 'a')[0];

  // Same feed again: nothing new (dedupe on UID + RECURRENCE-ID).
  r = await Subs.refresh('s1');
  assert.deepStrictEqual([r.added, r.changed, r.removed, r.unchanged], [0, 0, 0, 2]);

  // Changed + added + removed; override removed from the feed disappears.
  feed = cal(ev('a', 'One renamed', 'RRULE:FREQ=WEEKLY\r\n') + ev('c', 'Three'));
  r = await Subs.refresh('s1');
  assert.deepStrictEqual([r.added, r.changed, r.removed], [1, 1, 1]);
  mine = subEvents('s1');
  assert.deepStrictEqual(mine.map(([, e]) => e.ical_uid).sort(), ['a', 'c']);
  assert.strictEqual(pack.events[idA].title, 'One renamed', 'existing event id reused');
  assert.deepStrictEqual(pack.events[idA].ics_occurrence_overrides, {});
  assert.deepStrictEqual(pack.events[idA].ics_exdates, []);
  assert.ok(Object.values(pack.deleted_events).length === 1, 'removed event is tombstoned');
  ok('ok refresh upsert/prune');

  // Parse failure / non-ICS changes nothing and stores only a fixed code.
  const before = JSON.stringify(pack.events);
  feed = 'hello';
  r = await Subs.refresh('s1');
  assert.strictEqual(r.code, 'E_NOT_ICS');
  feed = { ok: false, code: 'E_NETWORK_OR_CORS' };
  r = await Subs.refresh('s1');
  assert.strictEqual(r.code, 'E_NETWORK_OR_CORS');
  assert.strictEqual(pack.subscriptions.s1.last_error_code, 'E_NETWORK_OR_CORS');
  assert.ok(/CORS/.test(Subs.errorText('E_NETWORK_OR_CORS')));
  assert.strictEqual(JSON.stringify(pack.events), before);

  // Locked vault: no fetch, no automatic refresh, no timer.
  isOpen = false;
  const n = fetches;
  assert.strictEqual((await Subs.refresh('s1')).code, 'E_LOCKED');
  assert.deepStrictEqual(await Subs.tick(Date.now() + 10 * Subs.AUTO_REFRESH_MS), []);
  Subs.start();
  assert.strictEqual(Subs._timerActive(), false);
  assert.strictEqual(fetches, n);
  isOpen = true;

  // Late response after lock is dropped.
  let release;
  Subs._setFetcher(() => new Promise((res) => { release = res; }));
  const pending = Subs.refresh('s1');
  Subs.stopAll();
  release({ ok: true, text: cal('') });
  assert.strictEqual((await pending).code, 'E_LOCKED');
  assert.strictEqual(subEvents('s1').length, 2);

  // Automatic refresh respects the 30-minute minimum.
  Subs._setFetcher(async () => { fetches += 1; return { ok: true, text: feed }; });
  feed = cal(ev('a', 'One renamed', 'RRULE:FREQ=WEEKLY\r\n') + ev('c', 'Three'));
  const last = Date.parse(pack.subscriptions.s1.last_refresh);
  const f0 = fetches;
  await Subs.tick(last + 29 * 60 * 1000);
  assert.strictEqual(fetches, f0);
  await Subs.tick(Date.now() + Subs.AUTO_REFRESH_MS);
  assert.strictEqual(fetches, f0 + 1);
  ok('ok lock and schedule');

  // Delete removes the subscription and only its events (tombstoned).
  const del = FakeStore.removeAgendaSubscription('s1');
  assert.strictEqual(del.removedEvents.length, 2);
  assert.strictEqual(subEvents('s1').length, 0);
  assert.ok(pack.events.manual);
  assert.ok(!pack.subscriptions.s1 && pack.deleted_subscriptions.s1);
  ok('ok delete with events');

  // Pack merge keeps subscriptions per id; tombstone beats an older edit.
  const merged = RealStore.mergeAgendaPacks(
    { events: {}, subscriptions: {}, deleted_subscriptions: { x: '2026-11-02T00:00:00Z' } },
    { events: {}, subscriptions: { x: { id: 'x', updated_at: '2026-11-01T00:00:00Z' }, y: { id: 'y', updated_at: '2026-11-01T00:00:00Z' } } },
    Date.parse('2026-11-03T00:00:00Z'),
  );
  assert.deepStrictEqual(Object.keys(merged.subscriptions), ['y']);

  // The link is only in the subscription record: not in events, labels, logs or storage.
  pack.subscriptions.s2 = { id: 's2', name: 'School', url: FEED_URL };
  Subs._setFetcher(async () => ({ ok: true, text: cal(ev('z', 'Z')) }));
  await Subs.refresh('s2');
  const { subscriptions, ...rest } = pack;
  const leakSurfaces = [JSON.stringify(rest), JSON.stringify(localStorage.s), JSON.stringify(sessionStorage.s), logged.join('\n')];
  for (const code of ['E_URL', 'E_NETWORK_OR_CORS', 'E_TIMEOUT', 'E_PARSE', 'E_LOCKED']) leakSurfaces.push(Subs.errorText(code));
  for (const s of leakSurfaces) {
    assert.ok(!s.includes('token=TEST') && !s.includes('feed.example.invalid'), 'link leaked');
  }
  ok('ok no link leaks');

  // Worker source: the request contract from the spec.
  const worker = fs.readFileSync(path.join(jsRoot, 'ics-fetch-worker.js'), 'utf8');
  for (const needle of ["method: 'GET'", "credentials: 'omit'", "referrerPolicy: 'no-referrer'", '2 * 1024 * 1024', '10000']) {
    assert.ok(worker.includes(needle), needle);
  }
  assert.ok(!/console\./.test(worker) && !/console\./.test(fs.readFileSync(path.join(jsRoot, 'agenda-subscriptions.js'), 'utf8')));
  assert.ok(!/innerHTML/.test(fs.readFileSync(path.join(jsRoot, 'agenda-subscriptions.js'), 'utf8')));
  ok('ok test_agenda_subscriptions');
})().catch((err) => {
  process.stderr.write(String(err && err.stack || err) + '\n');
  process.exit(1);
});
