/**
 * Passkey-only account sign-in: recovery codes and password-login toggle.
 */
(function (global) {
  'use strict';

  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    if (days > 0) return `${days} day${days === 1 ? '' : 's'}${hours ? ` ${hours} h` : ''}`;
    if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }

  function formatCountdown(untilTs) {
    const left = Math.max(0, Math.floor(untilTs - Date.now() / 1000));
    return formatDuration(left);
  }

  function waitLabel(seconds) {
    const s = Number(seconds) || 0;
    if (s >= 14 * 86400) return '14 days';
    if (s >= 7 * 86400) return '7 days';
    return '72 hours (minimum)';
  }

  async function fetchSignInMethods(email) {
    const res = await fetch('/api/auth/sign-in/methods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: String(email || '').trim().toLowerCase() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function renderRecoveryReveal(container, codes) {
    if (!container) return;
    container.replaceChildren();
    const warn = document.createElement('p');
    warn.className = 'settings-hint';
    warn.textContent =
      'Save these codes somewhere safe. Each code works once. They are for account sign-in only — your vault still needs your master password on this device.';
    container.appendChild(warn);
    const list = document.createElement('ul');
    list.className = 'recovery-code-list';
    (codes || []).forEach((code) => {
      const li = document.createElement('li');
      li.textContent = code;
      list.appendChild(li);
    });
    container.appendChild(list);
    const actions = document.createElement('div');
    actions.className = 'settings-actions';
    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.className = 'btn';
    printBtn.textContent = 'Print';
    printBtn.addEventListener('click', () => {
      const body = (codes || []).join('\n');
      const w = window.open('', '_blank', 'noopener');
      if (!w) return;
      w.document.write(`<pre>${body.replace(/</g, '&lt;')}</pre>`);
      w.document.close();
      w.print();
    });
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn ghost';
    copyBtn.textContent = 'Copy all';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText((codes || []).join('\n'));
        copyBtn.textContent = 'Copied';
      } catch (err) {
        copyBtn.textContent = 'Copy failed';
      }
    });
    actions.append(printBtn, copyBtn);
    container.appendChild(actions);
  }

  function bindPasskeySigninSettings(account) {
    const section = document.getElementById('passkey-signin-settings');
    if (!section) return;
    const statusEl = document.getElementById('passkey-signin-status');
    const waitSelect = document.getElementById('passkey-signin-wait');
    const genBtn = document.getElementById('btn-passkey-signin-generate-codes');
    const cancelBtn = document.getElementById('btn-passkey-signin-cancel-codes');
    const reveal = document.getElementById('passkey-signin-code-reveal');
    const toggle = document.getElementById('pref-disable-password-login');
    const toggleHint = document.getElementById('passkey-signin-toggle-hint');
    const passkeyCountEl = document.getElementById('passkey-signin-passkey-count');

    const ps = account?.passkey_signin || {};
    const passkeyCount = Number(ps.passkey_count) || 0;
    if (passkeyCountEl) {
      passkeyCountEl.textContent = `${passkeyCount} registered (need 2 for passkey-only sign-in)`;
    }

    if (waitSelect && Array.isArray(ps.wait_choices_seconds)) {
      waitSelect.replaceChildren();
      ps.wait_choices_seconds.forEach((sec) => {
        const opt = document.createElement('option');
        opt.value = String(sec);
        opt.textContent = waitLabel(sec);
        waitSelect.appendChild(opt);
      });
    }

    const recovery = ps.recovery || {};
    const state = String(recovery.state || 'none');
    let statusText = '';
    if (state === 'pending' && recovery.activates_at) {
      statusText = `Recovery codes activate in ${formatCountdown(recovery.activates_at)}. Until then, sign in with a passkey.`;
    } else if (state === 'active') {
      statusText = 'Recovery codes are active. Each code works once for account sign-in.';
    } else if (passkeyCount >= 2) {
      statusText = 'Generate one-time recovery codes before turning off password sign-in.';
    } else {
      statusText = 'Add a second passkey, then generate recovery codes.';
    }
    if (statusEl) {
      statusEl.textContent = statusText;
      statusEl.hidden = !statusText;
    }

    if (genBtn) {
      genBtn.disabled = passkeyCount < 2;
      genBtn.title = passkeyCount < 2 ? 'Register two passkeys first' : '';
    }
    if (cancelBtn) {
      cancelBtn.hidden = !recovery.can_cancel;
    }
    if (toggle) {
      toggle.checked = !!ps.password_login_disabled;
      const canDisable = !!ps.can_disable_password_login;
      toggle.disabled = !canDisable && !ps.password_login_disabled;
    }
    if (toggleHint) {
      if (ps.password_login_disabled) {
        toggleHint.textContent =
          'Password sign-in is off. Use a passkey or an active recovery code to sign in. Vault unlock still uses your master password on this device.';
      } else if (ps.disable_password_login_reason) {
        toggleHint.textContent = ps.disable_password_login_reason;
      } else {
        toggleHint.textContent =
          'When enabled, account sign-in is passkey or recovery codes only. This does not remove your vault password.';
      }
    }

    if (state === 'pending' && recovery.activates_at && !section.dataset.countdownTimer) {
      section.dataset.countdownTimer = '1';
      window.setInterval(() => {
        const psNow = section.__passkeySigninState;
        if (!psNow || psNow.recovery?.state !== 'pending') return;
        if (statusEl && psNow.recovery.activates_at) {
          statusEl.textContent = `Recovery codes activate in ${formatCountdown(psNow.recovery.activates_at)}. Until then, sign in with a passkey.`;
        }
      }, 30000);
    }
    section.__passkeySigninState = ps;

    if (!section.dataset.bound) {
      section.dataset.bound = '1';
      genBtn?.addEventListener('click', async () => {
        genBtn.disabled = true;
        try {
          const waitSeconds = Number(waitSelect?.value) || ps.wait_floor_seconds || 72 * 3600;
          const data = await NotesStore.api('/api/account/passkey-signin/recovery-codes', {
            method: 'POST',
            body: JSON.stringify({ wait_seconds: waitSeconds }),
          });
          renderRecoveryReveal(reveal, data.codes);
          if (reveal) reveal.hidden = false;
          if (typeof window.__notesRefreshAccountPasskeySignin === 'function') {
            await window.__notesRefreshAccountPasskeySignin();
          }
        } catch (err) {
          genBtn.disabled = false;
          throw err;
        }
      });
      cancelBtn?.addEventListener('click', async () => {
        cancelBtn.disabled = true;
        try {
          await NotesStore.api('/api/account/passkey-signin/recovery-codes/cancel', {
            method: 'POST',
            body: '{}',
          });
          if (reveal) {
            reveal.hidden = true;
            reveal.replaceChildren();
          }
          if (typeof window.__notesRefreshAccountPasskeySignin === 'function') {
            await window.__notesRefreshAccountPasskeySignin();
          }
        } finally {
          cancelBtn.disabled = false;
        }
      });
      toggle?.addEventListener('change', async () => {
        const wantDisabled = !!toggle.checked;
        toggle.disabled = true;
        try {
          await NotesStore.api('/api/account/passkey-signin/password-login', {
            method: 'POST',
            body: JSON.stringify({ disabled: wantDisabled }),
          });
          if (typeof window.__notesRefreshAccountPasskeySignin === 'function') {
            await window.__notesRefreshAccountPasskeySignin();
          }
        } catch (err) {
          toggle.checked = !wantDisabled;
          throw err;
        } finally {
          toggle.disabled = false;
        }
      });
    }
  }

  global.NotesPasskeySignin = {
    bindPasskeySigninSettings,
    fetchSignInMethods,
    formatCountdown,
    renderRecoveryReveal,
  };
})(typeof window !== 'undefined' ? window : globalThis);
