/**
 * D2 receive page — Open burns a view; GET/HEAD of /receive never does.
 * Passphrase links prove an HMAC of contentKey before the server counts a view.
 */
(function () {
  'use strict';

  const bootEl = document.getElementById('receive-boot');
  let boot = {};
  try {
    boot = JSON.parse(bootEl ? bootEl.textContent : '{}');
  } catch (err) {
    boot = {};
  }

  const sendId = String(boot.sendId || '');
  const linkStopped = String(
    boot.linkStopped
    || (window.NotesSecureSend && NotesSecureSend.LINK_STOPPED)
    || 'This link has stopped working. Ask the sender for a new one.',
  );
  const alreadyStopped = !!boot.linkStoppedFlag;
  const fragment = String(location.hash || '').replace(/^#/, '');

  const gate = document.getElementById('receive-gate');
  const stopped = document.getElementById('receive-stopped');
  const result = document.getElementById('receive-result');
  const errEl = document.getElementById('receive-error');
  const passWrap = document.getElementById('receive-pass-wrap');
  const passInput = document.getElementById('receive-passphrase');
  const openBtn = document.getElementById('receive-open');
  const titleEl = document.getElementById('receive-title');
  const bodyEl = document.getElementById('receive-body');
  const fileRow = document.getElementById('receive-file-row');
  const downloadBtn = document.getElementById('receive-download');

  function showError(msg) {
    if (!errEl) return;
    errEl.hidden = false;
    errEl.textContent = msg;
  }

  function hideError() {
    if (!errEl) return;
    errEl.hidden = true;
    errEl.textContent = '';
  }

  function showStopped() {
    if (gate) gate.hidden = true;
    if (result) result.hidden = true;
    const heading = document.getElementById('receive-heading');
    if (heading) heading.hidden = true;
    if (stopped) {
      stopped.hidden = false;
      const p = stopped.querySelector('[data-stopped-copy]');
      if (p) p.textContent = linkStopped;
    }
  }

  if (alreadyStopped) {
    showStopped();
    return;
  }

  // Passphrase UI comes only from the fragment (server never stores that flag on the page).
  if (passWrap && window.NotesSecureSend && NotesSecureSend.fragmentNeedsPassphrase(fragment)) {
    passWrap.hidden = false;
  }

  if (!fragment) {
    showError('This link is incomplete. Ask the sender for the full link.');
    if (openBtn) openBtn.disabled = true;
  }

  let pendingFile = null;

  async function onOpen() {
    hideError();
    if (!window.NotesSecureSend || !sendId) {
      showError(linkStopped);
      return;
    }
    if (!fragment) {
      showError('This link is incomplete. Ask the sender for the full link.');
      return;
    }
    const needsPass = NotesSecureSend.fragmentNeedsPassphrase(fragment);
    let passphrase = '';
    if (needsPass) {
      if (passWrap) passWrap.hidden = false;
      passphrase = passInput ? String(passInput.value || '') : '';
      if (!passphrase) {
        showError('Enter the passphrase the sender shared separately. The link alone cannot open this.');
        return;
      }
    }
    openBtn.disabled = true;
    openBtn.textContent = 'Opening…';
    try {
      const body = {};
      if (needsPass) {
        const contentKey = await NotesSecureSend.resolveContentKey(fragment, passphrase);
        body.open_verifier = await NotesSecureSend.computeOpenVerifier(contentKey);
      }
      NotesSecureSend.assertNoFragmentLeak(`/api/secure-send/${sendId}/open`, body);
      const res = await fetch(`/api/secure-send/${encodeURIComponent(sendId)}/open`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 404) {
        showStopped();
        return;
      }
      if (res.status === 401) {
        const data = await res.json().catch(() => ({}));
        const left = Number(data.attempts_left);
        if (data.error === 'wrong_passphrase') {
          const suffix = Number.isFinite(left) ? ` (${left} attempt${left === 1 ? '' : 's'} left)` : '';
          showError(`Wrong passphrase${suffix}`);
          openBtn.disabled = false;
          openBtn.textContent = 'Open';
          return;
        }
        showStopped();
        return;
      }
      if (!res.ok) {
        showError(res.status === 429 ? 'Too many attempts. Try again later.' : linkStopped);
        openBtn.disabled = false;
        openBtn.textContent = 'Open';
        return;
      }
      const data = await res.json();
      let payload;
      try {
        payload = await NotesSecureSend.openPayload(data.ciphertext, fragment, passphrase);
      } catch (err) {
        if (err && err.code === 'passphrase_required') {
          if (passWrap) passWrap.hidden = false;
          showError('Enter the passphrase the sender shared separately.');
          openBtn.disabled = false;
          openBtn.textContent = 'Open';
          return;
        }
        showError('Wrong passphrase');
        openBtn.disabled = false;
        openBtn.textContent = 'Open';
        return;
      }
      if (gate) gate.hidden = true;
      if (result) result.hidden = false;
      if (titleEl) titleEl.textContent = String(payload.title || '(untitled)');
      if (bodyEl) bodyEl.textContent = String(payload.body || '');
      if (payload.file && payload.file.data) {
        pendingFile = payload.file;
        if (fileRow) fileRow.hidden = false;
        if (downloadBtn) {
          downloadBtn.textContent = `Download ${payload.file.name || 'file'}`;
        }
      }
    } catch (err) {
      showError(linkStopped);
      openBtn.disabled = false;
      openBtn.textContent = 'Open';
    }
  }

  function onDownload() {
    if (!pendingFile || !window.NotesSecureSend) return;
    try {
      const bytes = NotesSecureSend.fromB64url(pendingFile.data);
      // MIME/name come from decrypted payload only — never from the server.
      const blob = new Blob([bytes], {
        type: pendingFile.mime || 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = NotesSecureSend.downloadNameFromPayload(pendingFile);
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      showError('Could not prepare the download.');
    }
  }

  if (openBtn) openBtn.addEventListener('click', () => { onOpen(); });
  if (downloadBtn) downloadBtn.addEventListener('click', () => { onDownload(); });
})();
