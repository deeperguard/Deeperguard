const NotesSwipe = (() => {
  const ACTION_WIDTH = 88;
  const AXIS_SLOP = 8;
  const OPEN_AT = 48;
  const COMMIT_AT = 140;

  function clampOffset(x, max = ACTION_WIDTH) {
    if (!Number.isFinite(x) || x > 0) return 0;
    return Math.max(-Math.round(max * 1.15), x);
  }

  function decide(offset, { openAt = OPEN_AT, commitAt = COMMIT_AT } = {}) {
    if (offset <= -commitAt) return 'commit';
    if (offset <= -openAt) return 'open';
    return 'close';
  }

  function axisLock(dx, dy, slop = AXIS_SLOP) {
    if (Math.abs(dx) < slop && Math.abs(dy) < slop) return null;
    return Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
  }

  function snapOffset(decision, max = ACTION_WIDTH) {
    if (decision === 'open' || decision === 'commit') return -max;
    return 0;
  }

  return { ACTION_WIDTH, clampOffset, decide, axisLock, snapOffset };
})();
if (typeof window !== 'undefined') window.NotesSwipe = NotesSwipe;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesSwipe;
