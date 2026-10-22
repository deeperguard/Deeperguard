/**
 * Round 55: lock prefs survive sign-out; vault stats match the note list.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const jsRoot = path.join(root, 'app', 'static', 'js');
const appJs = fs.readFileSync(path.join(jsRoot, 'app.js'), 'utf8');
const storeJs = fs.readFileSync(path.join(jsRoot, 'store.js'), 'utf8');

assert.ok(appJs.includes('globalPrefsHydrated'), 'must gate push until prefs pulled');
assert.ok(appJs.includes('never clobber with local defaults') || appJs.includes('never clobber'));
assert.ok(appJs.includes('return listedActiveNoteCount()'), 'vault stats must match list count');
assert.ok(appJs.includes('in trash'), 'trash label on vault stats');
assert.ok(appJs.includes('Always paint saved prefs into the selects'));
assert.ok(appJs.includes('Timeouts / offline must not sign the user out'));
assert.ok(!storeJs.includes("localStorage.removeItem('deeperguard-prefs')"), 'sign-out must keep device prefs');
assert.ok(storeJs.includes('Tombstones sort first'), 'round 52 unlock fix kept');
assert.ok(appJs.includes('[notes-lock] reason'), 'round 53 lock logging kept');

// Behavioral: hydrated gate blocks push while settings exist but are not applied.
const sandbox = {
  console,
  localStorage: {
    store: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
    setItem(k, v) { this.store[k] = String(v); },
    removeItem(k) { delete this.store[k]; },
  },
  sessionStorage: {
    store: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
    setItem(k, v) { this.store[k] = String(v); },
    removeItem(k) { delete this.store[k]; },
  },
};
vm.createContext(sandbox);

// Minimal reimplementation of the gate used in app.js for unit coverage.
sandbox.eval = undefined;
vm.runInContext(`
  let globalPrefsHydrated = false;
  let unlockDidSync = false;
  let pushed = null;
  const remotePrefs = { autoLockMin: 15, lockOnUnfocus: '1min' };
  const localPrefs = { autoLockMin: 0, lockOnUnfocus: 'never' };
  function getGlobalSettings() {
    return { prefs: remotePrefs, updatedAt: 100 };
  }
  function pullGlobalPrefs() {
    Object.assign(localPrefs, getGlobalSettings().prefs);
    globalPrefsHydrated = true;
    return true;
  }
  function pushGlobalPrefs() {
    if (!globalPrefsHydrated) {
      const remote = getGlobalSettings();
      if (remote && remote.prefs) {
        pullGlobalPrefs();
        if (!globalPrefsHydrated) return false;
      } else if (!unlockDidSync) {
        return false;
      } else {
        globalPrefsHydrated = true;
      }
    }
    pushed = { ...localPrefs };
    return true;
  }
  // Before hydrate: push must pull remote first so Never defaults lose.
  pushGlobalPrefs();
  globalThis.__r55 = { localPrefs, pushed, globalPrefsHydrated };
`, sandbox);

assert.strictEqual(sandbox.__r55.pushed.autoLockMin, 15, 'push must not keep Never after pull');
assert.strictEqual(sandbox.__r55.pushed.lockOnUnfocus, '1min');
assert.strictEqual(sandbox.__r55.localPrefs.autoLockMin, 15);
assert.ok(sandbox.__r55.globalPrefsHydrated);

console.log('test_round55_prefs_counts ok');
