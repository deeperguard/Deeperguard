/*
 * Hardened ZIP reader and writer (no dependencies, no network, no eval).
 * Limits and rules: docs/IMPORT_EXPORT_SPEC.md sections 4.1 and 4.2.
 *
 * Writer: NotesZip.writeZip([{ name, bytes }], { compress }) -> Promise<Uint8Array>
 *   Stored, or deflate (CompressionStream 'deflate-raw') when the browser has it
 *   and the result is smaller. CRC-32 for every entry. No ZIP64.
 * Reader: NotesZip.readZip(bytes, limits) -> Promise<[{ name, bytes }]>
 *   Stored and deflate (DecompressionStream 'deflate-raw'). Limits are checked
 *   against the bytes actually produced while streaming; sizes in the headers
 *   are never trusted. Failures throw ZipError with a `code`.
 */
const NotesZip = (() => {
  const MIB = 1024 * 1024;
  const DEFAULT_LIMITS = Object.freeze({
    maxZipBytes: 512 * MIB,
    maxEntries: 10000,
    maxTotalBytes: 1024 * MIB,
    maxEntryBytes: 50 * MIB,
    maxTextEntryBytes: 10 * MIB,
    entryRatio: 100,
    entryRatioFloor: MIB,
    archiveRatio: 50,
  });
  const TEXT_ENTRY = /\.(md|json|ics|txt)$/i;
  const MAX_SEGMENT_BYTES = 255;
  const MAX_PATH_BYTES = 1024;
  const MAX_SEGMENTS = 8;

  class ZipError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'ZipError';
      this.code = code;
    }
  }

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (~crc) >>> 0;
  }

  /** Throws ZipError('unsafe-name') unless the name is a safe relative path. A trailing "/" marks a directory. */
  function validateName(rawName) {
    const name = String(rawName);
    const fail = (why) => new ZipError('unsafe-name', `Unsafe entry name refused (${why}).`);
    if (!name) throw fail('empty');
    if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw fail('control character or NUL');
    if (name.includes('\\')) throw fail('backslash');
    if (name.startsWith('/')) throw fail('absolute path');
    if (/^[A-Za-z]:/.test(name)) throw fail('drive prefix');
    const encoder = new TextEncoder();
    if (encoder.encode(name).length > MAX_PATH_BYTES) throw fail('path too long');
    const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
    if (segments.length > MAX_SEGMENTS) throw fail('too many path segments');
    for (const segment of segments) {
      if (!segment) throw fail('empty path segment');
      if (segment === '.' || segment === '..') throw fail('"." or ".." segment');
      if (encoder.encode(segment).length > MAX_SEGMENT_BYTES) throw fail('path segment too long');
    }
    return name;
  }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function put16(b, o, v) { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; }
  function put32(b, o, v) {
    b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
  }
  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data || []);
  }

  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      return null;
    }
  }

  async function writeZip(entries, options) {
    const opts = options || {};
    const list = entries || [];
    if (list.length > 0xffff) throw new ZipError('too-many-entries', 'Too many entries for a ZIP without ZIP64.');
    const encoder = new TextEncoder();
    const seen = new Set();
    const parts = [];
    const centrals = [];
    let offset = 0;
    for (const entry of list) {
      const name = validateName(entry && entry.name);
      const key = name.normalize('NFC').toLowerCase();
      if (seen.has(key)) throw new ZipError('duplicate-name', 'Duplicate entry name refused.');
      seen.add(key);
      const isDir = name.endsWith('/');
      const data = isDir ? new Uint8Array(0) : toBytes(entry.bytes);
      if (data.length > 0xfffffffe) throw new ZipError('too-large', 'Entry too large for a ZIP without ZIP64.');
      let method = 0;
      let body = data;
      if (!isDir && opts.compress !== false && data.length > 0) {
        const packed = await deflateRaw(data);
        if (packed && packed.length < data.length) { method = 8; body = packed; }
      }
      const nameBytes = encoder.encode(name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      put32(local, 0, 0x04034b50);
      put16(local, 4, 20);
      put16(local, 6, 0x0800);
      put16(local, 8, method);
      put16(local, 12, 0x0021);
      put32(local, 14, crc);
      put32(local, 18, body.length);
      put32(local, 22, data.length);
      put16(local, 26, nameBytes.length);
      local.set(nameBytes, 30);
      const central = new Uint8Array(46 + nameBytes.length);
      put32(central, 0, 0x02014b50);
      put16(central, 4, 20);
      put16(central, 6, 20);
      put16(central, 8, 0x0800);
      put16(central, 10, method);
      put16(central, 14, 0x0021);
      put32(central, 16, crc);
      put32(central, 20, body.length);
      put32(central, 24, data.length);
      put16(central, 28, nameBytes.length);
      if (isDir) put32(central, 38, 0x10);
      put32(central, 42, offset);
      central.set(nameBytes, 46);
      parts.push(local, body);
      centrals.push(central);
      offset += local.length + body.length;
      if (offset > 0xfffffffe) throw new ZipError('too-large', 'Archive too large for a ZIP without ZIP64.');
    }
    const cdSize = centrals.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    put32(eocd, 0, 0x06054b50);
    put16(eocd, 8, list.length);
    put16(eocd, 10, list.length);
    put32(eocd, 12, cdSize);
    put32(eocd, 16, offset);
    const out = new Uint8Array(offset + cdSize + 22);
    let pos = 0;
    for (const chunk of parts.concat(centrals, [eocd])) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }

  function findEocd(bytes) {
    const min = Math.max(0, bytes.length - 22 - 0xffff);
    for (let i = bytes.length - 22; i >= min; i -= 1) {
      if (u32(bytes, i) === 0x06054b50 && i + 22 + u16(bytes, i + 20) === bytes.length) return i;
    }
    return -1;
  }

  const zip64Error = () => new ZipError('zip64', 'ZIP64 archives are not supported.');

  function parseCentral(bytes, limits) {
    const eocd = findEocd(bytes);
    if (eocd < 0) throw new ZipError('not-a-zip', 'Not a ZIP file.');
    if (eocd >= 20 && u32(bytes, eocd - 20) === 0x07064b50) throw zip64Error();
    const count = u16(bytes, eocd + 10);
    const cdSize = u32(bytes, eocd + 12);
    const cdOff = u32(bytes, eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw zip64Error();
    if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0 || u16(bytes, eocd + 8) !== count) {
      throw new ZipError('multi-disk', 'Multi-disk ZIP archives are not supported.');
    }
    if (count > limits.maxEntries) {
      throw new ZipError('too-many-entries', `ZIP has more than ${limits.maxEntries} entries.`);
    }
    if (cdOff + cdSize > eocd) throw new ZipError('corrupt', 'ZIP directory is inconsistent.');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const seen = new Set();
    const entries = [];
    let pos = cdOff;
    for (let i = 0; i < count; i += 1) {
      if (pos + 46 > cdOff + cdSize || u32(bytes, pos) !== 0x02014b50) {
        throw new ZipError('corrupt', 'ZIP directory is inconsistent.');
      }
      const flags = u16(bytes, pos + 8);
      const method = u16(bytes, pos + 10);
      const crc = u32(bytes, pos + 16);
      const compSize = u32(bytes, pos + 20);
      const size = u32(bytes, pos + 24);
      const nameLen = u16(bytes, pos + 28);
      const extraLen = u16(bytes, pos + 30);
      const commentLen = u16(bytes, pos + 32);
      const diskStart = u16(bytes, pos + 34);
      const extAttr = u32(bytes, pos + 38);
      const localOff = u32(bytes, pos + 42);
      const next = pos + 46 + nameLen + extraLen + commentLen;
      if (next > cdOff + cdSize) throw new ZipError('corrupt', 'ZIP directory is inconsistent.');
      const nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLen);
      let name;
      try { name = decoder.decode(nameBytes); } catch (err) {
        throw new ZipError('unsafe-name', 'Unsafe entry name refused (not valid UTF-8).');
      }
      validateName(name);
      if (flags & 1) throw new ZipError('encrypted', `Encrypted ZIP entry "${name}" is not supported.`);
      if (compSize === 0xffffffff || size === 0xffffffff || localOff === 0xffffffff) throw zip64Error();
      for (let e = pos + 46 + nameLen; e + 4 <= pos + 46 + nameLen + extraLen;) {
        if (u16(bytes, e) === 0x0001) throw zip64Error();
        e += 4 + u16(bytes, e + 2);
      }
      if (diskStart !== 0) throw new ZipError('multi-disk', 'Multi-disk ZIP archives are not supported.');
      if (method !== 0 && method !== 8) {
        throw new ZipError('method', `Unsupported ZIP compression method ${method} for "${name}".`);
      }
      if ((bytes[pos + 5] === 3) && (((extAttr >>> 16) & 0xf000) === 0xa000)) {
        throw new ZipError('symlink', `Symbolic link entry "${name}" refused.`);
      }
      const key = name.normalize('NFC').toLowerCase();
      if (seen.has(key)) throw new ZipError('duplicate-name', `Duplicate entry name "${name}" refused.`);
      seen.add(key);
      entries.push({ name, method, crc, compSize, size, localOff, nameBytes });
      pos = next;
    }
    if (entries.length && Math.min(...entries.map((e) => e.localOff)) !== 0) {
      throw new ZipError('corrupt', 'Data before the first ZIP entry.');
    }
    return { entries, cdOff };
  }

  function localData(bytes, entry, cdOff) {
    const o = entry.localOff;
    if (o + 30 > cdOff || u32(bytes, o) !== 0x04034b50) throw new ZipError('corrupt', `Bad local header for "${entry.name}".`);
    const nameLen = u16(bytes, o + 26);
    const start = o + 30 + nameLen + u16(bytes, o + 28);
    const end = start + entry.compSize;
    const sameName = nameLen === entry.nameBytes.length
      && entry.nameBytes.every((v, i) => bytes[o + 30 + i] === v);
    if (!sameName || u16(bytes, o + 8) !== entry.method || (u16(bytes, o + 6) & 1) || end > cdOff) {
      throw new ZipError('corrupt', `Inconsistent header sizes for "${entry.name}".`);
    }
    return bytes.subarray(start, end);
  }

  async function readZip(input, options) {
    const limits = { ...DEFAULT_LIMITS, ...(options || {}) };
    const bytes = toBytes(input);
    if (bytes.length > limits.maxZipBytes) {
      throw new ZipError('zip-size', `ZIP file is larger than the ${limits.maxZipBytes} byte limit.`);
    }
    const { entries, cdOff } = parseCentral(bytes, limits);
    const out = [];
    let total = 0;
    const checkArchive = () => {
      if (total > limits.maxTotalBytes) {
        throw new ZipError('total-size', `Unpacked size is larger than the ${limits.maxTotalBytes} byte limit.`);
      }
      if (total > limits.archiveRatio * bytes.length) {
        throw new ZipError('archive-ratio', `Compression ratio of the archive is above ${limits.archiveRatio}:1.`);
      }
    };
    for (const entry of entries) {
      const isDir = entry.name.endsWith('/');
      const skip = isDir || entry.name.startsWith('__MACOSX/');
      const cap = TEXT_ENTRY.test(entry.name) ? limits.maxTextEntryBytes : limits.maxEntryBytes;
      const data = localData(bytes, entry, cdOff);
      if (skip) continue;
      let result;
      if (entry.method === 0) {
        if (entry.compSize > cap) throw new ZipError('entry-size', `Entry "${entry.name}" is larger than the ${cap} byte limit.`);
        result = data.slice();
        total += result.length;
        checkArchive();
      } else {
        if (typeof DecompressionStream === 'undefined') {
          throw new ZipError('no-deflate', 'This browser cannot open compressed ZIP entries.');
        }
        const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        const chunks = [];
        let produced = 0;
        try {
          for (;;) {
            let step;
            try { step = await reader.read(); } catch (err) {
              throw new ZipError('corrupt', `Entry "${entry.name}" is not valid deflate data.`);
            }
            if (step.done) break;
            produced += step.value.length;
            total += step.value.length;
            if (produced > cap) throw new ZipError('entry-size', `Entry "${entry.name}" is larger than the ${cap} byte limit.`);
            if (produced > limits.entryRatioFloor && produced > limits.entryRatio * Math.max(entry.compSize, 1)) {
              throw new ZipError('entry-ratio', `Compression ratio of "${entry.name}" is above ${limits.entryRatio}:1.`);
            }
            checkArchive();
            chunks.push(step.value);
          }
        } catch (err) {
          reader.cancel().catch(() => {});
          throw err;
        }
        result = new Uint8Array(produced);
        let at = 0;
        for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
      }
      if (result.length !== entry.size) throw new ZipError('corrupt', `Size mismatch for "${entry.name}".`);
      if (crc32(result) !== entry.crc) throw new ZipError('crc', `CRC check failed for "${entry.name}".`);
      out.push({ name: entry.name, bytes: result });
    }
    return out;
  }

  return { writeZip, readZip, crc32, validateName, ZipError, DEFAULT_LIMITS };
})();
if (typeof window !== 'undefined') window.NotesZip = NotesZip;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesZip;
