/*
 * Direct fetch of one .ics feed (docs/ICS_SUBSCRIBE_SPEC.md section 3).
 * Served with its own CSP: default-src 'none'; connect-src https:
 * Message in: {id, url}. Out: {id, ok: true, text} or {id, ok: false, code}.
 * Never returns the URL, response headers or an exception message, and never logs.
 */
'use strict';

const ICS_FEED_MAX_BYTES = 2 * 1024 * 1024;
const ICS_FEED_TIMEOUT_MS = 10000;
const ICS_FEED_MAX_URL = 2048;

async function readCapped(res, signal) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ICS_FEED_MAX_BYTES) return { code: 'E_TOO_LARGE' };
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > ICS_FEED_MAX_BYTES) return { code: 'E_TOO_LARGE' };
    return { bytes: buf };
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    if (signal.aborted) return { code: 'E_TIMEOUT' };
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ICS_FEED_MAX_BYTES) {
      try { reader.cancel(); } catch (e) { /* ignore */ }
      return { code: 'E_TOO_LARGE' };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes };
}

async function fetchFeed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { code: 'E_URL' };
  }
  if (url.length > ICS_FEED_MAX_URL || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return { code: 'E_URL' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ICS_FEED_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'follow',
        cache: 'no-store',
        mode: 'cors',
        signal: ctrl.signal,
      });
    } catch (e) {
      return { code: ctrl.signal.aborted ? 'E_TIMEOUT' : 'E_NETWORK_OR_CORS' };
    }
    if (res.url && !/^https:\/\//i.test(res.url)) return { code: 'E_REDIRECT' };
    if (!res.ok) return { code: 'E_UPSTREAM' };
    let out;
    try {
      out = await readCapped(res, ctrl.signal);
    } catch (e) {
      return { code: ctrl.signal.aborted ? 'E_TIMEOUT' : 'E_NETWORK_OR_CORS' };
    }
    if (out.code) return out;
    const text = new TextDecoder('utf-8').decode(out.bytes);
    if (!/BEGIN:VCALENDAR/i.test(text)) return { code: 'E_NOT_ICS' };
    return { text };
  } finally {
    clearTimeout(timer);
  }
}

self.onmessage = async (event) => {
  const data = event.data || {};
  const id = data.id;
  const url = typeof data.url === 'string' ? data.url : '';
  let result;
  try {
    result = await fetchFeed(url);
  } catch (e) {
    result = { code: 'E_NETWORK_OR_CORS' };
  }
  if (typeof result.text === 'string') self.postMessage({ id, ok: true, text: result.text });
  else self.postMessage({ id, ok: false, code: result.code });
};
