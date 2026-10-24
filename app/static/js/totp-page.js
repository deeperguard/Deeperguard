(function () {
  const form = document.getElementById('totp-form');
  if (!form) return;
  const csrf = form.dataset.csrf || '';
  const err = document.getElementById('totp-error');

  async function bootCredentials() {
    const email = String((function () {
      try { return localStorage.getItem('notes_email') || ''; } catch (e) { return ''; }
    })()).trim().toLowerCase();
    let password = '';
    if (window.NotesVaultSecrets?.peekBootPassword) {
      try { password = await NotesVaultSecrets.peekBootPassword(); } catch (e) { password = ''; }
    }
    return { email, password };
  }

  async function finishSrpKdfUpgradeIfNeeded() {
    let pending = false;
    try { pending = sessionStorage.getItem('notes_srp_kdf_upgrade') === '1'; } catch (e) { /* ignore */ }
    if (!pending || !window.NotesSrpAuth?.maybeUpgradeSrpKdf) return;
    const { email, password } = await bootCredentials();
    if (!email || !password) return;
    try {
      sessionStorage.setItem('notes_csrf', csrf);
    } catch (e) { /* ignore */ }
    await NotesSrpAuth.maybeUpgradeSrpKdf(email, password, {
      srp_kdf_upgrade: true,
      csrf,
    });
    try { sessionStorage.removeItem('notes_srp_kdf_upgrade'); } catch (e) { /* ignore */ }
  }

  async function finishLegacySrpUpgradeIfNeeded() {
    let pending = false;
    try { pending = sessionStorage.getItem('notes_srp_legacy_upgrade') === '1'; } catch (e) { /* ignore */ }
    if (!pending || !window.NotesSrpAuth?.upgrade) return;
    const { email, password } = await bootCredentials();
    if (!email || !password) return;
    try {
      sessionStorage.setItem('notes_csrf', csrf);
    } catch (e) { /* ignore */ }
    await NotesSrpAuth.upgrade(email, password);
    try { sessionStorage.removeItem('notes_srp_legacy_upgrade'); } catch (e) { /* ignore */ }
  }

  async function finishVaultRecoveryIfNeeded() {
    let pending = false;
    try { pending = sessionStorage.getItem('notes_vault_recovery') === '1'; } catch (e) { /* ignore */ }
    if (!pending || !window.NotesSrpAuth?.vaultRecovery) return;
    const { email, password } = await bootCredentials();
    if (!email || !password) return;
    try {
      sessionStorage.setItem('notes_csrf', csrf);
    } catch (e) { /* ignore */ }
    await NotesSrpAuth.vaultRecovery(email, password);
    try { sessionStorage.removeItem('notes_vault_recovery'); } catch (e) { /* ignore */ }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (err) err.hidden = true;
    const code = new FormData(form).get('code');
    const res = await fetch('/api/totp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      try { sessionStorage.setItem('notes_allow_boot_unlock', '1'); } catch (e) {}
      try { sessionStorage.setItem('notes_post_login_unlock', '1'); } catch (e) {}
      try { await finishSrpKdfUpgradeIfNeeded(); } catch (e) { /* login succeeded; retry later */ }
      try { await finishLegacySrpUpgradeIfNeeded(); } catch (e) { /* leftover Argon2; retry next login */ }
      try { await finishVaultRecoveryIfNeeded(); } catch (e) { /* verifier realign; retry next unlock */ }
      let next = '/app';
      try {
        const note = new URLSearchParams(location.search).get('note') || '';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(note)) {
          next = `/app?note=${encodeURIComponent(note)}`;
        }
      } catch (e) { /* ignore */ }
      location.replace(next);
      return;
    }
    // After 2FA at the session soft-cap: hand the device list to /login (no IP leak before TOTP).
    if (data.code === 'session_cap') {
      try {
        sessionStorage.setItem('notes_session_cap', JSON.stringify({
          message: data.error || 'Device limit reached',
          sessions: Array.isArray(data.sessions) ? data.sessions : [],
          revokeToken: data.revoke_token || '',
          limit: data.limit,
          plan: data.plan || '',
        }));
      } catch (e) { /* ignore */ }
      location.replace('/login');
      return;
    }
    if (err) {
      err.textContent = data.error || 'Invalid code';
      err.hidden = false;
    }
  });
})();
