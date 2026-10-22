(function () {
  const form = document.getElementById('totp-form');
  if (!form) return;
  const csrf = form.dataset.csrf || '';
  const err = document.getElementById('totp-error');

  async function finishSrpKdfUpgradeIfNeeded() {
    let pending = false;
    try { pending = sessionStorage.getItem('notes_srp_kdf_upgrade') === '1'; } catch (e) { /* ignore */ }
    if (!pending || !window.NotesSrpAuth?.maybeUpgradeSrpKdf) return;
    const email = String((function () {
      try { return localStorage.getItem('notes_email') || ''; } catch (e) { return ''; }
    })()).trim().toLowerCase();
    let password = '';
    if (window.NotesVaultSecrets?.peekBootPassword) {
      try { password = await NotesVaultSecrets.peekBootPassword(); } catch (e) { password = ''; }
    }
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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (err) err.hidden = true;
    const code = new FormData(form).get('code');
    const res = await fetch('/api/totp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      try { sessionStorage.setItem('notes_allow_boot_unlock', '1'); } catch (e) {}
      try { sessionStorage.setItem('notes_post_login_unlock', '1'); } catch (e) {}
      try { await finishSrpKdfUpgradeIfNeeded(); } catch (e) { /* login succeeded; retry later */ }
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
    const data = await res.json().catch(() => ({}));
    if (err) {
      err.textContent = data.error || 'Invalid code';
      err.hidden = false;
    }
  });
})();
