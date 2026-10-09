/**
 * login() must fail when the server omits M2 (mutual authentication required).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const jsRoot = path.join(__dirname, '..', 'app', 'static', 'js');

global.sessionStorage = {
  store: {},
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
};

let fetchCalls = 0;
global.fetch = async (url) => {
  fetchCalls += 1;
  const pathOnly = String(url);
  if (pathOnly.includes('/api/auth/srp/challenge')) {
    return {
      ok: true,
      json: async () => ({
        srp_salt: 'abc',
        B: '1' + '0'.repeat(510),
      }),
    };
  }
  if (pathOnly.includes('/api/auth/srp/verify')) {
    return {
      ok: true,
      json: async () => ({ email: 'u@home.local', auth_method: 'srp' }),
    };
  }
  throw new Error(`unexpected fetch ${pathOnly}`);
};

vm.runInThisContext(fs.readFileSync(path.join(jsRoot, 'srp-auth.js'), 'utf8'));

(async () => {
  let failed = false;
  try {
    await NotesSrpAuth.login('u@home.local', 'password-12345678');
  } catch (err) {
    failed = true;
    assert.match(String(err.message), /mutual authentication/i);
  }
  assert.ok(failed, 'login must throw when M2 is missing');
  assert.ok(fetchCalls >= 2, 'challenge and verify should run before M2 check');
  console.log('ok login rejects missing M2');
})();
