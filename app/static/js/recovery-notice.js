/**
 * Notice on every device after the recovery key was used to reset the vault password.
 * The server lists the events this device has not dismissed yet; dismissing is per device.
 */
(function (global) {
  'use strict';

  const ADVICE = 'If this was not you, change your password now.';

  function formatWhen(seconds) {
    const d = new Date(Number(seconds) * 1000);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function messageFor(notice) {
    const when = formatWhen(notice.created_at);
    return `Your recovery key was used to reset your password${when ? ` on ${when}` : ''}. ${ADVICE}`;
  }

  /** Paint the notices (newest first) into the container; hide it when there are none. */
  function render(container, notices, onDismiss) {
    if (!container) return;
    container.textContent = '';
    const list = Array.isArray(notices) ? notices : [];
    container.hidden = list.length === 0;
    list.forEach((notice) => {
      const row = document.createElement('div');
      row.className = 'recovery-notice-row';
      row.dataset.noticeId = String(notice.id);
      const text = document.createElement('p');
      text.className = 'recovery-notice-copy';
      text.textContent = messageFor(notice);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost sm recovery-notice-dismiss';
      btn.textContent = 'Dismiss';
      btn.setAttribute('aria-label', `Dismiss: ${text.textContent}`);
      btn.addEventListener('click', () => onDismiss(notice));
      row.append(text, btn);
      container.append(row);
    });
  }

  let inflight = null;

  /** Fetch the notices for this device and show them. Quietly does nothing while signed out or offline. */
  function refresh(api, container) {
    if (inflight) return inflight;
    const dismiss = async (notice) => {
      try {
        await api(`/api/account/vault-recovery-notices/${notice.id}/dismiss`, { method: 'POST' });
      } catch (err) {
        return;
      }
      await refresh(api, container);
    };
    inflight = (async () => {
      try {
        const data = await api('/api/account/vault-recovery-notices');
        render(container, data && data.notices, dismiss);
      } catch (err) {
        /* offline or signed out: keep what is shown */
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  global.NotesRecoveryNotice = { render, refresh, messageFor };
})(typeof window !== 'undefined' ? window : globalThis);
