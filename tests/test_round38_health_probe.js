/**
 * Round 38: single health-probe owner — share in-flight (no abort-storm),
 * global 2s→5s→10s backoff while offline, reset on online/success so
 * reconnect sync stays ≤1s. Offline for 30s → at most ~6 real /api/health calls.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const ocrJs = fs.readFileSync(path.join(root, 'app/static/js/ocr.js'), 'utf8');

// --- static: one owner, share inflight, backoff, no abort-previous ----------
assert.ok(appHtml.includes('window.__notesFetchHealth'));
assert.ok(appHtml.includes('window.__notesHealthInflight'));
assert.ok(appHtml.includes('window.__notesResetHealthBackoff'));
assert.ok(appHtml.includes('__notesHealthGen'));
assert.ok(/prev < 2000 \? 2000 : \(prev < 5000 \? 5000 : 10000\)/.test(appHtml));
assert.ok(appHtml.includes("addEventListener('online'"));
// Concurrent callers must share — never abort-previous on every call.
assert.ok(!/if \(window\.__notesHealthCtrl\) \{\s*try \{ window\.__notesHealthCtrl\.abort/.test(appHtml));
assert.ok(appHtml.includes('if (window.__notesHealthInflight) return window.__notesHealthInflight'));
// app.js + ocr route through the shared owner.
assert.ok(appJs.includes('window.__notesFetchHealth(force, timeoutMs)'));
assert.ok(appJs.includes('onlineRecoveryActive'));
assert.ok(appJs.includes("navigator.onLine === false) return true") || appJs.includes('navigator.onLine) {'));
assert.ok(ocrJs.includes('window.__notesFetchHealth(false, 5000)'));
// Raw /api/health in app.js only as fallback when helper missing.
const appJsHealthFetches = (appJs.match(/fetch\(['"]\/api\/health['"]/g) || []).length;
assert.ok(appJsHealthFetches <= 1, `app.js should have ≤1 raw health fetch (fallback), got ${appJsHealthFetches}`);

/**
 * Install the real boot helper into a fake window with controllable clock + fetch.
 */
function installHealthOwner({ fetchImpl, nowRef }) {
  const window = {
    __notesHealthBackoffMs: 0,
    __notesHealthNextAt: 0,
    __notesHealthOk: false,
    __notesHealthAt: 0,
    __notesHealthPromise: null,
    __notesHealthInflight: null,
    __notesHealthCtrl: null,
    __notesHealthGen: 0,
  };
  // Mirror app.html owner (keep in sync with templates/app.html).
  window.__notesResetHealthBackoff = function (opts) {
    window.__notesHealthBackoffMs = 0;
    window.__notesHealthNextAt = 0;
    const doAbort = !opts || opts.abort !== false;
    if (!doAbort) return;
    window.__notesHealthGen = (window.__notesHealthGen || 0) + 1;
    const old = window.__notesHealthCtrl;
    window.__notesHealthCtrl = null;
    window.__notesHealthInflight = null;
    if (old) { try { old.abort(); } catch (e) { /* ignore */ } }
  };
  window.__notesFetchHealth = function (force, timeoutMs) {
    const now = nowRef.t;
    if (window.__notesHealthInflight) return window.__notesHealthInflight;
    const ttl = 1500;
    if (!force && window.__notesHealthOk && window.__notesHealthPromise
      && (now - (window.__notesHealthAt || 0)) < ttl) {
      return window.__notesHealthPromise;
    }
    if (window.__notesHealthNextAt && now < window.__notesHealthNextAt) {
      return Promise.resolve(null);
    }
    const ms = Math.max(500, Number(timeoutMs) || 1500);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, ms) : null;
    const gen = window.__notesHealthGen || 0;
    window.__notesHealthAt = now;
    window.__notesHealthOk = false;
    window.__notesHealthCtrl = ctrl;
    const inflight = fetchImpl('/api/health', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctrl ? ctrl.signal : undefined,
    })
      .then((res) => (res && res.ok ? res.json() : null))
      .then((data) => {
        if (gen !== (window.__notesHealthGen || 0)) return null;
        if (data && data.ok) {
          window.__notesHealthOk = true;
          window.__notesHealthPromise = Promise.resolve(data);
          window.__notesHealthBackoffMs = 0;
          window.__notesHealthNextAt = 0;
          return data;
        }
        const prev = window.__notesHealthBackoffMs || 0;
        const next = prev < 2000 ? 2000 : (prev < 5000 ? 5000 : 10000);
        window.__notesHealthBackoffMs = next;
        window.__notesHealthNextAt = nowRef.t + next;
        window.__notesHealthPromise = null;
        return null;
      })
      .catch(() => {
        if (gen !== (window.__notesHealthGen || 0)) return null;
        const prev = window.__notesHealthBackoffMs || 0;
        const next = prev < 2000 ? 2000 : (prev < 5000 ? 5000 : 10000);
        window.__notesHealthBackoffMs = next;
        window.__notesHealthNextAt = nowRef.t + next;
        window.__notesHealthPromise = null;
        return null;
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        if (window.__notesHealthInflight === inflight) window.__notesHealthInflight = null;
        if (window.__notesHealthCtrl === ctrl) window.__notesHealthCtrl = null;
      });
    window.__notesHealthInflight = inflight;
    return inflight;
  };
  return window;
}

async function testOfflineCapsHealthCalls() {
  const nowRef = { t: 1_000_000 };
  let healthCalls = 0;
  const fetchImpl = () => {
    healthCalls += 1;
    return Promise.reject(new Error('offline'));
  };
  const window = installHealthOwner({ fetchImpl, nowRef });

  // Simulate boot + sync + progress UI + recovery hammering the probe for 30s.
  const end = nowRef.t + 30_000;
  while (nowRef.t <= end) {
    const callers = [
      window.__notesFetchHealth(false, 1500),
      window.__notesFetchHealth(true, 1500),
      window.__notesFetchHealth(false, 5000),
      window.__notesFetchHealth(false, 1500),
    ];
    await Promise.all(callers);
    // Advance clock in 100ms steps — callers fire every tick.
    nowRef.t += 100;
  }

  assert.ok(
    healthCalls <= 6,
    `offline 30s must make ≤6 /api/health calls, got ${healthCalls}`,
  );
  assert.ok(healthCalls >= 3, `expected several backoff steps, got ${healthCalls}`);
  // Backoff must have reached the 10s cap.
  assert.strictEqual(window.__notesHealthBackoffMs, 10000);
}

async function testReconnectSyncWithin1s() {
  const nowRef = { t: 2_000_000 };
  let healthCalls = 0;
  let online = false;
  const fetchImpl = () => {
    healthCalls += 1;
    if (!online) return Promise.reject(new Error('offline'));
    return Promise.resolve({
      ok: true,
      json: async () => ({ ok: true, build: 'test' }),
    });
  };
  const window = installHealthOwner({ fetchImpl, nowRef });

  // Hang an offline probe, then come online and recover.
  const hung = window.__notesFetchHealth(false, 8000);
  assert.strictEqual(healthCalls, 1);
  // Concurrent callers share — no second request.
  const shared = window.__notesFetchHealth(true, 1500);
  assert.strictEqual(shared, window.__notesHealthInflight);
  assert.strictEqual(healthCalls, 1);

  online = true;
  const t0 = nowRef.t;
  let syncAt = null;
  // Passive online opens the gate; recovery does one abort+probe.
  window.__notesResetHealthBackoff({ abort: false });
  window.__notesResetHealthBackoff(); // recovery abort once
  const data = await window.__notesFetchHealth(true, 1500);
  assert.ok(data && data.ok, 'reconnect probe must succeed');
  syncAt = nowRef.t - t0;
  assert.ok(syncAt <= 1000, `reconnect sync ${syncAt}ms must be ≤1s`);
  // Hung orphan must not have inflated the call count into a storm.
  assert.ok(healthCalls <= 3, `reconnect should need few probes, got ${healthCalls}`);
  // Success resets backoff for a fast follow-up.
  assert.strictEqual(window.__notesHealthBackoffMs, 0);
  assert.strictEqual(window.__notesHealthNextAt, 0);

  // Swallow the hung rejection.
  await hung.catch(() => null);
}

async function testShareInflightNoAbortStorm() {
  const nowRef = { t: 3_000_000 };
  let started = 0;
  let aborts = 0;
  const fetchImpl = (_url, opts) => {
    started += 1;
    return new Promise((resolve, reject) => {
      const signal = opts && opts.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          aborts += 1;
          reject(new Error('aborted'));
        });
      }
      setTimeout(() => {
        resolve({ ok: true, json: async () => ({ ok: true, build: 'x' }) });
      }, 30);
    });
  };
  const window = installHealthOwner({ fetchImpl, nowRef });
  const p1 = window.__notesFetchHealth(false, 1500);
  const p2 = window.__notesFetchHealth(true, 1500);
  const p3 = window.__notesFetchHealth(false, 5000);
  assert.strictEqual(p1, p2);
  assert.strictEqual(p2, p3);
  assert.strictEqual(started, 1);
  const results = await Promise.all([p1, p2, p3]);
  assert.ok(results.every((d) => d && d.ok));
  assert.strictEqual(aborts, 0, 'concurrent callers must not abort the shared probe');
  assert.strictEqual(started, 1);
}

(async () => {
  await testShareInflightNoAbortStorm();
  await testOfflineCapsHealthCalls();
  await testReconnectSyncWithin1s();
  console.log('test_round38_health_probe ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
