/**
 * User-facing copy when notes are permanently deleted — confirmed on this device,
 * pending on the server and other devices until each side syncs.
 */
(function (global) {
  'use strict';

  const OTHER_DEVICES_PENDING = (
    'Other signed-in devices stay pending until each one syncs. '
    + 'We do not treat an offline or not-yet-synced device as confirmed gone.'
  );

  const SERVER_UPLOAD_PENDING = (
    'Sending the delete to the server is pending until sync uploads it — '
    + 'not confirmed on the server until that succeeds.'
  );

  const NEWER_EDIT = (
    'If another device has a newer edit, that copy may still exist after sync.'
  );

  const SERVER_MARKER = (
    'The server keeps a small encrypted marker so your other devices learn of the delete.'
  );

  function notRemovedMessage(sharedLinks) {
    const lines = [
      'Not removed:',
      '- Existing backups. They are not changed and age out on their own; backup emails in your inbox stay until you delete them.',
    ];
    if (sharedLinks > 0) {
      lines.push(sharedLinks === 1
        ? '- A Secure Send link made from this note. It keeps working until revoked or expired.'
        : `- ${sharedLinks} Secure Send links made from these notes. They keep working until revoked or expired.`);
    }
    lines.push('- Copies you exported, or that a recipient saved.');
    return lines.join('\n');
  }

  function permanentDeleteConfirmMessage({ count = 1, sharedLinks = 0 } = {}) {
    const noun = count === 1 ? 'This note' : `These ${count} notes`;
    return [
      `${noun} will be confirmed gone on this device as soon as you confirm.`,
      SERVER_UPLOAD_PENDING,
      SERVER_MARKER,
      OTHER_DEVICES_PENDING,
      NEWER_EDIT,
      notRemovedMessage(Number(sharedLinks) || 0),
    ].join('\n\n');
  }

  function permanentDeleteToastMessage({ count = 1 } = {}) {
    if (count === 1) {
      return 'Confirmed gone on this device. Still pending on the server and other devices until they sync.';
    }
    return `Confirmed gone on this device (${count} notes). Still pending elsewhere until each device syncs.`;
  }

  function secureSendRevokeConfirmMessage() {
    return [
      'This device: the link will be marked revoked after the server accepts the request.',
      'Recipients: pending until they fetch again — we cannot confirm the link is dead on every browser until then.',
    ].join('\n\n');
  }

  function secureSendRevokeToastMessage() {
    return 'Revoke confirmed on the server. Link access is still pending for anyone who has not fetched since.';
  }

  global.NotesDeletionSyncHonesty = {
    permanentDeleteConfirmMessage,
    permanentDeleteToastMessage,
    secureSendRevokeConfirmMessage,
    secureSendRevokeToastMessage,
  };
})(typeof window !== 'undefined' ? window : globalThis);
