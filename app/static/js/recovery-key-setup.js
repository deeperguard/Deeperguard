/**
 * Required recovery key step for a new account (docs/VAULT_RECOVERY.md 1.3, 3.1, 5.1).
 *
 * Registration marks the account as pending on this device. After the vault is
 * unlocked the app calls maybeShow(): it makes a recovery key in the browser,
 * shows it (print, download, copy), and only after the user ticks the box and
 * types one group of the key it wraps the vault key, checks that the displayed
 * key opens that wrap, and stores the wrap. The key itself never leaves the
 * page. On a failed save the user can try again; if they leave, the pending
 * mark stays and the step returns (with a new key) at the next unlock.
 *
 * Existing accounts get a non-blocking offer after unlock (maybeOffer): create now, later
 * (back at the next unlock) or postpone for 14 days (kept in this browser only).
 *
 * The same dialog serves Settings (begin / refreshSettings): it shows whether a
 * recovery key is active and since when (never the key), creates one, or
 * replaces the active one after a warning. Replacing uses compare-and-set; if
 * another device changed the recovery key meanwhile nothing is overwritten.
 * Wrapping needs a vault key that was verified against real data, and the key
 * and the dialog are dropped when the vault locks or the user signs out.
 */
(function (global) {
  'use strict';

  const PENDING_PREFIX = 'notes_recovery_key_pending:';
  const GROUPS = 8;

  function pendingKey(email) {
    return PENDING_PREFIX + String(email || '').trim().toLowerCase();
  }

  function markPending(email) {
    if (!email) return;
    try { global.localStorage.setItem(pendingKey(email), '1'); } catch (err) { /* ignore */ }
  }

  function clearPending(email) {
    try { global.localStorage.removeItem(pendingKey(email)); } catch (err) { /* ignore */ }
  }

  function isPending(email) {
    if (!email) return false;
    try { return global.localStorage.getItem(pendingKey(email)) === '1'; } catch (err) { return false; }
  }

  function normalizeGroup(text) {
    return String(text || '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  }

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return global.btoa(s);
  }

  function csrfHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    try {
      const csrf = global.sessionStorage.getItem('notes_csrf') || '';
      if (csrf) headers['X-CSRF-Token'] = csrf;
    } catch (err) { /* ignore */ }
    return headers;
  }

  async function requestJson(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: csrfHeaders(),
      credentials: 'same-origin',
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function zero(bytes) {
    try { if (bytes && bytes.fill) bytes.fill(0); } catch (err) { /* ignore */ }
  }

  let session = null; // { email, rk, salt, text, group, deps, mode, replacing, seenCreatedAt, returnFocus }
  let settingsDeps = null;
  let bound = false;

  function el(id) { return global.document.getElementById(id); }

  function setError(message) {
    const box = el('recovery-key-error');
    if (!box) return;
    box.textContent = message || '';
    box.hidden = !message;
  }

  function setBusy(busy) {
    const dialog = el('recovery-key-dialog');
    const save = el('recovery-key-save');
    if (dialog) dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (save) {
      save.disabled = !!busy;
      if (busy) save.textContent = 'Saving…';
    }
  }

  function fileText() {
    const created = new Date().toISOString().slice(0, 10);
    return [
      'Deeperguard recovery key',
      `Account: ${session.email}`,
      `Created: ${created}`,
      '',
      session.text,
      '',
      'Keep this recovery key somewhere safe, away from this device.',
      'Deeperguard stores only an encrypted copy of your vault key that this recovery key opens.',
      'We cannot read your recovery key and cannot show it to you again.',
      'Treat it like your password: anyone who has it and can sign in to your account can open your notes.',
      '',
    ].join('\n');
  }

  function download() {
    if (!session) return;
    const blob = new Blob([fileText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = global.document.createElement('a');
    a.href = url;
    a.download = 'deeperguard-recovery-key.txt';
    a.rel = 'noopener';
    global.document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function print() {
    if (!session) return;
    const body = global.document.body;
    const date = el('recovery-key-print-date');
    if (date) date.textContent = `Account: ${session.email} · Created: ${new Date().toISOString().slice(0, 10)}`;
    body.classList.add('recovery-key-printing');
    const done = () => {
      body.classList.remove('recovery-key-printing');
      global.removeEventListener('afterprint', done);
    };
    global.addEventListener('afterprint', done);
    try {
      global.print();
    } finally {
      // Chromium's print() blocks until the dialog closes; afterprint may not fire everywhere.
      setTimeout(done, 0);
    }
  }

  async function copy() {
    if (!session) return;
    const toast = session.deps.toast || (() => {});
    const helper = global.NotesClipboardSensitive;
    if (helper && helper.copySensitive) {
      await helper.copySensitive(session.text, { label: 'Recovery key', onToast: toast });
      return;
    }
    try {
      await global.navigator.clipboard.writeText(session.text);
      toast('Recovery key copied.');
    } catch (err) {
      toast('Copy failed. Select the key and copy it by hand.', true);
    }
  }

  function close() {
    const dialog = el('recovery-key-dialog');
    const backdrop = el('recovery-key-backdrop');
    if (dialog) dialog.hidden = true;
    if (backdrop) backdrop.hidden = true;
    const value = el('recovery-key-value');
    if (value) value.textContent = '';
    const input = el('recovery-key-confirm-group');
    if (input) input.value = '';
    const pw = el('recovery-key-password');
    if (pw) pw.value = '';
    setError('');
    const closing = session;
    if (closing) {
      zero(closing.rk);
      zero(closing.salt);
    }
    session = null;
    hideOffer();
    if (closing && closing.mode === 'settings' && closing.returnFocus && closing.returnFocus.isConnected) {
      try { closing.returnFocus.focus(); } catch (err) { /* ignore */ }
    }
  }

  function isOpen() {
    const dialog = el('recovery-key-dialog');
    return !!(dialog && !dialog.hidden);
  }

  function lockedError() {
    const err = new Error('The vault was locked. Unlock it and try again; no recovery key was saved.');
    err.locked = true;
    return err;
  }

  function unverifiedError() {
    const err = new Error('Your vault key is not verified yet, so no recovery key was saved.');
    err.locked = true;
    return err;
  }

  // Why creating or replacing is not possible right now, or null when it is.
  // The vault key must have been checked against real data (isKeyVerified), not
  // merely be present in memory.
  function unavailableReason(deps) {
    if (!deps || !deps.isUnlocked || !deps.isUnlocked()) {
      return 'Unlock your vault first. A recovery key is made from your unlocked vault key.';
    }
    if (!deps.isKeyVerified || !deps.isKeyVerified()) {
      return 'Your vault key has not been verified yet. It is checked against your stored notes when you unlock, or against your account password when you have no notes yet. Lock the vault and unlock it again with your password, then come back.';
    }
    return null;
  }

  function checkSession(mine) {
    if (session !== mine) throw lockedError();
    if (unavailableReason(mine.deps)) {
      throw mine.deps.isUnlocked && mine.deps.isUnlocked() ? unverifiedError() : lockedError();
    }
  }

  // A fresh copy of the vault key, taken only while the vault is still unlocked
  // and verified. Zeroed bytes (a lock that raced us) are never returned.
  function takeVaultKey(mine) {
    checkSession(mine);
    const vk = mine.deps.getVaultKey();
    if (!vk || !vk.raw || !vk.raw.some((b) => b !== 0)) {
      if (vk) zero(vk.raw);
      throw lockedError();
    }
    return vk;
  }

  function conflictError(status) {
    const err = new Error('The recovery key was changed on another device.');
    err.conflict = true;
    err.status = status;
    return err;
  }

  // The user saw `seenCreatedAt` (0 = none). Did the recovery key change since?
  function recoveryChangedSince(status, mine) {
    const active = !!(status.recovery && status.recovery.active);
    if (mine.mode !== 'settings') return false;
    if (!mine.replacing) return active;
    return !active || Number(status.recovery.created_at) !== mine.seenCreatedAt;
  }

  async function saveWrap(mine) {
    const { deps } = mine;
    const C = global.NotesCrypto;
    checkSession(mine);
    const status = await requestJson('GET', '/api/account/vault-keys');
    checkSession(mine);
    if (mine.mode === 'settings') {
      if (recoveryChangedSince(status, mine)) throw conflictError(status);
    } else if (status.recovery && status.recovery.active) {
      return { already: true };
    }
    const password = deps.getPassword() || String(el('recovery-key-password')?.value || '');
    if (!password) {
      const err = new Error('Enter your password to save the recovery key.');
      err.needPassword = true;
      throw err;
    }
    let token = '';
    const prove = async () => {
      try {
        token = (await global.NotesSrpAuth.vaultKeysProve(mine.email, password)).token;
      } catch (err) {
        err.stage = 'prove';
        throw err;
      }
    };
    await prove();

    // Wrap the key as it is right now; the vault may have locked while we proved the password.
    const accountId = String(status.account_id || '');
    let wrap;
    const vk = takeVaultKey(mine);
    try {
      const wrapKey = C.deriveRecoveryWrapKey(mine.rk, mine.salt);
      wrap = await C.wrapVaultKey(vk, wrapKey, { accountId, type: 'recovery' });
      zero(wrapKey.raw);
      // Check the copy before storing it: the key exactly as shown on screen must open it.
      const shown = C.decodeRecoveryKey(mine.text);
      const shownWrapKey = C.deriveRecoveryWrapKey(shown, mine.salt);
      const opened = await C.unwrapVaultKey(shownWrapKey, wrap, { accountId, type: 'recovery' });
      const same = opened.raw.length === vk.raw.length && opened.raw.every((b, i) => b === vk.raw[i]);
      zero(opened.raw);
      zero(shownWrapKey.raw);
      zero(shown);
      if (!same) throw new Error('The recovery key copy did not check out. Nothing was saved.');
    } finally {
      zero(vk.raw);
    }
    const proof = C.hkdfSha256(mine.rk, mine.salt, 'deeperguard/recovery-proof/v1', 32);
    const proofHash = await C.hashBytes(proof);
    zero(proof);
    const body = {
      token,
      expected_key_rev: Number(status.key_rev) || 0,
      // The password-change time this device's vault key belongs to: the server
      // refuses the wrap when the password was changed later, also when no wrap exists yet.
      password_changed_at: Number(deps.getPasswordChangedAt ? deps.getPasswordChangedAt() : 0) || 0,
      key_id: wrap.key_id,
      wrap_version: wrap.wrap_version,
      recovery_salt: toB64(mine.salt),
      wrap: wrap.blob,
      proof_hash: proofHash,
    };

    let revRetried = false;
    for (let attempt = 1; ; attempt += 1) {
      if (!body.token) {
        await prove();
        body.token = token;
      }
      // Last look before saving: still the same unlocked key that was wrapped.
      const again = takeVaultKey(mine);
      let sameKey;
      try {
        sameKey = (await C.vaultKeyId(again)) === wrap.key_id;
      } finally {
        zero(again.raw);
      }
      checkSession(mine);
      if (!sameKey) throw lockedError();
      try {
        return await requestJson('PUT', '/api/account/vault-keys/recovery', body);
      } catch (err) {
        if (err.status === 401) {
          err.stage = 'put';
          // The token lives in the session cookie; a background request that was
          // in flight during the proof can overwrite it. Prove again.
          if (err.data?.error === 'invalid or expired token' && attempt < 3) {
            body.token = '';
            continue;
          }
          throw err;
        }
        if (err.status !== 409 || err.data?.error !== 'key_rev_mismatch') throw err;
        // Another device wrote meanwhile. Look again; retry once only when the
        // recovery key itself is untouched (3.1 step 4), never overwrite another device's key.
        const fresh = await requestJson('GET', '/api/account/vault-keys');
        checkSession(mine);
        if (mine.mode !== 'settings' && fresh.recovery && fresh.recovery.active) return { already: true };
        if (recoveryChangedSince(fresh, mine) || revRetried) throw conflictError(fresh);
        revRetried = true;
        body.expected_key_rev = Number(fresh.key_rev) || 0;
      }
    }
  }

  function saveErrorMessage(err) {
    if (err?.needPassword || err?.locked) return err.message;
    if (err?.conflict) {
      return 'The recovery key was changed on another device just now. Nothing was overwritten and no new key was saved. The status above is up to date; start again if you still want a new key.';
    }
    if (err?.status === 401 && err.stage === 'prove') {
      return 'That password is not right. Enter the password you use to sign in.';
    }
    if (err?.status === 401) {
      return 'Your sign-in or the password confirmation expired before the recovery key was saved. Nothing was saved. Sign in again if needed, then try again.';
    }
    if (err?.status === 409 && err.data?.error === 'key_id_mismatch') {
      return 'The vault password was changed on another device, so this device holds an outdated vault key. Nothing was saved. Lock the vault and unlock it with the new password, then try again.';
    }
    if (err?.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
    if (!err?.status || err.status >= 500 || err.code === 'timeout') {
      return 'Could not save the recovery key. Check your connection and try again. If you leave now, nothing was changed.';
    }
    return `Could not save the recovery key (${err.message}). Try again.`;
  }

  async function onSave() {
    const mine = session;
    if (!mine || mine.saving) return;
    setError('');
    const box = el('recovery-key-stored');
    const input = el('recovery-key-confirm-group');
    if (!box?.checked) {
      setError('Tick the box to confirm that you stored your recovery key.');
      box?.focus();
      return;
    }
    const expected = mine.text.split('-')[mine.group - 1];
    if (normalizeGroup(input?.value) !== expected) {
      input?.setAttribute('aria-invalid', 'true');
      setError(`Group ${mine.group} does not match your recovery key. Check what you stored.`);
      input?.focus();
      return;
    }
    input?.removeAttribute('aria-invalid');
    mine.saving = true;
    setBusy(true);
    let result;
    try {
      result = await saveWrap(mine);
    } catch (err) {
      mine.saving = false;
      setBusy(false);
      const message = saveErrorMessage(err);
      if (session !== mine) {
        // Closed meanwhile (the vault locked or the user signed out): nothing is left on screen.
        setSettingsNote(message);
        return;
      }
      const save = el('recovery-key-save');
      if (save) save.textContent = 'Try again';
      if (err?.needPassword || (err?.status === 401 && err.stage === 'prove')) {
        const wrapEl = el('recovery-key-password-row');
        if (wrapEl) wrapEl.hidden = false;
        el('recovery-key-password')?.focus();
      }
      if (err?.locked || err?.conflict || err?.data?.error === 'key_id_mismatch') {
        // Drop the pending key; a conflict also reloads the status.
        close();
        setSettingsNote(message);
        if (mine.mode === 'settings') refreshSettings(mine.deps).then(() => setSettingsNote(message)).catch(() => {});
        return;
      }
      setError(message);
      return;
    }
    mine.saving = false;
    const { email, deps } = mine;
    if (result && result.auth_security_at && deps.ackAuthSecurity) deps.ackAuthSecurity(result.auth_security_at);
    clearPending(email);
    setBusy(false);
    close();
    const done = result && result.already
      ? 'A recovery key was already set up for this account.'
      : 'Recovery key saved. Keep it somewhere safe.';
    if (deps.toast) deps.toast(done);
    if (mine.mode === 'settings') {
      refreshSettings(deps).then(() => setSettingsNote(done)).catch(() => {});
    }
  }

  function bind() {
    if (bound) return;
    bound = true;
    el('recovery-key-print')?.addEventListener('click', print);
    el('recovery-key-download')?.addEventListener('click', download);
    el('recovery-key-copy')?.addEventListener('click', () => { copy().catch(() => {}); });
    el('recovery-key-save')?.addEventListener('click', () => { onSave().catch(() => {}); });
    el('recovery-key-cancel')?.addEventListener('click', () => {
      if (session && !session.saving) close();
    });
    el('recovery-key-confirm-group')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onSave().catch(() => {});
      }
    });
    // The required step after registration cannot be dismissed. A key made from
    // Settings can be cancelled; nothing has been saved until the wrap is stored.
    // Capture on window so no other Escape handler (settings, menus) sees it first.
    global.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !session) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (session.mode === 'settings' && !session.saving) close();
    }, true);
  }

  function open(email, deps, options = {}) {
    const C = global.NotesCrypto;
    const rk = C.generateRecoveryKey();
    const groupBytes = new Uint8Array(1);
    global.crypto.getRandomValues(groupBytes);
    const settings = options.mode === 'settings';
    session = {
      email,
      rk,
      salt: C.generateRecoverySalt(),
      text: C.encodeRecoveryKey(rk),
      group: (groupBytes[0] % GROUPS) + 1,
      deps,
      mode: settings ? 'settings' : 'setup',
      replacing: !!options.replacing,
      seenCreatedAt: Number(options.seenCreatedAt) || 0,
      returnFocus: settings ? global.document.activeElement : null,
      saving: false,
    };
    bind();
    el('recovery-key-value').textContent = session.text;
    el('recovery-key-group-number').textContent = String(session.group);
    const box = el('recovery-key-stored');
    if (box) box.checked = false;
    const input = el('recovery-key-confirm-group');
    if (input) {
      input.value = '';
      input.removeAttribute('aria-invalid');
    }
    const pwRow = el('recovery-key-password-row');
    if (pwRow) pwRow.hidden = !!deps.getPassword();
    const warning = el('recovery-key-replace-warning');
    if (warning) warning.hidden = !(settings && session.replacing);
    const cancel = el('recovery-key-cancel');
    if (cancel) cancel.hidden = !settings;
    const save = el('recovery-key-save');
    if (save) {
      save.disabled = false;
      save.textContent = 'Continue';
    }
    setError('');
    el('recovery-key-backdrop').hidden = false;
    const dialog = el('recovery-key-dialog');
    dialog.setAttribute('aria-busy', 'false');
    dialog.hidden = false;
    el('recovery-key-download')?.focus();
  }

  /**
   * deps: { email, getVaultKey() -> {raw}|null, getPassword() -> string,
   *         isUnlocked() -> bool, isKeyVerified() -> bool, getPasswordChangedAt() -> number,
   *         ackAuthSecurity(at), toast(message, isError) }
   * Resolves true when the step is shown.
   */
  async function maybeShow(deps) {
    const email = String(deps?.email || '').trim().toLowerCase();
    if (!isPending(email) || isOpen()) return false;
    if (!global.NotesCrypto?.generateRecoveryKey || !global.NotesSrpAuth?.vaultKeysProve) return false;
    if (!el('recovery-key-dialog')) return false;
    if (unavailableReason(deps)) return false;
    let status;
    try {
      status = await requestJson('GET', '/api/account/vault-keys');
    } catch (err) {
      // 404: the server runs without strict zero-knowledge; the feature is off there.
      if (err.status === 404) clearPending(email);
      return false;
    }
    if (status.recovery && status.recovery.active) {
      clearPending(email);
      return false;
    }
    if (unavailableReason(deps) || isOpen()) return false;
    open(email, deps);
    return true;
  }


  // ---- Existing accounts: non-blocking offer after unlock (docs/VAULT_RECOVERY.md 4, 5.2) ----

  const POSTPONE_PREFIX = 'notes_recovery_key_postponed:';
  const POSTPONE_MS = 14 * 24 * 60 * 60 * 1000;

  function postponeKey(email) {
    return POSTPONE_PREFIX + String(email || '').trim().toLowerCase();
  }

  function isPostponed(email) {
    try {
      const at = Number(global.localStorage.getItem(postponeKey(email)));
      return Number.isFinite(at) && at > 0 && Date.now() - at < POSTPONE_MS;
    } catch (err) { return false; }
  }

  function hideOffer() {
    const box = el('recovery-key-offer');
    if (box) box.hidden = true;
  }

  function showOffer(email, deps) {
    const box = el('recovery-key-offer');
    if (!box) return false;
    if (!offerBound) {
      offerBound = true;
      el('btn-recovery-key-offer-now')?.addEventListener('click', () => {
        const d = offerDeps;
        if (!d) return;
        const reason = unavailableReason(d);
        if (reason) {
          if (d.toast) d.toast(reason, true);
          return;
        }
        begin(d, false).then((opened) => { if (opened) hideOffer(); }).catch(() => {});
      });
      // "Later": hidden now, back at the next unlock.
      el('btn-recovery-key-offer-later')?.addEventListener('click', hideOffer);
      el('btn-recovery-key-offer-postpone')?.addEventListener('click', () => {
        try { global.localStorage.setItem(postponeKey(offerEmail), String(Date.now())); } catch (err) { /* ignore */ }
        hideOffer();
      });
    }
    offerDeps = deps;
    offerEmail = email;
    box.hidden = false;
    return true;
  }

  let offerBound = false;
  let offerDeps = null;
  let offerEmail = '';

  /**
   * After unlocking, offer a recovery key to an account that has none. Does nothing for a
   * new account whose required step is pending, while the choice to postpone is recent,
   * or when the server cannot tell. Nothing is re-encrypted; creating adds one wrapped copy.
   * Resolves true when the offer is shown.
   */
  async function maybeOffer(deps) {
    const email = String(deps?.email || '').trim().toLowerCase();
    hideOffer();
    if (!email || isPending(email) || isPostponed(email) || isOpen()) return false;
    if (!deps.isUnlocked || !deps.isUnlocked()) return false;
    if (!global.NotesCrypto?.generateRecoveryKey || !global.NotesSrpAuth?.vaultKeysProve) return false;
    let status;
    try {
      status = await requestJson('GET', '/api/account/vault-keys');
    } catch (err) {
      return false;
    }
    if (status.recovery && status.recovery.active) return false;
    if (!deps.isUnlocked() || isOpen() || isPostponed(email)) return false;
    return showOffer(email, deps);
  }

  // ---- Settings: status and the create / replace actions -------------------

  function setSettingsNote(message) {
    const note = el('recovery-key-settings-note');
    if (!note) return;
    note.textContent = message || '';
    note.hidden = !message;
  }

  function formatDate(seconds) {
    const d = new Date(Number(seconds) * 1000);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function renderSettings(view) {
    const statusEl = el('recovery-key-settings-status');
    const create = el('btn-recovery-key-create');
    const regen = el('btn-recovery-key-regenerate');
    const why = el('recovery-key-settings-why');
    const warn = el('recovery-key-settings-replace-hint');
    if (!statusEl || !create || !regen || !why) return;
    const reason = view.status && settingsDeps ? unavailableReason(settingsDeps) : null;
    statusEl.textContent = view.text;
    const active = !!(view.status && view.status.recovery && view.status.recovery.active);
    const known = !!view.status;
    create.hidden = !known || active;
    regen.hidden = !known || !active;
    if (warn) warn.hidden = regen.hidden;
    create.disabled = !!reason;
    regen.disabled = !!reason;
    why.textContent = reason || '';
    why.hidden = !reason;
    [create, regen].forEach((btn) => {
      if (reason) btn.setAttribute('aria-describedby', 'recovery-key-settings-why');
      else btn.removeAttribute('aria-describedby');
    });
  }

  async function refreshSettings(deps) {
    settingsDeps = deps || settingsDeps;
    if (!el('recovery-key-settings') || !settingsDeps) return null;
    bindSettings();
    renderSettings({ text: 'Checking…', status: null });
    let status;
    try {
      status = await requestJson('GET', '/api/account/vault-keys');
    } catch (err) {
      renderSettings({
        text: err.status === 404
          ? 'Recovery keys are not available on this server.'
          : 'Could not load the recovery key status. Check your connection and open Settings again.',
        status: null,
      });
      return null;
    }
    const rec = status.recovery || {};
    const since = rec.active ? formatDate(rec.created_at) : '';
    renderSettings({
      text: rec.active
        ? `Recovery key: active${since ? ` since ${since}` : ''}`
        : 'Recovery key: not set up',
      status,
    });
    return status;
  }

  // Start creating or replacing from Settings. `wantReplace` is what the user clicked;
  // when another device changed the state meanwhile, the status is reloaded instead.
  async function begin(deps, wantReplace) {
    settingsDeps = deps || settingsDeps;
    const d = settingsDeps;
    if (!d || isOpen()) return false;
    setSettingsNote('');
    const reason = unavailableReason(d);
    if (reason) {
      setSettingsNote(reason);
      return false;
    }
    if (!global.NotesCrypto?.generateRecoveryKey || !global.NotesSrpAuth?.vaultKeysProve) return false;
    let status;
    try {
      status = await requestJson('GET', '/api/account/vault-keys');
    } catch (err) {
      setSettingsNote('Could not load the recovery key status. Check your connection and try again.');
      return false;
    }
    if (unavailableReason(d)) {
      setSettingsNote('The vault was locked. Unlock it and try again.');
      return false;
    }
    const active = !!(status.recovery && status.recovery.active);
    if (active !== !!wantReplace) {
      await refreshSettings(d);
      setSettingsNote('The recovery key was changed on another device. The status is up to date; check it and try again.');
      return false;
    }
    open(String(d.email || '').trim().toLowerCase(), d, {
      mode: 'settings',
      replacing: active,
      seenCreatedAt: active ? Number(status.recovery.created_at) : 0,
    });
    return true;
  }

  let settingsBound = false;
  function bindSettings() {
    if (settingsBound) return;
    settingsBound = true;
    el('btn-recovery-key-create')?.addEventListener('click', () => { begin(null, false).catch(() => {}); });
    el('btn-recovery-key-regenerate')?.addEventListener('click', () => { begin(null, true).catch(() => {}); });
  }

  const api = {
    markPending, isPending, clearPending, maybeShow, maybeOffer, isPostponed, close, isOpen, normalizeGroup,
    refreshSettings, begin, unavailableReason,
  };
  global.NotesRecoveryKeySetup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
