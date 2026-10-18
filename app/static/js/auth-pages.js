async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(function deviceHeaders() {
      try {
        let id = localStorage.getItem('notes_device_id') || '';
        if (!/^[A-Za-z0-9._-]{8,80}$/.test(id)) {
          id = (crypto.randomUUID && crypto.randomUUID())
            || `d${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
          localStorage.setItem('notes_device_id', id);
        }
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
  el.textContent = message;
  el.hidden = !message;
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
  if (data.password_changed_at) ackPasswordChanged(data.password_changed_at);
}

function mapPasswordSignInError(err) {
  if (!err) return err;
  if (err.status === 429) return err;
  const msg = String(err.message || '');
  if (err.status === 401 || err.repairExhausted || /invalid credentials/i.test(msg)) {
    const wrong = new Error('Incorrect password');
    wrong.incorrectPassword = true;
    wrong.status = err.status;
    return wrong;
  }
  if (/bad server credentials/i.test(msg)) {
    const wrong = new Error('Incorrect password');
    wrong.incorrectPassword = true;
    return wrong;
  }
  return err;
}

async function signInWithPassword(email, password) {
  if (!window.NotesSrpAuth?.passwordSignIn) {
    return postJson('/api/auth/repair-login', { email, password });
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
    const reason = new URLSearchParams(location.search).get('reason') || '';
    if (reason === 'signed-out') {
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
      const msg = String(err?.message || 'Sign-in failed');
      if (err?.status === 429 || /too many attempts/i.test(msg)) {
        showError('login-error', 'Too many sign-in attempts. Wait a few minutes and try again.');
        return;
      }
      if (err?.incorrectPassword || /incorrect password/i.test(msg)) {
        showError('login-error', 'Incorrect password');
        return;
      }
      if (/invalid credentials|bad server credentials/i.test(msg)) {
        showError('login-error', 'Incorrect password');
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

function passwordStrength(password) {
  const value = String(password || '');
  let score = 0;
  if (value.length >= 12) score += 1;
  if (value.length >= 16) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;
  if (value.length > 0 && value.length < 12) return { pct: '20%', color: '#dc2626', label: 'Too short — use at least 12 characters' };
  if (!value) return { pct: '0%', color: '#94a3b8', label: 'Password strength' };
  if (score <= 2) return { pct: '45%', color: '#d97706', label: 'Okay — add a mix of letters, numbers, or symbols' };
  if (score <= 3) return { pct: '70%', color: '#2563eb', label: 'Good' };
  return { pct: '100%', color: '#059669', label: 'Strong' };
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
    if (invalid) return;
    try {
      const data = await NotesSrpAuth.register(email, password);
      await stashLoginSession(data, email, password);
      try { sessionStorage.setItem('notes_just_registered', '1'); } catch (err) { /* ignore */ }
      location.replace(afterAuthUrl('/app'));
    } catch (err) {
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
