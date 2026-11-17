/**
 * Vault recovery key in Settings (docs/VAULT_RECOVERY.md 1.3, 2.2, 3.1, 3.4).
 * The key is made in this browser, shown once and never sent anywhere; the server
 * only receives the wrapped copy of the vault key and a hash of a proof value.
 */
(function (global) {
  'use strict';

  const CONFLICT_MESSAGE = 'Another device changed your recovery key settings while you were working. Nothing was changed. The status below is reloaded; check it and try again if needed.';
  const STALE_KEY_MESSAGE = 'Your vault password was changed on another device. Nothing was changed. Unlock again with the new password before creating a recovery key.';

  let pending = null; // { text, salt, wrap, proofHash, keyRev } while the key is on screen
  let status = null;
  let busy = false;
  let wired = false;

  const el = (id) => document.getElementById(id);

  function setStatus(text) {
    const node = el('recovery-key-status');
    if (node) node.textContent = text;
  }

  function formatDate(seconds) {
    return new Date(Number(seconds) * 1000).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  }

  function render() {
    const active = !!status?.recovery?.active;
    const showing = !!pending;
    const unlocked = !!global.NotesStore?.isUnlocked?.();
    el('btn-recovery-key-create').hidden = active || showing;
    el('btn-recovery-key-regenerate').hidden = !active || showing;
    el('recovery-key-replace-warning').hidden = !active || showing;
    for (const id of ['btn-recovery-key-create', 'btn-recovery-key-regenerate']) {
      el(id).disabled = busy || !unlocked;
    }
    el('recovery-key-reveal').hidden = !showing;
    el('recovery-key-text').textContent = showing ? pending.text : '';
    el('btn-recovery-key-save').disabled = busy || !showing || !el('recovery-key-confirm').checked;
  }

  function describe() {
    if (!status) return;
    if (!global.NotesStore?.isUnlocked?.()) {
      setStatus('Unlock your vault to manage the recovery key.');
    } else if (status.recovery?.active) {
      setStatus(`Recovery key: active since ${formatDate(status.recovery.created_at)}. The key itself is never shown again.`);
    } else {
      setStatus('Recovery key: not set up. Without one, forgetting your vault password means losing access to your notes.');
    }
  }

  async function load() {
    status = await global.NotesStore.api('/api/account/vault-keys');
  }

  async function refresh() {
    wire();
    if (!el('recovery-key-settings')) return;
    try {
      await load();
    } catch (err) {
      status = null;
      setStatus('Could not load the recovery key status. Check your connection and try again.');
      return;
    }
    render();
    if (!pending) describe();
  }

  function discard() {
    pending = null;
    el('recovery-key-confirm').checked = false;
    el('recovery-key-password').value = '';
  }

  async function begin() {
    if (busy || pending) return;
    if (!el('recovery-key-password').value) {
      setStatus('Enter your account password to continue.');
      el('recovery-key-password').focus();
      return;
    }
    const C = global.NotesCrypto;
    const vaultKey = global.NotesStore.vaultKeyHandle();
    if (!vaultKey) {
      setStatus('Unlock your vault first.');
      return;
    }
    busy = true;
    render();
    try {
      await load();
      const bytes = C.generateRecoveryKey();
      const salt = C.generateRecoverySalt();
      const wrap = await C.wrapVaultKey(vaultKey, C.deriveRecoveryWrapKey(bytes, salt), {
        accountId: status.account_id,
        type: 'recovery',
      });
      const proof = C.hkdfSha256(bytes, salt, 'deeperguard/recovery-proof/v1', 32);
      pending = {
        text: C.encodeRecoveryKey(bytes),
        salt,
        wrap,
        proofHash: await C.hashBytes(proof),
        keyRev: status.key_rev,
      };
      setStatus('Write down the recovery key, then confirm that you stored it. It is not active until you activate it.');
    } catch (err) {
      discard();
      setStatus('Could not prepare a recovery key in this browser.');
    } finally {
      busy = false;
      render();
    }
    if (pending) el('recovery-key-text').focus();
  }

  function b64(bytes) {
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  async function save() {
    if (busy || !pending || !el('recovery-key-confirm').checked) return;
    const password = el('recovery-key-password').value;
    if (!password) {
      setStatus('Enter your account password to activate the recovery key.');
      el('recovery-key-password').focus();
      return;
    }
    busy = true;
    render();
    const job = pending;
    const replaced = !!status?.recovery?.active;
    try {
      const account = await global.NotesStore.loadAccount();
      const proved = await global.NotesSrpAuth.vaultKeysProve(account.email, password);
      await global.NotesStore.api('/api/account/vault-keys/recovery', {
        method: 'PUT',
        body: JSON.stringify({
          token: proved.token,
          expected_key_rev: job.keyRev,
          key_id: job.wrap.key_id,
          wrap_version: job.wrap.wrap_version,
          recovery_salt: b64(job.salt),
          wrap: job.wrap.blob,
          proof_hash: job.proofHash,
        }),
      });
      discard();
      await load();
      render();
      describe();
      if (replaced) setStatus(`${el('recovery-key-status').textContent} Any earlier recovery key no longer works.`);
    } catch (err) {
      if (err && err.status === 409) {
        discard();
        const stale = err.message === 'key_id_mismatch';
        await load().catch(() => {});
        render();
        setStatus(stale ? STALE_KEY_MESSAGE : CONFLICT_MESSAGE);
      } else if (err && err.status === 401) {
        setStatus('The account password is not correct. Your recovery key is not active yet; enter the password again.');
      } else {
        setStatus('The recovery key was not saved. Check your connection and try again.');
      }
    } finally {
      busy = false;
      render();
    }
  }

  function download() {
    if (!pending) return;
    const body = `Deeperguard vault recovery key\n\n${pending.text}\n\nKeep this file somewhere safe and private. Anyone with this key and access to your account data can open your notes vault.\n`;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'deeperguard-recovery-key.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copy() {
    if (!pending) return;
    try {
      await global.NotesClipboardSensitive.copySensitive(pending.text, { label: 'Recovery key', shownBelow: true });
    } catch (err) {
      setStatus('Could not copy. Select the key and copy it by hand.');
    }
  }

  function wire() {
    if (wired || !el('recovery-key-settings')) return;
    wired = true;
    el('btn-recovery-key-create').addEventListener('click', begin);
    el('btn-recovery-key-regenerate').addEventListener('click', () => {
      if (global.confirm('Create a new recovery key? The current recovery key stops working as soon as the new one is activated.')) begin();
    });
    el('recovery-key-confirm').addEventListener('change', render);
    el('btn-recovery-key-save').addEventListener('click', save);
    el('btn-recovery-key-copy').addEventListener('click', copy);
    el('btn-recovery-key-download').addEventListener('click', download);
    el('btn-recovery-key-cancel').addEventListener('click', () => {
      discard();
      render();
      describe();
    });
  }

  global.NotesRecoveryKey = { refresh };
})(window);
