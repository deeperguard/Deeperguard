/**
 * Round 74: user-chosen anti-phishing device phrase (this browser only).
 * Stored in localStorage under notes_device_phrase — never sent to the server.
 */
(function (global) {
  'use strict';

  const KEY = 'notes_device_phrase';
  const MAX_LEN = 64;

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

  /** Fill an element with the phrase line using textContent only (XSS-safe). */
  function renderDisplay(el) {
    if (!el) return;
    const phrase = getPhrase();
    el.textContent = phrase
      ? `Your phrase: ${phrase}`
      : 'No phrase on this device yet';
  }

  global.NotesDevicePhrase = {
    KEY,
    MAX_LEN,
    getPhrase,
    setPhrase,
    clearPhrase,
    renderDisplay,
  };
})(typeof window !== 'undefined' ? window : globalThis);
