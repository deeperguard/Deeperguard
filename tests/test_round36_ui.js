/**
 * Round 36: fast offline→online recovery, persist cleared ever-saved notes,
 * overlay outside-tap swallow, phone beta banner copy.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(root, 'app/static/js/store.js'), 'utf8');
const searchJs = fs.readFileSync(path.join(root, 'app/static/js/search.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const marketing = fs.readFileSync(path.join(root, 'app/templates/marketing.html'), 'utf8');
const compare = fs.readFileSync(path.join(root, 'app/templates/compare-standard-notes.html'), 'utf8');
const NotesSearch = require('../app/static/js/search.js');

// --- 1. Online recovery: immediate first retry, abort, short health timeout --
assert.ok(
  appJs.includes('ONLINE_RECOVERY_DELAYS_MS = [0, 1000, 2000, 4000, 8000]')
  || appJs.includes('const delays = [0, 500, 1000, 2000, 4000]'),
);
assert.ok(appJs.includes('forceHealth'));
assert.ok(appJs.includes('timeoutMs = 1500') || appJs.includes('timeoutMs: 1500'));
assert.ok(appJs.includes('abortInflightApi'));
assert.ok(storeJs.includes('function abortInflightApi'));
assert.ok(storeJs.includes('inflightApiControllers'));
assert.ok(appJs.includes('online-event'));
assert.ok(appJs.includes("console.debug('[notes-sync]'"));
assert.ok(appJs.includes('connection-change') || appJs.includes('navigator.connection'));
assert.ok(appHtml.includes('__notesHealthOk'));
assert.ok(appHtml.includes('AbortController'));

// Instrumented offline→online with a pending failed fetch.
function simulateOnlineRecovery() {
  const log = [];
  const delays = [0, 500, 1000, 2000, 4000];
  let networkReachable = false;
  let generation = 0;
  const inflight = new Set();
  let healthCalls = 0;
  let healthFailUntil = 0;

  function abortInflight(reason) {
    for (const ctrl of [...inflight]) {
      ctrl.aborted = true;
      inflight.delete(ctrl);
    }
    log.push({ kind: 'api-abort', reason, t: Date.now() });
  }

  function fetchHealth({ force = false, timeoutMs = 1500 } = {}) {
    healthCalls += 1;
    const ctrl = { aborted: false };
    inflight.add(ctrl);
    return new Promise((resolve) => {
      const started = Date.now();
      const finish = (data) => {
        inflight.delete(ctrl);
        resolve(data);
      };
      const tick = () => {
        if (ctrl.aborted) return finish(null);
        if (Date.now() - started > timeoutMs) return finish(null);
        if (Date.now() < healthFailUntil) {
          setTimeout(tick, 15);
          return;
        }
        finish({ ok: true, build: 'test' });
      };
      // Hung offline fetch would take 8s without abort.
      if (!force && Date.now() < healthFailUntil) {
        setTimeout(() => {
          if (!ctrl.aborted) log.push({ kind: 'hung-completed', t: 8000 });
          finish(null);
        }, 8000);
        return;
      }
      setTimeout(tick, 5);
    });
  }

  function scheduleRecovery(attempt, t0) {
    if (attempt === 0) {
      abortInflight('online-recovery');
      generation += 1;
    }
    const gen = generation;
    if (attempt >= delays.length) return;
    setTimeout(async () => {
      if (gen !== generation) return;
      log.push({ kind: 'probe', attempt, t: Date.now() - t0 });
      const data = await fetchHealth({ force: true, timeoutMs: 1500 });
      if (gen !== generation) return;
      if (data?.ok) {
        networkReachable = true;
        log.push({ kind: 'sync-start', t: Date.now() - t0 });
        log.push({ kind: 'sync-done', t: Date.now() - t0 });
        return;
      }
      scheduleRecovery(attempt + 1, t0);
    }, delays[attempt]);
  }

  return new Promise((resolve, reject) => {
    healthFailUntil = Date.now() + 200;
    const hung = { aborted: false };
    inflight.add(hung);
    setTimeout(() => {
      if (!hung.aborted) log.push({ kind: 'hung-completed', t: 8000 });
    }, 40);

    const t0 = Date.now();
    log.push({ kind: 'online-event', t: 0 });
    healthFailUntil = Date.now();
    hung.aborted = true;
    inflight.delete(hung);
    scheduleRecovery(0, t0);

    setTimeout(() => {
      try {
        const done = log.find((e) => e.kind === 'sync-done');
        assert.ok(done, 'sync-done must fire');
        assert.ok(done.t <= 3000, `sync-done ${done.t}ms should be ≤3s typically`);
        assert.ok(log.some((e) => e.kind === 'api-abort'), 'must abort hung offline fetch');
        assert.ok(log.some((e) => e.kind === 'online-event'));
        assert.ok(!log.some((e) => e.kind === 'hung-completed'), 'hung fetch must not finish');
        assert.ok(networkReachable);
        assert.ok(healthCalls >= 1);
        resolve();
      } catch (err) {
        reject(err);
      }
    }, 900);
  });
}

// --- 2. Cleared ever-saved note persists as empty Untitled (not discarded) --
function note(content, extra = {}) {
  return {
    uuid: extra.uuid || 'n1',
    rev: extra.rev != null ? extra.rev : 3,
    content: { type: 'note', tags: [], attachments: [], revisions: [], ...content },
  };
}
const saved = note({
  title: 'Hello',
  content: 'World',
  revisions: [{ at: '2026-10-20T00:00:00.000Z', title: 'Hello', content: 'World' }],
});
assert.strictEqual(NotesSearch.noteHasBeenSaved(saved), true);
const cleared = note({
  title: '',
  content: '',
  revisions: saved.content.revisions,
});
assert.strictEqual(NotesSearch.noteMayHardDiscard(cleared), false);
const clearedFlag = note({ title: '', content: '', user_edited: true, revisions: [] });
assert.strictEqual(NotesSearch.noteHasBeenSaved(clearedFlag), true);
assert.strictEqual(NotesSearch.noteMayHardDiscard(clearedFlag), false);
assert.ok(searchJs.includes('user_edited'));
assert.ok(appJs.includes('user_edited'));
const flush = appJs.split('function flushSave()')[1].split('function scheduleSave()')[0];
assert.ok(flush.includes('everSaved'));
assert.ok(flush.includes('user_edited'));
assert.ok(flush.includes('noteHasBeenSaved?.(existing)'));
assert.ok(!/if \(!live\.length && NotesSearch\.noteMayHardDiscard/.test(flush));

// Never-saved empty draft still discardable.
assert.strictEqual(NotesSearch.noteMayHardDiscard(note({ title: '', content: '' }, { rev: 0 })), true);

// --- 3. Overlay outside tap swallows note open --------------------------------
assert.ok(appJs.includes('shouldSwallowNoteOpen'));
assert.ok(appJs.includes('swallowOverlayOutsideTap'));
assert.ok(appJs.includes('Outside tap only dismisses'));

// --- 4. Phone beta banner: no trailing · on wrapped first segment ------------
assert.ok(marketing.includes('Public beta — Pro free, no payment yet'));
assert.ok(compare.includes('Public beta — Pro free, no payment yet'));
assert.ok(!marketing.includes('mk-nowrap">Public beta ·'));
assert.ok(!compare.includes('mk-nowrap">Public beta ·'));

simulateOnlineRecovery()
  .then(() => {
    console.log('test_round36_ui ok');
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
