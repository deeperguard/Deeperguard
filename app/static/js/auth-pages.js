async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(function deviceHeaders() {
      try {
        const id = (typeof NotesSrpAuth !== 'undefined' && NotesSrpAuth.ensureDeviceId)
          ? NotesSrpAuth.ensureDeviceId()
          : '';
        return id ? { 'X-Device-Id': id } : {};
      } catch (err) {
        return {};
      }
    }()) },
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

const NOTE_DEEP_LINK_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep `?note=<uuid>` from time-warning emails across the login → app hop. */
function afterAuthUrl(path) {
  try {
    const note = new URLSearchParams(location.search).get('note') || '';
    if (NOTE_DEEP_LINK_RE.test(note)) return `${path}?note=${encodeURIComponent(note)}`;
  } catch (err) { /* ignore */ }
  return path;
}

function showError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  // Clear first so a repeated "Email or password is incorrect" is announced again.
  el.hidden = true;
  el.textContent = '';
  if (!message) return;
  window.setTimeout(() => {
    if (!document.getElementById(id)) return;
    el.textContent = message;
    el.hidden = false;
  }, 20);
}

function setLoginBusy(busy, message) {
  const btn = document.querySelector('#login-form button[type="submit"]');
  const passkeyBtn = document.getElementById('webauthn-login');
  const status = document.getElementById('login-status');
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? 'Signing in…' : 'Sign in';
  }
  if (passkeyBtn) passkeyBtn.disabled = busy;
  if (status) {
    status.textContent = message || '';
    status.hidden = !message;
  }
}

function ackPasswordChanged(at) {
  const ts = Number(at) || 0;
  if (!ts) return;
  try {
    localStorage.setItem('notes_password_ack_at', String(ts));
  } catch (e) { /* ignore */ }
}

async function stashLoginSession(data, email, password) {
  try {
    const nextEmail = String(email || '').trim().toLowerCase();
    const previousEmail = String(localStorage.getItem('notes_email') || '').trim().toLowerCase();
    // The pre-upgrade local database was shared by every account on this
    // device; it stays with the account that was using it. Other accounts get
    // their own database (see NotesIDB), so a sign-in never reads another
    // account's notes.
    if (previousEmail && previousEmail !== nextEmail && !localStorage.getItem('notes_idb_owner')) {
      localStorage.setItem('notes_idb_owner', previousEmail);
    }
    localStorage.setItem('notes_email', nextEmail);
    if (data.kdf_salt) localStorage.setItem('notes_kdf_salt', data.kdf_salt);
    if (data.vault_kdf_version) localStorage.setItem('notes_vault_kdf_version', String(data.vault_kdf_version));
    if (data.csrf) sessionStorage.setItem('notes_csrf', data.csrf);
  } catch (e) { /* ignore */ }
  if (data.kdf_salt) {
    try { sessionStorage.setItem('notes_kdf_salt', data.kdf_salt); } catch (e) { /* ignore */ }
  }
  if (window.NotesVaultSecrets) {
    await NotesVaultSecrets.stashBootPassword(password);
  }
  try { sessionStorage.setItem('notes_allow_boot_unlock', '1'); } catch (e) { /* ignore */ }
  try {
    if (password) sessionStorage.setItem('notes_boot_password_ready', '1');
    else sessionStorage.removeItem('notes_boot_password_ready');
  } catch (e) { /* ignore */ }
  try { sessionStorage.setItem('notes_sync_after_login', '1'); } catch (e) { /* ignore */ }
  // Suppress false vault-rotation from a prior SRP KDF upgrade bump until unlock.
  try { sessionStorage.setItem('notes_post_login_unlock', '1'); } catch (e) { /* ignore */ }
  try {
    if (data.srp_kdf_upgrade) sessionStorage.setItem('notes_srp_kdf_upgrade', '1');
    else sessionStorage.removeItem('notes_srp_kdf_upgrade');
    if (data.auth_method && data.auth_method !== 'srp') {
      sessionStorage.setItem('notes_srp_legacy_upgrade', '1');
    } else {
      sessionStorage.removeItem('notes_srp_legacy_upgrade');
    }
  } catch (e) { /* ignore */ }
  if (data.password_changed_at) ackPasswordChanged(data.password_changed_at);
}

function mapPasswordSignInError(err) {
  if (!err) return err;
  if (err.status === 429) return err;
  const msg = String(err.message || '');
  if (err.status === 401 || err.repairExhausted || /invalid credentials/i.test(msg)) {
    const wrong = new Error('Email or password is incorrect');
    wrong.incorrectPassword = true;
    wrong.status = err.status;
    return wrong;
  }
  if (/bad server credentials/i.test(msg)) {
    const wrong = new Error('Email or password is incorrect');
    wrong.incorrectPassword = true;
    return wrong;
  }
  return err;
}

function showSecureSignInReload(errorId) {
  const el = document.getElementById(errorId || 'login-error');
  if (!el) return;
  el.hidden = false;
  el.textContent = '';
  const msg = document.createElement('span');
  msg.textContent = "Secure sign-in didn't load. Reload the page and try again.";
  el.appendChild(msg);
  el.appendChild(document.createElement('br'));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.id = 'login-srp-reload';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => {
    try { location.reload(); } catch (err) { /* ignore */ }
  });
  el.appendChild(btn);
}

async function signInWithPassword(email, password) {
  // Round 73: never POST {email, password} when the SRP client failed to load.
  if (!window.NotesSrpAuth?.passwordSignIn) {
    const err = new Error("Secure sign-in didn't load. Reload the page and try again.");
    err.srpMissing = true;
    throw err;
  }
  setLoginBusy(true, 'Signing in…');
  try {
    return await NotesSrpAuth.passwordSignIn(email, password, {
      onStatus: (message) => setLoginBusy(true, message),
    });
  } catch (err) {
    throw mapPasswordSignInError(err);
  }
}

const loginForm = document.getElementById('login-form');
if (loginForm) {
  try {
    const params = new URLSearchParams(location.search);
    const prefill = String(params.get('email') || '').trim();
    if (prefill) {
      const emailInput = loginForm.querySelector('[name="email"]');
      if (emailInput && !emailInput.value) emailInput.value = prefill;
    }
    const reason = params.get('reason') || '';
    if (reason === 'session-expired') {
      showError('login-error', 'Your session expired — please sign in again.');
    } else if (reason === 'signed-out') {
      showError(
        'login-error',
        'This device was signed out remotely. Local vault data on this device was deleted. Sign in again to download your notes.',
      );
    }
  } catch (err) {
    /* ignore */
  }
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('login-error', '');
    const fd = new FormData(loginForm);
    const email = String(fd.get('email') || '').trim().toLowerCase();
    const password = String(fd.get('password') || '');
    if (!email) {
      showError('login-error', 'Enter your email');
      return;
    }
    if (!password) {
      showError('login-error', 'Enter your password');
      return;
    }
    setLoginBusy(true, 'Signing in…');
    try {
      const data = await signInWithPassword(email, password);
      setLoginBusy(true, 'Opening your vault…');
      await stashLoginSession(data, email, password);
      if (data.totp_required) {
        location.replace(afterAuthUrl('/totp'));
        return;
      }
      location.replace(afterAuthUrl('/app'));
    } catch (err) {
      setLoginBusy(false, '');
      if (err?.srpMissing) {
        showSecureSignInReload('login-error');
        return;
      }
      const msg = String(err?.message || 'Sign-in failed');
      if (err?.status === 429 || /too many attempts/i.test(msg)) {
        showError('login-error', 'Too many sign-in attempts. Wait a few minutes and try again.');
        return;
      }
      if (err?.incorrectPassword || /incorrect password|email or password is incorrect/i.test(msg)) {
        showError('login-error', 'Email or password is incorrect');
        return;
      }
      if (/invalid credentials|bad server credentials/i.test(msg)) {
        showError('login-error', 'Email or password is incorrect');
        return;
      }
      showError('login-error', msg);
    }
  });
}

function setFieldError(inputId, errorId, message) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
  if (error) {
    error.textContent = message || '';
    error.hidden = !message;
  }
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

const COMMON_PASSWORD_FRAGMENTS = [
  'password', 'qwerty', 'letmein', 'welcome', 'admin', 'iloveyou',
  'abc123', 'passw0rd', 'deeperguard', '111111', '000000', '123456',
];

function longestStepRun(value, rows) {
  const lower = String(value || '').toLowerCase();
  let longest = 1;
  const alphabets = rows || null;
  let run = 1;
  for (let i = 1; i < lower.length; i += 1) {
    let stepped = false;
    if (!alphabets) {
      const delta = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
      stepped = delta === 1 || delta === -1;
    } else {
      const prev = lower[i - 1];
      const cur = lower[i];
      stepped = alphabets.some((row) => {
        const a = row.indexOf(prev);
        const b = row.indexOf(cur);
        return a >= 0 && b >= 0 && Math.abs(a - b) === 1;
      });
    }
    if (stepped) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }
  return longest;
}

function passwordStrength(password) {
  const value = String(password || '');
  if (!value) return { pct: '0%', color: '#94a3b8', label: 'Password strength' };
  if (value.length < 12) {
    return { pct: '16%', color: '#dc2626', label: 'Too short — use at least 12 characters' };
  }

  const classTests = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/];
  const classes = classTests.filter((re) => re.test(value)).length;
  const unique = new Set(value).size;
  let charset = 0;
  if (/[a-z]/.test(value)) charset += 26;
  if (/[A-Z]/.test(value)) charset += 26;
  if (/\d/.test(value)) charset += 10;
  if (/[^A-Za-z0-9]/.test(value)) charset += 33;
  let bits = Math.log2(Math.max(charset, 1)) * value.length;

  const collapsed = value.replace(/(.)\1{2,}/g, '$1');
  if (collapsed.length < value.length) {
    bits *= Math.max(0.15, collapsed.length / value.length);
  }
  if (unique <= 3) bits *= 0.35;
  else if (unique < value.length * 0.45) bits *= 0.7;

  const patterned = Math.max(
    longestStepRun(value),
    longestStepRun(value, ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890']),
  );
  if (patterned >= 4) bits -= (patterned - 3) * 8;
  if (patterned >= 6) bits = Math.min(bits, classes >= 3 ? 40 : 24);

  const lower = value.toLowerCase();
  if (COMMON_PASSWORD_FRAGMENTS.some((word) => lower.includes(word))) {
    bits = Math.min(bits, 28);
  }

  const variedEnough = classes >= 3 || value.length >= 20;
  if (bits >= 60 && variedEnough && patterned < 6 && unique >= 8) {
    return { pct: '100%', color: '#059669', label: 'Strong' };
  }
  if (bits >= 36 && classes >= 2 && unique >= 6) {
    return { pct: '62%', color: '#d97706', label: 'Fair' };
  }
  return { pct: '34%', color: '#dc2626', label: 'Weak' };
}

function paintPasswordStrength(password) {
  const bar = document.getElementById('register-strength-bar');
  const label = document.getElementById('register-strength-label');
  const meter = passwordStrength(password);
  if (bar) {
    bar.style.setProperty('--pw-pct', meter.pct);
    bar.style.setProperty('--pw-color', meter.color);
  }
  if (label) label.textContent = meter.label;
}

function bindPasswordToggles(root) {
  (root || document).querySelectorAll('.password-toggle').forEach((toggle) => {
    if (toggle.dataset.bound === '1') return;
    toggle.dataset.bound = '1';
    toggle.addEventListener('click', () => {
      const input = document.getElementById(toggle.dataset.target || '');
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? 'Hide' : 'Show';
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });
}

const registerForm = document.getElementById('register-form');
if (registerForm) {
  bindPasswordToggles(registerForm);
  const emailInput = document.getElementById('register-email');
  const passwordInput = document.getElementById('register-password');
  const confirmInput = document.getElementById('register-password2');
  const termsInput = document.getElementById('register-terms');
  const recoverInput = document.getElementById('register-recover-ack');

  function syncConfirmError() {
    const password = String(passwordInput?.value || '');
    const confirm = String(confirmInput?.value || '');
    if (!confirm || password === confirm) {
      setFieldError('register-password2', 'register-password2-error', '');
      return;
    }
    setFieldError('register-password2', 'register-password2-error', 'Passwords do not match');
  }

  passwordInput?.addEventListener('input', () => {
    paintPasswordStrength(passwordInput.value);
    if (String(passwordInput.value || '').length >= 12) {
      setFieldError('register-password', 'register-password-error', '');
    }
    syncConfirmError();
  });
  confirmInput?.addEventListener('input', syncConfirmError);
  emailInput?.addEventListener('input', () => {
    if (emailInput.validity.valid) setFieldError('register-email', 'register-email-error', '');
  });
  termsInput?.addEventListener('change', () => {
    if (termsInput.checked) setFieldError('register-terms', 'register-terms-error', '');
  });
  recoverInput?.addEventListener('change', () => {
    if (recoverInput.checked) setFieldError('register-recover-ack', 'register-recover-error', '');
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('register-error', '');
    const email = String(emailInput?.value || '').trim().toLowerCase();
    const password = String(passwordInput?.value || '');
    const password2 = String(confirmInput?.value || '');
    let invalid = false;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFieldError('register-email', 'register-email-error', 'Enter a valid email address');
      invalid = true;
    } else {
      setFieldError('register-email', 'register-email-error', '');
    }
    if (password.length < 12) {
      setFieldError('register-password', 'register-password-error', 'Password must be at least 12 characters');
      invalid = true;
    } else {
      setFieldError('register-password', 'register-password-error', '');
    }
    if (password !== password2) {
      setFieldError('register-password2', 'register-password2-error', 'Passwords do not match');
      invalid = true;
    } else {
      setFieldError('register-password2', 'register-password2-error', '');
    }
    if (!termsInput?.checked) {
      setFieldError('register-terms', 'register-terms-error', 'Agree to the Terms and Privacy policy to create an account');
      invalid = true;
    } else {
      setFieldError('register-terms', 'register-terms-error', '');
    }
    if (!recoverInput?.checked) {
      setFieldError('register-recover-ack', 'register-recover-error', 'Confirm you understand this password cannot be recovered');
      invalid = true;
    } else {
      setFieldError('register-recover-ack', 'register-recover-error', '');
    }
    if (invalid) return;
    const turnstileWidget = document.querySelector('.cf-turnstile');
    const turnstileInput = document.querySelector('input[name="cf-turnstile-response"]');
    if (turnstileWidget && !String(turnstileInput?.value || '').trim()) {
      showError('register-error', 'Please complete the security check and try again.');
      return;
    }
    const submitBtn = registerForm.querySelector('[type="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating account…';
    }
    try {
      const company = String(document.getElementById('register-company')?.value || '');
      const data = await NotesSrpAuth.register(email, password, {
        company,
        cf_turnstile_response: turnstileInput ? String(turnstileInput.value || '') : '',
      });
      await stashLoginSession(data, email, password);
      try { sessionStorage.setItem('notes_just_registered', '1'); } catch (err) { /* ignore */ }
      try { sessionStorage.setItem('notes_verify_email_hint', '1'); } catch (err) { /* ignore */ }
      // One Argon2 run, in the worker, stashed so /app adoptDerivedVaultKey
      // skips a second derive. Paint before it so "Creating account…" is only SRP.
      if (data?.kdf_salt && window.NotesCrypto?.deriveKey && window.NotesVaultSecrets?.stashBootDerivedKey) {
        if (submitBtn) submitBtn.textContent = 'Preparing your vault…';
        await new Promise((resolve) => {
          if (typeof requestAnimationFrame !== 'function') {
            setTimeout(resolve, 0);
            return;
          }
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
        const version = Number(data.vault_kdf_version) === 1 ? 1 : 2;
        let derived;
        if (NotesCrypto.workerEnabled?.()) {
          try {
            derived = await NotesCrypto.deriveKeyInWorker(password, data.kdf_salt, { kdfVersion: version });
          } catch (err) {
            derived = await NotesCrypto.deriveKey(password, data.kdf_salt, { kdfVersion: version });
          }
        } else {
          derived = await NotesCrypto.deriveKey(password, data.kdf_salt, { kdfVersion: version });
        }
        await NotesVaultSecrets.stashBootDerivedKey(derived, data.kdf_salt, derived?.version || version);
      }
      location.replace(afterAuthUrl('/app'));
    } catch (err) {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create account';
      }
      showError('register-error', err.message);
    }
  });
}

document.getElementById('sign-out-create')?.addEventListener('click', async () => {
  const btn = document.getElementById('sign-out-create');
  const token = btn?.dataset.csrf || '';
  btn.disabled = true;
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': token },
    });
  } catch (err) { /* still leave the signed-in page */ }
  location.href = '/register';
});

const webauthnLoginBtn = document.getElementById('webauthn-login');
if (webauthnLoginBtn) {
  webauthnLoginBtn.addEventListener('click', async () => {
    showError('login-error', '');
    const emailInput = document.querySelector('#login-form [name="email"]');
    const email = String(emailInput?.value || '').trim().toLowerCase();
    if (!email) {
      showError('login-error', 'Enter your email first');
      return;
    }
    if (!window.PublicKeyCredential) {
      showError('login-error', 'Passkeys are not supported in this browser');
      return;
    }
    const hostError = NotesWebAuthn?.passkeyHostError?.();
    if (hostError) {
      showError('login-error', hostError);
      return;
    }
    setLoginBusy(true, 'Waiting for passkey…');
    try {
      const optRes = await postJson('/api/auth/webauthn/login/options', { email });
      const options = NotesWebAuthn.prepareAuthenticationOptions(optRes.options);
      const assertion = await navigator.credentials.get({ publicKey: options });
      if (!assertion) throw new Error('Passkey sign-in was cancelled');
      const data = await postJson('/api/auth/webauthn/login/verify', {
        email,
        credential: NotesWebAuthn.authenticationCredentialJson(assertion),
      });
      setLoginBusy(true, 'Opening your vault…');
      await stashLoginSession(data, email, '');
      if (data.totp_required) {
        location.replace(afterAuthUrl('/totp'));
        return;
      }
      location.replace(afterAuthUrl('/app'));
    } catch (err) {
      setLoginBusy(false, '');
      showError('login-error', err.message || 'Passkey sign-in failed');
    }
  });
}
