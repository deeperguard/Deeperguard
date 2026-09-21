/**
 * Passkey registration and management (Settings → Security).
 */
(function (global) {
  'use strict';

  async function listPasskeys() {
    const data = await NotesStore.api('/api/auth/webauthn/credentials');
    return Array.isArray(data.credentials) ? data.credentials : [];
  }

  async function registerPasskey(preferredUrl) {
    if (!NotesWebAuthn?.supported()) {
      throw new Error('Passkeys are not supported in this browser');
    }
    const hostError = NotesWebAuthn.passkeyHostError(preferredUrl);
    if (hostError) throw new Error(hostError);
    const optRes = await NotesStore.api('/api/auth/webauthn/register/options', {
      method: 'POST',
      body: '{}',
    });
    const options = NotesWebAuthn.prepareRegistrationOptions(optRes.options);
    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) throw new Error('Passkey registration was cancelled');
    await NotesStore.api('/api/auth/webauthn/register/verify', {
      method: 'POST',
      body: JSON.stringify({
        credential: NotesWebAuthn.registrationCredentialJson(credential),
      }),
    });
  }

  async function removePasskey(credentialId) {
    await NotesStore.api('/api/auth/webauthn/remove', {
      method: 'POST',
      body: JSON.stringify({ credential_id: credentialId }),
    });
  }

  function formatPasskeyLabel(row, index) {
    const when = row.created_at
      ? new Date(row.created_at * 1000).toLocaleString()
      : `Passkey ${index + 1}`;
    const transport = String(row.transports || '').replace(/,/g, ', ') || 'device';
    return `${when} · ${transport}`;
  }

  async function renderPasskeyList(container, preferredUrl) {
    if (!container) return;
    container.replaceChildren();
    if (!NotesWebAuthn?.supported()) {
      const hint = document.createElement('p');
      hint.className = 'settings-hint';
      hint.textContent = 'Passkeys are not supported in this browser.';
      container.appendChild(hint);
      return;
    }
    const hostError = NotesWebAuthn.passkeyHostError(preferredUrl);
    if (hostError) {
      const hint = document.createElement('p');
      hint.className = 'settings-hint error';
      hint.textContent = hostError;
      container.appendChild(hint);
      const link = document.createElement('p');
      link.className = 'settings-hint';
      const url = preferredUrl || 'https://www.deeperguard.com/';
      link.textContent = `Use ${url.replace(/^https?:\/\//, '')} in Safari, then Settings → Refresh app cache.`;
      container.appendChild(link);
      return;
    }
    let rows = [];
    try {
      rows = await listPasskeys();
    } catch (err) {
      const hint = document.createElement('p');
      hint.className = 'settings-hint error';
      hint.textContent = err.message || 'Could not load passkeys';
      container.appendChild(hint);
      return;
    }
    if (!rows.length) {
      const hint = document.createElement('p');
      hint.className = 'settings-hint';
      hint.textContent = 'No passkeys yet. Add one to sign in without typing your password.';
      container.appendChild(hint);
      return;
    }
    rows.forEach((row, index) => {
      const item = document.createElement('div');
      item.className = 'settings-row passkey-row';
      const label = document.createElement('span');
      label.textContent = formatPasskeyLabel(row, index);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost sm';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await removePasskey(row.credential_id);
          await renderPasskeyList(container);
        } catch (err) {
          btn.disabled = false;
          throw err;
        }
      });
      item.append(label, btn);
      container.appendChild(item);
    });
  }

  global.NotesPasskeys = {
    listPasskeys,
    registerPasskey,
    removePasskey,
    renderPasskeyList,
  };
})(typeof window !== 'undefined' ? window : globalThis);
