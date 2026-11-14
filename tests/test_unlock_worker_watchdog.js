/**
 * Unlock must never hang on "Checking…": a worker that never answers, crashes or
 * rejects must settle quickly, and a normal worker round-trip must still work.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');

let mode = 'silent';
const created = [];
class FakeWorker {
  constructor() {
    this.terminated = false;
    created.push(this);
  }
  postMessage(msg) {
    if (mode === 'silent') return;
    setTimeout(() => {
      if (mode === 'ok') {
        this.onmessage({ data: { id: msg.id, ok: true, result: { raw: 'AAAA', encoding: 'raw', version: 2 } } });
      } else if (mode === 'error') {
        this.onmessage({ data: { id: msg.id, ok: false, error: 'boom' } });
      } else if (mode === 'crash') {
        this.onerror(new Error('crash'));
      }
    }, 5);
  }
  terminate() {
    this.terminated = true;
  }
}
global.Worker = FakeWorker;
global.window = global;
global.document = { querySelector: () => null };

const NotesCrypto = require(path.join(jsRoot, 'crypto.js'));

async function settlesWithin(promise, ms) {
  let timer;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('still pending')), ms); });
  try {
    return await Promise.race([promise.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })), guard]);
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  assert.ok(NotesCrypto.workerEnabled());
  NotesCrypto.setWorkerTimeoutMs(100);

  // Normal path still works.
  mode = 'ok';
  const good = await settlesWithin(NotesCrypto.deriveKeyInWorker('pw', 'salt', { kdfVersion: 2 }), 1000);
  assert.ok(good.ok, 'normal worker derive must succeed');
  assert.strictEqual(good.v.version, 2);

  // Worker never answers -> rejected by watchdog, worker terminated.
  mode = 'silent';
  const silent = await settlesWithin(NotesCrypto.deriveKeyInWorker('pw', 'salt', { kdfVersion: 2 }), 1000);
  assert.ok(!silent.ok && /timed out/.test(silent.e.message));
  assert.ok(created[created.length - 1].terminated, 'hung worker must be terminated');

  // Worker rejects / crashes -> rejected quickly.
  mode = 'error';
  const err = await settlesWithin(NotesCrypto.deriveKeyInWorker('pw', 'salt', { kdfVersion: 2 }), 1000);
  assert.ok(!err.ok && /boom/.test(err.e.message));
  mode = 'crash';
  const crash = await settlesWithin(NotesCrypto.deriveKeyInWorker('pw', 'salt', { kdfVersion: 2 }), 1000);
  assert.ok(!crash.ok && /crashed/.test(crash.e.message));

  // A fresh worker is created afterwards and works again.
  mode = 'ok';
  const again = await settlesWithin(NotesCrypto.deriveKeyInWorker('pw', 'salt', { kdfVersion: 2 }), 1000);
  assert.ok(again.ok);

  // The unlock handler releases the button on every path (finally safety net).
  const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
  const submit = appJs.split('async function submitUnlockForm()')[1].split('unlockForm?.addEventListener')[0];
  assert.ok(submit.includes('} finally {') && submit.includes('resetLoginProgress()'));
  assert.ok(appJs.includes("'Deriving key…'") && appJs.includes("label: 'Opening vault'"));

  console.log('unlock worker watchdog tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
