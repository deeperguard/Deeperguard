/**
 * Copy sensitive values with a short clear-if-ours countdown.
 * Clears the clipboard only when it still holds exactly what this app wrote.
 */
(function (global) {
  'use strict';

  const DEFAULT_SECONDS = 30;

  let pendingValue = '';
  let clearTimer = null;

  function cancelPendingClear() {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    pendingValue = '';
  }

  async function readClipboardText() {
    try {
      if (global.navigator?.clipboard?.readText) {
        return await global.navigator.clipboard.readText();
      }
    } catch (err) {
      /* permission / insecure context */
    }
    return null;
  }

  async function writeClipboardText(text) {
    const value = String(text ?? '');
    try {
      if (global.navigator?.clipboard?.writeText) {
        await global.navigator.clipboard.writeText(value);
        return true;
      }
    } catch (err) {
      /* fall through */
    }
    try {
      const helper = global.document?.createElement('textarea');
      if (!helper) return false;
      helper.value = value;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.left = '-9999px';
      global.document.body.appendChild(helper);
      helper.select();
      const ok = global.document.execCommand('copy');
      helper.remove();
      return !!ok;
    } catch (err) {
      return false;
    }
  }

  function countdownMessage(label, secondsLeft, { shownBelow = false, rotateHint = '' } = {}) {
    const noun = String(label || 'value').toLowerCase();
    const lead = shownBelow
      ? `${label} shown below and copied.`
      : `Copied ${label}.`;
    const hint = String(rotateHint || '').trim();
    const hintPart = hint ? ` ${hint}` : '';
    return `${lead}${hintPart} Clearing in ${secondsLeft}s if the clipboard still holds only this ${noun} — not older clipboard items.`;
  }

  function manualClearHint(label) {
    const noun = String(label || 'value').toLowerCase();
    return `Could not read the clipboard to auto-clear this ${noun}; paste elsewhere or clear it yourself if needed.`;
  }

  function resultMessage(label, result) {
    const noun = String(label || 'value').toLowerCase();
    if (result === 'cleared') {
      return `Clipboard cleared — it still held only the ${noun} we copied.`;
    }
    if (result === 'changed') {
      return 'Clipboard left as-is — it no longer matches what we copied.';
    }
    if (result === 'unreadable') {
      return 'Could not read the clipboard to auto-clear; paste elsewhere or clear it yourself.';
    }
    return '';
  }

  async function clearIfStillOurs(expected) {
    const want = String(expected ?? '');
    if (!want) return 'none';
    const current = await readClipboardText();
    if (current === null) return 'unreadable';
    if (current !== want) return 'changed';
    try {
      await writeClipboardText('');
      return 'cleared';
    } catch (err) {
      return 'unreadable';
    }
  }

  /**
   * @param {string} text
   * @param {{ seconds?: number, label?: string, shownBelow?: boolean, rotateHint?: string, onToast?: (msg: string) => void }} opts
   */
  async function copySensitive(text, opts = {}) {
    cancelPendingClear();
    const value = String(text ?? '');
    const label = String(opts.label || 'Value').trim() || 'Value';
    const shownBelow = !!opts.shownBelow;
    const rotateHint = String(opts.rotateHint || '').trim();
    let seconds = Number(opts.seconds);
    if (!Number.isFinite(seconds) || seconds < 5) seconds = DEFAULT_SECONDS;
    if (seconds > 120) seconds = 120;

    const wrote = await writeClipboardText(value);
    if (!wrote) throw new Error('Could not copy');

    pendingValue = value;
    const onToast = typeof opts.onToast === 'function' ? opts.onToast : null;
    const remaining = Math.ceil(seconds);

    // Probe read permission right after write so Chrome does not prompt only when the timer ends.
    const canAutoClear = (await readClipboardText()) !== null;

    let initial = countdownMessage(label, remaining, { shownBelow, rotateHint });
    if (!canAutoClear) {
      initial = `${initial} ${manualClearHint(label)}`;
    }
    if (onToast) onToast(initial);

    if (!canAutoClear) {
      pendingValue = '';
      return true;
    }

    clearTimer = setTimeout(async () => {
      clearTimer = null;
      const expected = pendingValue;
      pendingValue = '';
      const outcome = await clearIfStillOurs(expected);
      const msg = resultMessage(label, outcome);
      if (msg && onToast) onToast(msg);
    }, seconds * 1000);

    return true;
  }

  const api = {
    DEFAULT_SECONDS,
    copySensitive,
    cancelPendingClear,
    clearIfStillOurs,
    countdownMessage,
    manualClearHint,
    resultMessage,
  };

  global.NotesClipboardSensitive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
