/**
 * Sync freshness: per-item versions, high-water marks, vault head chain,
 * and out-of-band device-approval anchors (Feature C).
 *
 * Detects rollback (older version), byte-flip (decrypt failure handled by store),
 * freeze (older vault head), and fork (same head counter, divergent tip that
 * cannot be explained by concurrent max-merge).
 *
 * Zero-knowledge: versions and vault heads live inside ciphertext (or local
 * vault-key-encrypted meta). Anchor QR/codes are built only from local verified
 * state and are never sent to or signed by the server. No new plaintext metadata
 * is sent to the server.
 */
(function (global) {
  const META_KEY = 'freshness';
  const HEAD_UUID = '00000000-0063-4000-8000-000000000063';
  const HEADS_SEEN_MAX = 48;
  const ANCHOR_VERSION = 1;
  const ANCHOR_PREFIX = 'DGVA1';
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const WARN_TYPES = {
    rollback: 'rollback',
    fork: 'fork',
    freeze: 'freeze',
    integrity: 'integrity',
    bind: 'bind',
    start: 'start',
  };

  function emptyState() {
    return {
      hwm: Object.create(null), // uuid -> { v, hash }
      head: null, // { counter, tip, prev_tip, prev_counter }
      headsSeen: [], // [{ counter, tip, prev_tip }]
      warnings: [], // recent warnings for UI
      // Feature C: first remote head on an empty device is UNVERIFIED until
      // an out-of-band anchor matches (or the user skips). Locally authored
      // first heads and grandfathered devices are verified.
      startVerified: false,
      startSkipped: false,
      startStatus: null, // 'verified' | 'unverified' | 'anchored_backup' | null
      startAnchorAt: null,
      startAnchorLabel: null,
    };
  }

  let state = emptyState();
  let persistTimer = 0;
  let listeners = [];

  function isTestHookEnabled() {
    try {
      if (global.localStorage && global.localStorage.getItem('notes_freshness_test') === '1') return true;
    } catch (err) { /* ignore */ }
    try {
      return typeof global.location !== 'undefined'
        && /(?:^|[?&])freshness_test=1(?:&|$)/.test(String(global.location.search || ''));
    } catch (err) {
      return false;
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return () => { listeners = listeners.filter((x) => x !== fn); };
  }

  function emit() {
    listeners.forEach((fn) => {
      try { fn(getPublicSnapshot()); } catch (err) { /* ignore */ }
    });
  }

  function pushWarning(type, message, detail) {
    const entry = {
      type,
      message,
      detail: detail || null,
      at: Date.now(),
    };
    state.warnings = [entry, ...state.warnings].slice(0, 20);
    emit();
    return entry;
  }

  function clearWarnings() {
    state.warnings = [];
    emit();
  }

  async function sha256Hex(text) {
    const enc = new TextEncoder().encode(String(text || ''));
    if (global.NotesCrypto && typeof global.NotesCrypto.hashBytes === 'function') {
      return global.NotesCrypto.hashBytes(enc);
    }
    if (global.crypto && global.crypto.subtle) {
      const buf = await global.crypto.subtle.digest('SHA-256', enc);
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('No SHA-256 available for freshness tip');
  }

  function fingerprintShort(tip) {
    const t = String(tip || '');
    if (t.length < 12) return t || '—';
    return `${t.slice(0, 6)}…${t.slice(-4)}`;
  }

  function getHwm(uuid) {
    const row = state.hwm[String(uuid || '')];
    if (!row) return null;
    return { v: Number(row.v) || 0, hash: String(row.hash || '') };
  }

  function itemVersion(content) {
    const n = Number(content && content.__fv);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function itemBindId(content) {
    return String((content && content.__fid) || '');
  }

  function shouldTrackType(type) {
    // Derived/search indexes are rebuilt locally; vault_head is the tip itself.
    if (!type) return true;
    if (type === 'search_index') return false;
    if (type === 'vault_head') return false;
    return true;
  }

  function stampForUpsert(uuid, content, { bump = true, existing = null } = {}) {
    const id = String(uuid || '');
    const baseContent = content && typeof content === 'object' ? { ...content } : {};
    if (!shouldTrackType(baseContent.type)) {
      return baseContent;
    }
    const prev = Math.max(
      itemVersion(baseContent),
      itemVersion(existing && existing.content),
      getHwm(id)?.v || 0,
    );
    baseContent.__fid = id;
    baseContent.__fv = bump ? prev + 1 : (itemVersion(baseContent) || prev || 0);
    if (!bump && baseContent.__fv === 0 && prev === 0) {
      // Leave at 0 until first real edit; migration stamps on wrap/save.
      baseContent.__fv = 0;
    }
    return baseContent;
  }

  function stampForWrap(uuid, content) {
    const id = String(uuid || '');
    const next = content && typeof content === 'object' ? { ...content } : {};
    if (!shouldTrackType(next.type)) return next;
    next.__fid = id;
    // Re-encrypt only: migrate missing versions to 0. Upsert bumps on real edits.
    if (next.__fv == null || next.__fv === '') {
      next.__fv = 0;
    } else {
      next.__fv = itemVersion(next);
    }
    return next;
  }

  /** Annotate decrypted content in memory (migration); does not mark dirty. */
  function annotateDecrypted(uuid, content) {
    if (!content || typeof content !== 'object') return content;
    if (!shouldTrackType(content.type)) return content;
    const id = String(uuid || '');
    if (!content.__fid) content.__fid = id;
    if (content.__fv == null || content.__fv === '') content.__fv = 0;
    else content.__fv = itemVersion(content);
    return content;
  }

  /**
   * Check an incoming decrypted item before applying.
   * Returns { ok, reject, warning }.
   */
  function checkIncoming(uuid, content, contentHash, { isDelete = false } = {}) {
    const id = String(uuid || '');
    if (isDelete) {
      return { ok: true, reject: false, warning: null };
    }
    if (!content || typeof content !== 'object') {
      return {
        ok: false,
        reject: true,
        warning: pushWarning(WARN_TYPES.integrity, 'The server returned a corrupted item (not shown).', { uuid: id }),
      };
    }
    if (shouldTrackType(content.type)) {
      const bind = itemBindId(content);
      if (bind && bind !== id) {
        return {
          ok: false,
          reject: true,
          warning: pushWarning(
            WARN_TYPES.bind,
            'The server returned an item whose encrypted id does not match (not shown).',
            { uuid: id, bind },
          ),
        };
      }
      const ver = itemVersion(content);
      const hwm = getHwm(id);
      if (hwm && ver < hwm.v) {
        return {
          ok: false,
          reject: true,
          warning: pushWarning(
            WARN_TYPES.rollback,
            'The server returned an older version of this item.',
            { uuid: id, incoming: ver, held: hwm.v },
          ),
        };
      }
      if (hwm && ver === hwm.v && hwm.hash && contentHash && hwm.hash !== contentHash) {
        return {
          ok: false,
          reject: true,
          warning: pushWarning(
            WARN_TYPES.fork,
            'The server returned a different copy of this item at the same version (possible fork).',
            { uuid: id, version: ver },
          ),
        };
      }
    }
    return { ok: true, reject: false, warning: null };
  }

  function noteAccepted(uuid, content, contentHash, { deleted = false } = {}) {
    const id = String(uuid || '');
    if (deleted) {
      delete state.hwm[id];
      schedulePersist();
      return;
    }
    if (!content || !shouldTrackType(content.type)) return;
    const ver = itemVersion(content);
    const prev = getHwm(id);
    if (prev && ver < prev.v) return; // should have been rejected
    state.hwm[id] = { v: ver, hash: String(contentHash || prev?.hash || '') };
    schedulePersist();
  }

  function versionsMapFromItems(itemsMap) {
    const out = Object.create(null);
    if (!itemsMap || typeof itemsMap.forEach !== 'function') return out;
    itemsMap.forEach((item, uuid) => {
      if (!item || item.deleted) return;
      const type = item.content && item.content.type;
      if (!shouldTrackType(type)) return;
      const ver = itemVersion(item.content);
      // Prefer HWM if higher (accepted remote)
      const hwm = getHwm(uuid);
      out[uuid] = Math.max(ver, hwm ? hwm.v : 0);
    });
    // Also include HWM-only entries for items not in memory
    Object.keys(state.hwm).forEach((uuid) => {
      if (out[uuid] == null) out[uuid] = state.hwm[uuid].v || 0;
    });
    return out;
  }

  async function computeTip(versionsMap) {
    const lines = Object.keys(versionsMap)
      .filter((k) => k && k !== HEAD_UUID)
      .sort()
      .map((k) => `${k}:${Number(versionsMap[k]) || 0}`);
    return sha256Hex(lines.join('\n'));
  }

  function rememberHead(head) {
    if (!head || !head.tip) return;
    const entry = {
      counter: Number(head.counter) || 0,
      tip: String(head.tip),
      prev_tip: String(head.prev_tip || ''),
    };
    state.headsSeen = [entry, ...state.headsSeen.filter((h) => h.tip !== entry.tip)].slice(0, HEADS_SEEN_MAX);
  }

  function seenTip(tip) {
    return state.headsSeen.some((h) => h.tip === tip);
  }

  function markStartUnverified() {
    state.startVerified = false;
    state.startSkipped = false;
    state.startStatus = 'unverified';
    state.startAnchorAt = null;
    state.startAnchorLabel = null;
  }

  function markStartVerified({ source = 'device', label = null } = {}) {
    state.startVerified = true;
    state.startSkipped = false;
    state.startStatus = source === 'backup' ? 'anchored_backup' : 'verified';
    state.startAnchorAt = Date.now();
    state.startAnchorLabel = label || null;
    schedulePersist();
    emit();
  }

  function skipStartVerification() {
    state.startSkipped = true;
    if (!state.startVerified) state.startStatus = 'unverified';
    schedulePersist();
    emit();
  }

  function reopenStartVerification() {
    state.startSkipped = false;
    if (!state.startVerified) state.startStatus = 'unverified';
    schedulePersist();
    emit();
  }

  /**
   * Compare local head to a remote vault_head content after items were applied.
   * Concurrent edits: if recomputed tip from merged versions matches remote or
   * local, or remote is strictly ahead/behind by counter with chain link, no alarm.
   */
  async function evaluateRemoteHead(remoteContent, itemsMap) {
    if (!remoteContent || remoteContent.type !== 'vault_head') return { ok: true };
    const remote = {
      counter: Number(remoteContent.counter) || 0,
      tip: String(remoteContent.tip || ''),
      prev_tip: String(remoteContent.prev_tip || ''),
      prev_counter: Number(remoteContent.prev_counter) || 0,
    };
    const local = state.head;
    const mergedTip = await computeTip(versionsMapFromItems(itemsMap));

    if (!local) {
      // New device / empty freshness: adopt first head as UNVERIFIED until an
      // out-of-band anchor from a trusted device confirms it (Feature C).
      state.head = { ...remote };
      rememberHead(remote);
      markStartUnverified();
      schedulePersist();
      return { ok: true, adopted: true, bootstrap: true, unverified: true };
    }

    if (remote.counter < local.counter) {
      if (remote.tip === local.tip || remote.tip === local.prev_tip || seenTip(remote.tip)) {
        return { ok: true, stale: true };
      }
      return {
        ok: false,
        warning: pushWarning(
          WARN_TYPES.freeze,
          'The server presented an older vault head than this device has already seen (possible freeze/rollback).',
          { local: local.counter, remote: remote.counter },
        ),
      };
    }

    if (remote.counter === local.counter && remote.tip && local.tip && remote.tip !== local.tip) {
      // Legitimate multi-device concurrency: both heads advanced from the same
      // parent (same prev_tip), or one tip is the other's parent. Rebase to the
      // merged tip without alarming. A malicious fork tends to present the same
      // counter with unrelated tips and unrelated parents.
      const sameParent = remote.prev_tip && local.prev_tip && remote.prev_tip === local.prev_tip;
      const chained = remote.prev_tip === local.tip
        || local.prev_tip === remote.tip
        || mergedTip === remote.tip
        || mergedTip === local.tip
        || seenTip(remote.tip);
      if (sameParent || chained) {
        state.head = {
          counter: (Number(local.counter) || 0) + 1,
          tip: mergedTip || remote.tip,
          prev_tip: local.tip,
          prev_counter: Number(local.counter) || 0,
        };
        rememberHead(state.head);
        rememberHead(remote);
        schedulePersist();
        return { ok: true, concurrent: true };
      }
      return {
        ok: false,
        warning: pushWarning(
          WARN_TYPES.fork,
          'Two different vault heads share the same counter (possible fork).',
          { counter: local.counter, localTip: local.tip, remoteTip: remote.tip },
        ),
      };
    }

    if (remote.counter > local.counter) {
      // Adopt when chain links or tip matches what we compute from items.
      if (
        remote.prev_tip === local.tip
        || remote.tip === mergedTip
        || seenTip(remote.prev_tip)
        || remote.counter === local.counter + 1
      ) {
        state.head = { ...remote };
        rememberHead(remote);
        schedulePersist();
        return { ok: true, adopted: true };
      }
      // Still adopt tip if items dominate (we're simply behind), but warn softly
      // only when tip disagrees with merged local view after pull.
      state.head = { ...remote };
      rememberHead(remote);
      schedulePersist();
      if (mergedTip && remote.tip && mergedTip !== remote.tip && !seenTip(remote.tip)) {
        // Not necessarily malicious — another device may have versions we haven't pulled yet.
        return { ok: true, adopted: true, lagging: true };
      }
      return { ok: true, adopted: true };
    }

    return { ok: true };
  }

  async function buildNextHead(itemsMap) {
    const tip = await computeTip(versionsMapFromItems(itemsMap));
    const prev = state.head;
    if (prev && prev.tip === tip) return { ...prev, tip };
    const counter = (prev ? Number(prev.counter) || 0 : 0) + 1;
    return {
      counter,
      tip,
      prev_tip: prev ? String(prev.tip || '') : '',
      prev_counter: prev ? Number(prev.counter) || 0 : 0,
    };
  }

  async function commitLocalHead(itemsMap) {
    const hadHead = !!state.head;
    const next = await buildNextHead(itemsMap);
    state.head = next;
    rememberHead(next);
    // First head authored on this device is the source of truth — verified.
    if (!hadHead) {
      markStartVerified({ source: 'device' });
    } else {
      schedulePersist();
    }
    return next;
  }

  function headContent(head) {
    return {
      type: 'vault_head',
      counter: Number(head.counter) || 0,
      tip: String(head.tip || ''),
      prev_tip: String(head.prev_tip || ''),
      prev_counter: Number(head.prev_counter) || 0,
      updated_at: new Date().toISOString(),
    };
  }

  function startLabelText() {
    if (state.startStatus === 'anchored_backup') {
      const when = state.startAnchorLabel || (state.startAnchorAt
        ? new Date(state.startAnchorAt).toISOString().slice(0, 10)
        : '');
      return when ? `Anchored to backup from ${when}` : 'Anchored to backup';
    }
    if (state.startVerified) return 'Verified start';
    if (state.head) return 'Unverified start';
    return '';
  }

  function getPublicSnapshot() {
    const head = state.head;
    const unverified = !!head && !state.startVerified;
    return {
      headUuid: HEAD_UUID,
      counter: head ? Number(head.counter) || 0 : 0,
      tip: head ? String(head.tip || '') : '',
      fingerprint: fingerprintShort(head && head.tip),
      warningCount: state.warnings.length,
      warnings: state.warnings.slice(0, 5),
      hwmCount: Object.keys(state.hwm).length,
      bootstrap: !head,
      startVerified: !!state.startVerified,
      startSkipped: !!state.startSkipped,
      startStatus: state.startStatus,
      startLabel: startLabelText(),
      startAnchorAt: state.startAnchorAt,
      startAnchorLabel: state.startAnchorLabel,
      needsStartConfirm: unverified && !state.startSkipped,
      showUnverifiedLabel: unverified,
      canApproveDevice: !!state.startVerified && !!head && !!head.tip,
    };
  }

  // --- Feature C: out-of-band anchors ---------------------------------

  function crc16ccitt(bytes) {
    let crc = 0xffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc ^= bytes[i] << 8;
      for (let b = 0; b < 8; b += 1) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xffff;
      }
    }
    return crc;
  }

  function bytesToBase32(bytes) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      value = (value << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        out += B32[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
  }

  function base32ToBytes(text) {
    const clean = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    if (!clean) return null;
    const out = [];
    let bits = 0;
    let value = 0;
    for (let i = 0; i < clean.length; i += 1) {
      const idx = B32.indexOf(clean[i]);
      if (idx < 0) return null;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return new Uint8Array(out);
  }

  function tipToBytes(tip) {
    const hex = String(tip || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) return null;
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function bytesToTip(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function packAnchorBytes(anchor) {
    const tipBytes = tipToBytes(anchor.tip);
    if (!tipBytes) throw new Error('Invalid tip hash for anchor');
    const counter = Number(anchor.counter) || 0;
    if (counter < 0 || counter > 0xffffffff) throw new Error('Invalid counter for anchor');
    const ts = Number(anchor.ts) || Date.now();
    const body = new Uint8Array(1 + 4 + 32 + 6);
    body[0] = ANCHOR_VERSION;
    body[1] = (counter >>> 24) & 255;
    body[2] = (counter >>> 16) & 255;
    body[3] = (counter >>> 8) & 255;
    body[4] = counter & 255;
    body.set(tipBytes, 5);
    // 48-bit ms timestamp
    let t = ts;
    for (let i = 5; i >= 0; i -= 1) {
      body[37 + i] = t & 255;
      t = Math.floor(t / 256);
    }
    const crc = crc16ccitt(body);
    const out = new Uint8Array(body.length + 2);
    out.set(body, 0);
    out[body.length] = (crc >>> 8) & 255;
    out[body.length + 1] = crc & 255;
    return out;
  }

  function unpackAnchorBytes(bytes) {
    if (!bytes || bytes.length < 45) return { ok: false, error: 'truncated' };
    const body = bytes.slice(0, 43);
    const crc = (bytes[43] << 8) | bytes[44];
    if (crc16ccitt(body) !== crc) return { ok: false, error: 'checksum' };
    const version = body[0];
    if (version !== ANCHOR_VERSION) return { ok: false, error: 'version', version };
    const counter = ((body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4]) >>> 0;
    const tip = bytesToTip(body.slice(5, 37));
    let ts = 0;
    for (let i = 0; i < 6; i += 1) ts = (ts * 256) + body[37 + i];
    return {
      ok: true,
      anchor: { v: version, counter, tip, ts },
    };
  }

  function encodeAnchorPayload(anchor) {
    const a = {
      v: ANCHOR_VERSION,
      counter: Number(anchor.counter) || 0,
      tip: String(anchor.tip || '').toLowerCase(),
      ts: Number(anchor.ts) || Date.now(),
    };
    if (!/^[0-9a-f]{64}$/.test(a.tip)) throw new Error('Anchor tip must be a 64-char hex SHA-256');
    const qr = `${ANCHOR_PREFIX}:${a.counter}:${a.tip}:${a.ts}`;
    const packed = packAnchorBytes(a);
    const codeRaw = bytesToBase32(packed);
    const code = codeRaw.replace(/(.{4})/g, '$1-').replace(/-$/, '');
    return {
      version: ANCHOR_VERSION,
      counter: a.counter,
      tip: a.tip,
      ts: a.ts,
      fingerprint: fingerprintShort(a.tip),
      qr,
      code,
      // Explicitly no keys / plaintext / password material.
      fields: ['v', 'counter', 'tip', 'ts'],
    };
  }

  function decodeAnchorPayload(raw) {
    const text = String(raw || '').trim();
    if (!text) return { ok: false, error: 'empty' };

    if (text.toUpperCase().startsWith(`${ANCHOR_PREFIX}:`) || /^DGVA\d+:/i.test(text)) {
      const parts = text.split(':');
      const verToken = parts[0].toUpperCase();
      const verMatch = /^DGVA(\d+)$/.exec(verToken);
      if (!verMatch) return { ok: false, error: 'format' };
      const version = Number(verMatch[1]);
      if (version !== ANCHOR_VERSION) return { ok: false, error: 'version', version };
      if (parts.length !== 4) return { ok: false, error: 'format' };
      const counter = Number(parts[1]);
      const tip = String(parts[2] || '').toLowerCase();
      const ts = Number(parts[3]);
      if (!Number.isFinite(counter) || counter < 0) return { ok: false, error: 'counter' };
      if (!/^[0-9a-f]{64}$/.test(tip)) return { ok: false, error: 'tip' };
      if (!Number.isFinite(ts)) return { ok: false, error: 'ts' };
      return { ok: true, anchor: { v: version, counter, tip, ts }, source: 'qr' };
    }

    const bytes = base32ToBytes(text);
    if (!bytes) return { ok: false, error: 'format' };
    const unpacked = unpackAnchorBytes(bytes);
    if (!unpacked.ok) return unpacked;
    return { ok: true, anchor: unpacked.anchor, source: 'code' };
  }

  /**
   * Build an approval payload from this device's local verified vault head only.
   * Never refreshes from the server.
   */
  function buildApprovalPayload() {
    if (!state.startVerified || !state.head || !state.head.tip) {
      throw new Error('Only a verified device can approve a new device');
    }
    return encodeAnchorPayload({
      counter: Number(state.head.counter) || 0,
      tip: String(state.head.tip),
      ts: Date.now(),
    });
  }

  function chainLinksToTip(targetTip) {
    const want = String(targetTip || '');
    if (!want) return false;
    let cur = state.head;
    const seen = new Set();
    while (cur && cur.tip) {
      if (cur.tip === want) return true;
      if (seen.has(cur.tip)) break;
      seen.add(cur.tip);
      const prevTip = String(cur.prev_tip || '');
      if (!prevTip) break;
      if (prevTip === want) return true;
      const found = state.headsSeen.find((h) => h.tip === prevTip);
      if (!found) {
        // Direct prev_tip match already handled; stop if we cannot walk further.
        break;
      }
      cur = found;
    }
    // Also accept if any remembered head tip equals target (reachable history).
    return state.headsSeen.some((h) => h.tip === want);
  }

  /**
   * Verify an out-of-band anchor against the local (possibly unverified) head.
   * Does not overwrite local state on failure.
   */
  function verifyAnchor(rawOrAnchor) {
    let anchor;
    if (rawOrAnchor && typeof rawOrAnchor === 'object' && rawOrAnchor.tip != null) {
      anchor = {
        v: Number(rawOrAnchor.v) || ANCHOR_VERSION,
        counter: Number(rawOrAnchor.counter) || 0,
        tip: String(rawOrAnchor.tip || '').toLowerCase(),
        ts: Number(rawOrAnchor.ts) || 0,
      };
      if (anchor.v !== ANCHOR_VERSION) {
        return { ok: false, error: 'version', message: 'This approval code uses an unsupported format version.' };
      }
    } else {
      const decoded = decodeAnchorPayload(rawOrAnchor);
      if (!decoded.ok) {
        const messages = {
          checksum: 'That code failed its checksum check. Re-type it or scan again.',
          version: 'That approval code uses an unsupported format version.',
          empty: 'Enter an approval code or scan a QR.',
          tip: 'That approval code is incomplete.',
          truncated: 'That approval code is incomplete.',
        };
        return {
          ok: false,
          error: decoded.error,
          message: messages[decoded.error] || 'That approval code could not be read.',
        };
      }
      anchor = decoded.anchor;
    }

    const local = state.head;
    if (!local || !local.tip) {
      return {
        ok: false,
        error: 'no_head',
        message: 'Sync first so this device has a vault head to compare.',
      };
    }

    const A = Number(anchor.counter) || 0;
    const T = String(anchor.tip);
    const localC = Number(local.counter) || 0;
    const localT = String(local.tip);

    if (localC === A && localT === T) {
      markStartVerified({ source: 'device' });
      return { ok: true, matched: 'equal', message: 'This device is up to date with your other device.' };
    }

    if (localC > A) {
      if (localT === T || chainLinksToTip(T)) {
        markStartVerified({ source: 'device' });
        return {
          ok: true,
          matched: 'ahead',
          message: 'This device is ahead of the approval code and the chain links back — start verified.',
        };
      }
      return {
        ok: false,
        needFresh: true,
        error: 'stale_anchor',
        message: 'Ask your other device for a fresh approval code. This device moved ahead and cannot link back to that tip.',
      };
    }

    // localC < A, or same counter with different tip
    const warning = pushWarning(
      WARN_TYPES.start,
      'The server gave this device an older version of your vault than your other device has',
      { localCounter: localC, anchorCounter: A, localTip: localT, anchorTip: T },
    );
    return {
      ok: false,
      rollback: true,
      error: localC === A ? 'fork' : 'rollback',
      warning,
      message: warning.message,
    };
  }

  /** Confirm-by-eye: user asserts the other device shows the same counter+fingerprint. */
  function confirmStartByEye() {
    if (!state.head || !state.head.tip) {
      return { ok: false, message: 'Sync first so this device has a vault head to compare.' };
    }
    markStartVerified({ source: 'device' });
    return { ok: true, matched: 'eye', message: 'Start verified by matching counter and fingerprint.' };
  }

  /**
   * Optional: when restoring an encrypted backup that includes a vault_head,
   * treat that head as the out-of-band anchor (backup was produced by a trusted device).
   */
  function anchorFromBackup(headContentIn, backupDateLabel) {
    if (!headContentIn || headContentIn.type !== 'vault_head') {
      return { ok: false, error: 'no_head' };
    }
    const remote = {
      counter: Number(headContentIn.counter) || 0,
      tip: String(headContentIn.tip || ''),
      prev_tip: String(headContentIn.prev_tip || ''),
      prev_counter: Number(headContentIn.prev_counter) || 0,
    };
    if (!remote.tip) return { ok: false, error: 'no_tip' };
    state.head = { ...remote };
    rememberHead(remote);
    const label = backupDateLabel
      || (headContentIn.updated_at ? String(headContentIn.updated_at).slice(0, 10) : null)
      || new Date().toISOString().slice(0, 10);
    markStartVerified({ source: 'backup', label });
    return { ok: true, label };
  }

  function renderApprovalQrDataUrl(payload) {
    const qrText = (payload && payload.qr) || '';
    if (!qrText) return '';
    const factory = global.qrcode;
    if (typeof factory !== 'function') return '';
    try {
      const qr = factory(0, 'M');
      qr.addData(qrText);
      qr.make();
      return qr.createDataURL(4, 8);
    } catch (err) {
      return '';
    }
  }

  async function encryptState(cryptoKey) {
    if (!global.NotesCrypto || !cryptoKey) return null;
    return global.NotesCrypto.encryptObject(cryptoKey, {
      hwm: state.hwm,
      head: state.head,
      headsSeen: state.headsSeen,
      startVerified: !!state.startVerified,
      startSkipped: !!state.startSkipped,
      startStatus: state.startStatus,
      startAnchorAt: state.startAnchorAt,
      startAnchorLabel: state.startAnchorLabel,
    });
  }

  async function decryptState(cryptoKey, payload) {
    if (!global.NotesCrypto || !cryptoKey || !payload) return emptyState();
    const plain = await global.NotesCrypto.decryptObject(cryptoKey, payload);
    const next = emptyState();
    next.hwm = plain.hwm && typeof plain.hwm === 'object' ? plain.hwm : Object.create(null);
    next.head = plain.head || null;
    next.headsSeen = Array.isArray(plain.headsSeen) ? plain.headsSeen : [];
    next.warnings = state.warnings || [];
    // Grandfather Feature A devices: existing head without start fields ⇒ verified.
    if (typeof plain.startVerified === 'boolean') {
      next.startVerified = plain.startVerified;
      next.startSkipped = !!plain.startSkipped;
      next.startStatus = plain.startStatus
        || (plain.startVerified ? 'verified' : (plain.head ? 'unverified' : null));
      next.startAnchorAt = plain.startAnchorAt || null;
      next.startAnchorLabel = plain.startAnchorLabel || null;
    } else if (plain.head) {
      next.startVerified = true;
      next.startSkipped = false;
      next.startStatus = 'verified';
    } else {
      next.startVerified = false;
      next.startStatus = null;
    }
    return next;
  }

  let loadPromise = null;
  async function load(cryptoKey) {
    setCryptoKey(cryptoKey);
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      state = emptyState();
      if (!global.NotesIDB || !cryptoKey) return;
      try {
        const row = await global.NotesIDB.getMeta(META_KEY);
        if (row && row.payload) {
          state = await decryptState(cryptoKey, row.payload);
        } else if (row && (row.hwm || row.head)) {
          // Unexpected plaintext shape — ignore (fail closed to empty + bootstrap)
          state = emptyState();
        }
      } catch (err) {
        state = emptyState();
      }
      emit();
    })().finally(() => { loadPromise = null; });
    return loadPromise;
  }

  async function persistNow(cryptoKey) {
    if (!global.NotesIDB || !cryptoKey) return;
    try {
      const payload = await encryptState(cryptoKey);
      if (!payload) return;
      await global.NotesIDB.putMeta(META_KEY, { payload, updated_at: Date.now() / 1000 });
    } catch (err) {
      /* non-fatal */
    }
  }

  let cryptoKeyRef = null;
  function setCryptoKey(key) {
    cryptoKeyRef = key || null;
  }

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      persistNow(cryptoKeyRef).catch(() => {});
      emit();
    }, 200);
  }

  async function resetAfterIntentionalRestore(cryptoKey) {
    state = emptyState();
    setCryptoKey(cryptoKey);
    await persistNow(cryptoKey);
    emit();
  }

  function clearMemory() {
    state = emptyState();
    cryptoKeyRef = null;
    emit();
  }

  /**
   * QA-only: raise the local high-water mark so the next production freshness
   * check treats the server copy as a rollback. Does nothing unless
   * notes_freshness_test=1. Pair with NotesStore.testFreshnessProbeItem(uuid)
   * or NotesStore.testDemoRollbackWarning(uuid) so a real server ciphertext
   * runs through applySyncPayload (a quiet sync alone often pulls 0 items).
   */
  function testInjectRollbackScenario(uuid, heldVersion) {
    if (!isTestHookEnabled()) {
      throw new Error('Freshness test hook disabled (set localStorage notes_freshness_test=1)');
    }
    const id = String(uuid || '');
    state.hwm[id] = { v: Number(heldVersion) || 2, hash: state.hwm[id]?.hash || 'testhash' };
    schedulePersist();
    return getHwm(id);
  }

  const api = {
    META_KEY,
    HEAD_UUID,
    WARN_TYPES,
    ANCHOR_VERSION,
    ANCHOR_PREFIX,
    isTestHookEnabled,
    onChange,
    load,
    persistNow,
    setCryptoKey,
    clearMemory,
    resetAfterIntentionalRestore,
    stampForUpsert,
    stampForWrap,
    annotateDecrypted,
    checkIncoming,
    noteAccepted,
    evaluateRemoteHead,
    commitLocalHead,
    buildNextHead,
    headContent,
    getHwm,
    itemVersion,
    getPublicSnapshot,
    clearWarnings,
    pushWarning,
    fingerprintShort,
    computeTip,
    versionsMapFromItems,
    shouldTrackType,
    testInjectRollbackScenario,
    encodeAnchorPayload,
    decodeAnchorPayload,
    buildApprovalPayload,
    verifyAnchor,
    confirmStartByEye,
    skipStartVerification,
    reopenStartVerification,
    anchorFromBackup,
    renderApprovalQrDataUrl,
    markStartVerified,
    get state() { return state; },
  };

  global.NotesFreshness = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : global);
