/**
 * Passkey registration and management (Settings → Security).
 */
(function (global) {
  'use strict';

  let passkeyListRenderToken = 0;

  async function listPasskeys() {
    const data = await NotesStore.api('/api/auth/webauthn/credentials');
    return Array.isArray(data.credentials) ? data.credentials : [];
  }

  // Resolves with the new credential id so the caller can offer vault unlock for it.
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
    // Asks the authenticator to set up PRF; whether it returns output is only known at get().
    options.extensions = { ...(options.extensions || {}), prf: {} };
    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) throw new Error('Passkey registration was cancelled');
    await NotesStore.api('/api/auth/webauthn/register/verify', {
      method: 'POST',
      body: JSON.stringify({
        credential: NotesWebAuthn.registrationCredentialJson(credential),
      }),
    });
    return credential.id;
  }

  async function removePasskey(credentialId) {
    await NotesStore.api('/api/auth/webauthn/remove', {
      method: 'POST',
      body: JSON.stringify({ credential_id: credentialId }),
    });
  }

  // ---- Vault unlock with a passkey (docs/VAULT_RECOVERY.md 1.4, 3.1) ----
  let unlockDeps = null;
  let unlockMessage = '';
  let unlockMessageError = false;

  // deps: { getEmail(), getVaultKey() -> {raw}|null, getPassword() -> string }
  function configureVaultUnlock(deps) {
    unlockDeps = deps || null;
  }

  const NO_PRF_BROWSER = 'This browser does not support unlocking the vault with a passkey. Nothing was saved. Your master password still opens your vault; a newer browser may support this.';
  const NO_PRF_PASSKEY = 'This passkey cannot open your vault: it did not return the secret that vault unlock needs (the WebAuthn PRF extension). Nothing was saved. A new passkey, for example from your platform or a recent hardware security key, may be needed. Your master password stays the way to open your vault.';

  function setUnlockMessage(text, isError) {
    unlockMessage = text || '';
    unlockMessageError = !!isError;
  }

  function toB64Url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return global.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function vaultKeysStatus() {
    return NotesStore.api('/api/account/vault-keys');
  }

  // credential_id -> 'on' | 'stale', from the server status (it never contains a wrap).
  function unlockStates(status) {
    const map = new Map();
    (Array.isArray(status?.prf) ? status.prf : []).forEach((r) => {
      map.set(r.credential_id, r.current ? 'on' : 'stale');
    });
    return map;
  }

  async function withVaultKeysToken(deps, attempt) {
    let password = deps.getPassword();
    if (!password) password = String(document.getElementById('passkey-vault-password')?.value || '');
    if (!password) {
      const row = document.getElementById('passkey-vault-password-row');
      if (row) row.hidden = false;
      document.getElementById('passkey-vault-password')?.focus();
      const err = new Error('Enter your account password below, then try again.');
      err.needPassword = true;
      throw err;
    }
    for (let tries = 1; ; tries += 1) {
      const proof = await global.NotesSrpAuth.vaultKeysProve(deps.getEmail(), password);
      try {
        return await attempt(proof.token);
      } catch (err) {
        // A background request can overwrite the token in the session cookie; prove again.
        if (err.status === 401 && err.data?.error === 'invalid or expired token' && tries < 3) continue;
        throw err;
      }
    }
  }

  // Asks this passkey for PRF output, wraps the vault key with it and stores the copy.
  // Resolves {status:'ok'} or {status:'unsupported', reason}; unsupported stores nothing.
  async function enableVaultUnlock(credentialId) {
    const deps = unlockDeps;
    const C = global.NotesCrypto;
    if (!deps || !C?.derivePrfWrapKey) throw new Error('Vault unlock is not available here.');
    const vk = deps.getVaultKey();
    if (!vk) throw new Error('Unlock your vault first.');
    let prfOutput = null;
    let wrapKey = null;
    try {
      if (await NotesWebAuthn.prfBrowserSupport() === 'unsupported') return { status: 'unsupported', reason: 'browser' };
      const opts = await NotesStore.api(
        `/api/account/vault-keys/prf/${encodeURIComponent(credentialId)}/options`,
        { method: 'POST', body: '{}' },
      );
      const salt = global.crypto.getRandomValues(new Uint8Array(32));
      const got = await NotesWebAuthn.requestPrfOutput(NotesWebAuthn.prepareAuthenticationOptions(opts.options), salt);
      if (got.status !== 'ok') return { status: 'unsupported', reason: got.reason };
      prfOutput = got.output;
      if (got.credentialId !== credentialId) throw new Error('A different passkey answered. Choose the passkey you want to use.');
      const status = await vaultKeysStatus();
      wrapKey = C.derivePrfWrapKey(prfOutput);
      const wrap = await C.wrapVaultKey(vk, wrapKey, {
        accountId: String(status.account_id || ''), type: 'prf', binding: credentialId,
      });
      const body = {
        expected_key_rev: Number(status.key_rev) || 0,
        key_id: wrap.key_id,
        wrap_version: wrap.wrap_version,
        prf_salt: toB64Url(salt),
        wrap: wrap.blob,
      };
      await withVaultKeysToken(deps, (token) => NotesStore.api(
        `/api/account/vault-keys/prf/${encodeURIComponent(credentialId)}`,
        { method: 'PUT', body: JSON.stringify({ ...body, token }) },
      ));
      return { status: 'ok' };
    } finally {
      if (prfOutput) prfOutput.fill(0);
      if (wrapKey) wrapKey.raw.fill(0);
      vk.raw.fill(0);
    }
  }

  async function disableVaultUnlock(credentialId) {
    const deps = unlockDeps;
    if (!deps) throw new Error('Vault unlock is not available here.');
    const status = await vaultKeysStatus();
    await withVaultKeysToken(deps, (token) => NotesStore.api(
      `/api/account/vault-keys/prf/${encodeURIComponent(credentialId)}`,
      { method: 'DELETE', body: JSON.stringify({ expected_key_rev: Number(status.key_rev) || 0, token }) },
    ));
  }

  function unlockErrorMessage(err) {
    if (err?.needPassword) return err.message;
    if (err?.name === 'NotAllowedError') return 'The passkey confirmation was cancelled. Nothing was saved.';
    if (err?.status === 401 && /password/i.test(String(err.message))) {
      return 'That password is not right. Enter the password you use to sign in.';
    }
    if (err?.status === 409) return 'Your vault keys changed on another device. Reload and try again.';
    return err?.message || 'Could not change vault unlock for this passkey.';
  }

  // New passkey: the same confirmation right after registration. The passkey stays
  // for sign-in whatever the outcome; the message says what happened.
  async function enableVaultUnlockForNew(credentialId) {
    try {
      const res = await enableVaultUnlock(credentialId);
      if (res.status === 'ok') setUnlockMessage('Vault unlock is on for the new passkey.', false);
      else setUnlockMessage(res.reason === 'browser' ? NO_PRF_BROWSER : NO_PRF_PASSKEY, true);
    } catch (err) {
      setUnlockMessage(`The passkey was added, but vault unlock was not turned on. ${unlockErrorMessage(err)}`, true);
    }
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
    const token = ++passkeyListRenderToken;
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
    let states = new Map();
    try {
      rows = await listPasskeys();
      if (rows.length && unlockDeps) {
        try { states = unlockStates(await vaultKeysStatus()); } catch (err) { /* status stays unknown */ }
      }
    } catch (err) {
      if (token !== passkeyListRenderToken) return;
      const hint = document.createElement('p');
      hint.className = 'settings-hint error';
      hint.textContent = err.message || 'Could not load passkeys';
      container.appendChild(hint);
      return;
    }
    if (!rows.length) {
      if (token !== passkeyListRenderToken) return;
      const hint = document.createElement('p');
      hint.className = 'settings-hint';
      hint.textContent = 'No passkeys yet. Add one for passwordless account sign-in. You can also let a passkey open your vault; your master password keeps working.';
      container.appendChild(hint);
      return;
    }
    if (token !== passkeyListRenderToken) return;
    const rerender = async () => {
      await renderPasskeyList(container, preferredUrl);
      if (typeof window.__notesRefreshAccountPasskeySignin === 'function') {
        await window.__notesRefreshAccountPasskeySignin();
      }
    };
    rows.forEach((row, index) => {
      const item = document.createElement('div');
      item.className = 'settings-row passkey-row';
      item.dataset.credentialId = row.credential_id;
      const info = document.createElement('span');
      const label = document.createElement('span');
      label.textContent = formatPasskeyLabel(row, index);
      info.append(label);
      const state = states.get(row.credential_id) || 'off';
      if (unlockDeps) {
        const status = document.createElement('span');
        status.className = 'settings-hint passkey-unlock-status';
        status.dataset.unlockState = state;
        status.textContent = state === 'on' ? 'Vault unlock: on'
          : state === 'stale' ? 'Vault unlock: out of date, turn it on again'
            : 'Vault unlock: off';
        info.append(document.createElement('br'), status);
      }
      const actions = document.createElement('span');
      actions.className = 'passkey-row-actions';
      if (unlockDeps) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'btn ghost sm passkey-unlock-toggle';
        toggle.textContent = state === 'on' ? 'Turn off vault unlock' : 'Turn on vault unlock';
        toggle.addEventListener('click', async () => {
          toggle.disabled = true;
          setUnlockMessage('', false);
          try {
            if (state === 'on') {
              await disableVaultUnlock(row.credential_id);
              setUnlockMessage('Vault unlock turned off for this passkey. Its copy was deleted.', false);
            } else {
              const res = await enableVaultUnlock(row.credential_id);
              if (res.status === 'ok') setUnlockMessage('Vault unlock is on for this passkey.', false);
              else setUnlockMessage(res.reason === 'browser' ? NO_PRF_BROWSER : NO_PRF_PASSKEY, true);
            }
          } catch (err) {
            setUnlockMessage(unlockErrorMessage(err), true);
          }
          await rerender();
          container.querySelector(`.passkey-row[data-credential-id="${CSS.escape(row.credential_id)}"] .passkey-unlock-toggle`)?.focus();
        });
        actions.appendChild(toggle);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost sm';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await removePasskey(row.credential_id);
          setUnlockMessage('', false);
          await rerender();
        } catch (err) {
          btn.disabled = false;
          throw err;
        }
      });
      actions.appendChild(btn);
      item.append(info, actions);
      container.appendChild(item);
    });
    if (unlockDeps) {
      const message = document.createElement('p');
      message.id = 'passkey-unlock-message';
      message.className = unlockMessageError ? 'settings-hint error' : 'settings-hint';
      message.setAttribute('role', 'status');
      message.setAttribute('aria-live', 'polite');
      message.textContent = unlockMessage;
      message.hidden = !unlockMessage;
      container.appendChild(message);
    }
  }

  global.NotesPasskeys = {
    listPasskeys,
    registerPasskey,
    removePasskey,
    renderPasskeyList,
    configureVaultUnlock,
    enableVaultUnlock,
    disableVaultUnlock,
    enableVaultUnlockForNew,
  };
})(typeof window !== 'undefined' ? window : globalThis);
