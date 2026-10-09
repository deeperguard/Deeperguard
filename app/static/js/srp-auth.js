/**
 * Thinbus-compatible SRP-6a client (SHA-256, RFC 5054 2048-bit).
 * Password never leaves the browser.
 */
(function (global) {
  'use strict';

  const N = BigInt(
    '217661744586174357731910088918027537819076683742555385111446432246898862353838'
    + '409572109090130860564015713997172358072665816496064721484102914133641521973644771'
    + '808873956554837381150726774022351017625219015698207402931495296204193332662620734'
    + '710545483687360395197024862265062488610602569718029849535611214426801576680007614'
    + '299882224570904138739739701719270939921147517651680636147611196154762334220964427'
    + '831179712363716473338714143358957734746673089670508070055093204247996784170368679'
    + '283167612722742303140675482911335824795830614395775593471019617714061736843785227'
    + '03483495337037655006751328447510550299250924469288819'
  );
  const G = 2n;
  const K = BigInt('0x5b9e8ef059c6b32ea59fc1d322d37f04aa30bae5aa9003b8321e21ddb04e300');

  function stripHex(hex) {
    let out = String(hex || '').toLowerCase();
    while (out.startsWith('0')) out = out.slice(1);
    return out;
  }

  async function sha256Hex(text) {
    const data = new TextEncoder().encode(String(text));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return stripHex(Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join(''));
  }

  function modPow(base, exp, mod) {
    let result = 1n;
    let b = base % mod;
    let e = exp;
    while (e > 0n) {
      if (e & 1n) result = (result * b) % mod;
      e >>= 1n;
      b = (b * b) % mod;
    }
    return result;
  }

  function randomNonZeroModN() {
    const byteLen = Math.ceil(N.toString(16).length / 2);
    while (true) {
      const buf = new Uint8Array(byteLen);
      crypto.getRandomValues(buf);
      let value = 0n;
      for (const byte of buf) value = (value << 8n) + BigInt(byte);
      value %= N;
      if (value !== 0n) return value;
    }
  }

  async function generateX(saltHex, identity, password) {
    let hash1 = await sha256Hex(`${identity}:${password}`);
    const concat = `${saltHex}${hash1}`.toUpperCase();
    let hash = await sha256Hex(concat);
    return BigInt(`0x${hash}`) % N;
  }

  class SrpClient {
    constructor() {
      this.identity = '';
      this.password = '';
      this.a = 0n;
      this.A = 0n;
      this.B = 0n;
      this.S = 0n;
      this.M1 = '';
      this.state = 0;
    }

    async generateRandomSalt() {
      const seed = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      return sha256Hex(`${Date.now()}::${seed}`);
    }

    async generateVerifier(saltHex, identity, password) {
      const x = await generateX(saltHex, identity, password);
      const v = modPow(G, x, N);
      return v.toString(16);
    }

    step1(identity, password) {
      this.identity = String(identity || '').trim().toLowerCase();
      this.password = String(password || '');
      this.state = 1;
    }

    async step2(saltHex, bHex) {
      if (this.state !== 1) throw new Error('SRP client not ready');
      bHex = String(bHex || '').toLowerCase();
      saltHex = String(saltHex || '').toLowerCase();
      this.B = BigInt(`0x${bHex}`);
      if (this.B % N === 0n) throw new Error('Invalid server public value');
      const x = await generateX(saltHex, this.identity, this.password);
      this.password = '';
      this.a = randomNonZeroModN();
      this.A = modPow(G, this.a, N);
      const aHex = this.A.toString(16).toLowerCase();
      const u = BigInt(`0x${await sha256Hex(aHex + bHex)}`);
      const exp = (u * x + this.a) % N;
      const tmp = (modPow(G, x, N) * K) % N;
      this.S = modPow((this.B - tmp + N) % N, exp, N);
      const sHex = this.S.toString(16).toLowerCase();
      this.M1 = await sha256Hex(aHex + bHex + sHex);
      this.aHex = aHex;
      this.state = 2;
      return { A: aHex, M1: this.M1 };
    }

    async step3(m2) {
      if (this.state !== 2) throw new Error('SRP client not ready');
      const aHex = this.aHex || this.A.toString(16).toLowerCase();
      let computed = await sha256Hex(aHex + this.M1 + this.S.toString(16).toLowerCase());
      m2 = stripHex(m2);
      if (computed !== m2) throw new Error('Bad server credentials');
      this.state = 3;
      return true;
    }
  }

  async function postJson(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    try {
      const csrf = sessionStorage.getItem('notes_csrf') || '';
      if (csrf) headers['X-CSRF-Token'] = csrf;
    } catch (err) {
      /* private mode / missing sessionStorage */
    }
    try {
      const device = (global.NotesStore && NotesStore.deviceId)
        ? NotesStore.deviceId()
        : (localStorage.getItem('notes_device_id') || '');
      if (device) headers['X-Device-Id'] = device;
    } catch (err) {
      /* ignore */
    }
    const res = await fetch(path, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      let message = data.error || `HTTP ${res.status}`;
      if (res.status === 405) {
        message = 'Sign-in failed — reload the page and try again.';
      }
      const err = new Error(message);
      err.status = res.status;
      if (data.repair_exhausted) err.repairExhausted = true;
      throw err;
    }
    return data;
  }

  function shouldRetryWithRepairAfterSrp(srpErr) {
    if (!srpErr) return false;
    if (srpErr.status === 429) return false;
    if (srpErr.status === 401) return true;
    if (srpErr.repairExhausted) return true;
    const msg = String(srpErr.message || '');
    if (/invalid credentials|login expired/i.test(msg)) return true;
    return false;
  }

  /**
   * Prove the password against the account's *stored* SRP verifier (server returns the
   * stored salt + B), then rotate to a freshly generated salt/verifier. The server rejects
   * proofs that do not match the credentials on file.
   */
  async function credentialProofLogin(challengePath, loginPath, email, password) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const rotated = await makeVerifier(normalizedEmail, password);
    const challenge = await postJson(challengePath, { email: normalizedEmail });
    const client = new SrpClient();
    client.step1(normalizedEmail, password);
    const creds = await client.step2(challenge.srp_salt, challenge.B);
    return postJson(loginPath, {
      email: normalizedEmail,
      srp_salt: rotated.srp_salt,
      srp_verifier: rotated.srp_verifier,
      A: creds.A,
      M1: creds.M1,
    });
  }

  async function repairLogin(email, password) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    return credentialProofLogin(
      '/api/auth/repair-login/challenge',
      '/api/auth/repair-login',
      normalizedEmail,
      password,
    );
  }

  /**
   * SRP sign-in with repair-login fallback (PWA login + in-app session refresh).
   * Only retries repair on credential-style SRP failures, not network/5xx.
   */
  async function passwordSignIn(email, password, options) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const onStatus = options && typeof options.onStatus === 'function' ? options.onStatus : null;
    if (login) {
      if (onStatus) onStatus('Verifying sign-in…');
      try {
        return await login(normalizedEmail, password);
      } catch (srpErr) {
        if (srpErr?.status === 429) throw srpErr;
        if (!shouldRetryWithRepairAfterSrp(srpErr)) throw srpErr;
      }
    }
    if (onStatus) onStatus('Repairing sign-in…');
    return repairLogin(normalizedEmail, password);
  }

  async function register(email, password) {
    const client = new SrpClient();
    const srpSalt = await client.generateRandomSalt();
    const verifier = await client.generateVerifier(srpSalt, email, password);
    return postJson('/api/auth/srp/register', {
      email,
      srp_salt: srpSalt,
      srp_verifier: verifier,
    });
  }

  async function login(email, password) {
    const client = new SrpClient();
    client.step1(email, password);
    const challenge = await postJson('/api/auth/srp/challenge', { email });
    const creds = await client.step2(challenge.srp_salt, challenge.B);
    const result = await postJson('/api/auth/srp/verify', {
      email,
      A: creds.A,
      M1: creds.M1,
    });
    if (!result.M2) {
      const err = new Error('Sign-in failed — server did not complete mutual authentication');
      err.status = 401;
      throw err;
    }
    await client.step3(result.M2);
    return result;
  }

  async function upgrade(email, password) {
    const client = new SrpClient();
    const srpSalt = await client.generateRandomSalt();
    const verifier = await client.generateVerifier(srpSalt, email, password);
    return postJson('/api/auth/srp/upgrade', {
      current_password: password,
      srp_salt: srpSalt,
      srp_verifier: verifier,
    });
  }

  async function makeVerifier(email, password, srpSalt) {
    const client = new SrpClient();
    const salt = srpSalt || await client.generateRandomSalt();
    const verifier = await client.generateVerifier(salt, email, password);
    return { srp_salt: salt, srp_verifier: verifier };
  }

  async function resync(email, password) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const srp = await makeVerifier(normalizedEmail, password);
    return postJson('/api/auth/srp/resync', {
      email: normalizedEmail,
      password,
      srp_salt: srp.srp_salt,
      srp_verifier: srp.srp_verifier,
    });
  }

  async function verifyVault(email, password) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    return postJson('/api/auth/verify-vault', {
      email: normalizedEmail,
      password,
    });
  }

  async function vaultRecovery(email, password) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    return credentialProofLogin(
      '/api/auth/vault-recovery/challenge',
      '/api/auth/vault-recovery',
      normalizedEmail,
      password,
    );
  }

  global.NotesSrpAuth = {
    SrpClient,
    register,
    login,
    upgrade,
    makeVerifier,
    resync,
    verifyVault,
    vaultRecovery,
    repairLogin,
    passwordSignIn,
    shouldRetryWithRepairAfterSrp,
  };
})(typeof window !== 'undefined' ? window : globalThis);
