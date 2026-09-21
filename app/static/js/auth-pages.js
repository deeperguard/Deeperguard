async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    localStorage.setItem('notes_email', String(email || '').trim().toLowerCase());
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

const registerForm = document.getElementById('register-form');
if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('register-error', '');
    const fd = new FormData(registerForm);
    const email = String(fd.get('email') || '').trim().toLowerCase();
    const password = String(fd.get('password') || '');
    const password2 = fd.get('password2');
    if (password.length < 12) {
      showError('register-error', 'Password must be at least 12 characters');
      return;
    }
    if (password !== password2) {
      showError('register-error', 'Passwords do not match');
      return;
    }
    try {
      const data = await NotesSrpAuth.register(email, password);
      await stashLoginSession(data, email, password);
      try { sessionStorage.setItem('notes_just_registered', '1'); } catch (e) { /* ignore */ }
      location.replace(afterAuthUrl('/app'));
    } catch (err) {
      showError('register-error', err.message);
    }
  });
}

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
