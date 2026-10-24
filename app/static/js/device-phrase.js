/**
 * Round 74/75/75.1: user-chosen anti-phishing device phrase (this browser only).
 * Stored in localStorage under notes_device_phrase — never sent to the server.
 * Round 75: one-time in-app prompt when the phrase is unset (not on login/unlock).
 * Round 75.1: unset state shows a calm neutral line; fake-page warning only when set.
 */
(function (global) {
  'use strict';

  const KEY = 'notes_device_phrase';
  const DISMISS_KEY = 'notes_device_phrase_prompt_dismissed';
  const MAX_LEN = 64;
  const PROMPT_COPY = 'Set a device phrase so you can spot fake sign-in pages';
  const UNSET_COPY =
    'No device phrase yet. After you unlock, you can set one in Settings to help spot fake sign-in pages.';
  const WARN_COPY =
    "If you don't see your phrase here, you may be on a fake page.";

  function getPhrase() {
    try {
      return String(localStorage.getItem(KEY) || '').trim().slice(0, MAX_LEN);
    } catch (err) {
      return '';
    }
  }

  function setPhrase(raw) {
    const clean = String(raw || '').trim().slice(0, MAX_LEN);
    try {
      if (!clean) {
        localStorage.removeItem(KEY);
        return '';
      }
      localStorage.setItem(KEY, clean);
      // Phrase set — no need to nag again on this device.
      localStorage.setItem(DISMISS_KEY, '1');
    } catch (err) {
      /* ignore quota / private mode */
    }
    return clean;
  }

  function clearPhrase() {
    try {
      localStorage.removeItem(KEY);
    } catch (err) {
      /* ignore */
    }
  }

  function isPromptDismissed() {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function dismissPrompt() {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch (err) {
      /* ignore */
    }
  }

  /** True when the in-app one-time card should show (never on login/unlock). */
  function shouldShowPrompt() {
    return !getPhrase() && !isPromptDismissed();
  }

  /** Fill banner lines using textContent only (XSS-safe). Warning only when set. */
  function renderDisplay(el) {
    if (!el) return;
    const phrase = getPhrase();
    const doc = el.ownerDocument || document;
    const hint = doc.getElementById ? doc.getElementById('device-phrase-hint') : null;
    if (phrase) {
      el.textContent = `Your phrase: ${phrase}`;
      el.classList.remove('is-unset');
      if (hint) {
        hint.hidden = false;
        hint.textContent = WARN_COPY;
      }
    } else {
      el.textContent = UNSET_COPY;
      el.classList.add('is-unset');
      if (hint) {
        hint.hidden = true;
        hint.textContent = '';
      }
    }
  }

  /** Paint the in-app prompt card with textContent only. */
  function renderPromptCard(el, { unlocked } = {}) {
    if (!el) return false;
    const show = !!(unlocked && shouldShowPrompt());
    el.hidden = !show;
    if (!show) return false;
    const copy = el.querySelector('[data-device-phrase-prompt-copy]');
    if (copy) copy.textContent = PROMPT_COPY;
    return true;
  }

  global.NotesDevicePhrase = {
    KEY,
    DISMISS_KEY,
    MAX_LEN,
    PROMPT_COPY,
    UNSET_COPY,
    WARN_COPY,
    getPhrase,
    setPhrase,
    clearPhrase,
    isPromptDismissed,
    dismissPrompt,
    shouldShowPrompt,
    renderDisplay,
    renderPromptCard,
  };
})(typeof window !== 'undefined' ? window : globalThis);
