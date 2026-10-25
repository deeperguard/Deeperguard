/**
 * One-line notice in Ask AI Settings when the pinned /verify Ask AI disclosure changes.
 * Visiting /verify marks the current pin as seen.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'notes_verify_ask_ai_pin_seen';

  function pinId() {
    try {
      const el = global.document?.querySelector('meta[name="notes-verify-ask-ai-pin"]');
      const fromMeta = el ? String(el.getAttribute('content') || '').trim() : '';
      if (fromMeta) return fromMeta;
      const section = global.document?.getElementById('verify-ask-ai');
      return section
        ? String(section.getAttribute('data-verify-ask-ai-pin') || '').trim()
        : '';
    } catch (err) {
      return '';
    }
  }

  function acknowledge() {
    const id = pinId();
    if (!id) return;
    try {
      global.localStorage.setItem(STORAGE_KEY, id);
    } catch (err) { /* ignore */ }
    paintSettingsNotice();
  }

  function needsNotice() {
    const id = pinId();
    if (!id) return false;
    try {
      return global.localStorage.getItem(STORAGE_KEY) !== id;
    } catch (err) {
      return false;
    }
  }

  function paintSettingsNotice() {
    const el = global.document?.getElementById('ai-chat-verify-pin-notice');
    if (!el) return;
    const show = needsNotice();
    el.hidden = !show;
    if (!show) return;
    el.setAttribute('aria-hidden', 'false');
  }

  function start() {
    if (global.document?.getElementById('verify-ask-ai')) {
      acknowledge();
      return;
    }
    paintSettingsNotice();
  }

  global.NotesVerifyAskAiPin = {
    start,
    acknowledge,
    paintSettingsNotice,
    pinId,
    needsNotice,
  };

  function onReady() {
    start();
  }
  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', onReady);
    } else {
      onReady();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
