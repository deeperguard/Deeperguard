const NotesSnImport = (() => {
  const SN_PREFIX = /^(001|002|003|004):/;
  const FILE_TYPES = new Set(['File', 'SN|File']);
  const NOTE_DUMP = /\.(md|txt)$/i;

  function asObject(raw) {
    if (raw == null) throw new Error('Empty backup file');
    if (typeof raw === 'string') {
      const text = raw.replace(/^\uFEFF/, '').trim();
      if (!text) throw new Error('Empty backup file');
      if (text.charCodeAt(0) === 0x50 && text.charCodeAt(1) === 0x4b) {
        throw new Error('Unzip the Standard Notes backup in Files, then import “Standard Notes Backup and Import File.txt”.');
      }
      return JSON.parse(text);
    }
    if (typeof raw === 'object') return raw;
    throw new Error('Unrecognized backup file');
  }

  function backupItems(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
    return [];
  }

  function itemContentObject(item) {
    const raw = item && item.content;
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || SN_PREFIX.test(raw)) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  function isEncryptedSnItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (itemContentObject(item)) return false;
    if (typeof item.content === 'string' && SN_PREFIX.test(item.content)) return true;
    return typeof item.enc_item_key === 'string' && item.enc_item_key.includes(':');
  }

  function isDecryptedSn(data) {
    return backupItems(data).some((item) => {
      const type = String(item && item.content_type || '');
      return (type === 'Note' || type === 'Tag') && !!itemContentObject(item);
    });
  }

  function isHomelab(data) {
    if (!data || typeof data !== 'object') return false;
    if (data.format === 'deeperguard-backup-v1' || data.format === 'homelab-notes-backup-v1') return true;
    const items = Array.isArray(data.items) ? data.items : [];
    return items.some((item) => item && (item.ciphertext || item.item_uuid));
  }

  function isFileType(type) {
    return FILE_TYPES.has(String(type || ''));
  }

  function snAppData(content) {
    const bag = content && content.appData && content.appData['org.standardnotes.sn'];
    return bag && typeof bag === 'object' ? bag : {};
  }

  function looksLikeChecklist(text) {
    return /^\s*[-*]\s+\[[ xX]\]/m.test(String(text || ''));
  }

  function editorFromSn(content) {
    const noteType = String(content.noteType || '').toLowerCase();
    const editor = String(content.editorIdentifier || '').toLowerCase();
    const body = noteText(content);
    if (noteType === 'superscript' || editor.includes('superscript')) return 'superscript';
    if (noteType === 'super' || editor.includes('super')) {
      return looksLikeChecklist(body) ? 'super' : 'markdown';
    }
    if (noteType === 'task' || noteType === 'checklist' || editor.includes('checklist') || editor.includes('task')) {
      return looksLikeChecklist(body) ? 'checklist' : 'markdown';
    }
    if (noteType === 'markdown' || editor.includes('markdown')) return 'markdown';
    if (noteType === 'code' || editor.includes('code')) return 'code';
    return 'plain';
  }

  function superDocToMarkdown(raw) {
    if (typeof window !== 'undefined' && window.NotesSuperscript?.superDocToMarkdown) {
      return window.NotesSuperscript.superDocToMarkdown(raw);
    }
    let tree = raw;
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (!text.startsWith('{') || !/"type"\s*:\s*"doc"/.test(text)) return '';
      try { tree = JSON.parse(text); } catch (err) { return ''; }
    }
    if (!tree || typeof tree !== 'object' || String(tree.type || '') !== 'doc') return '';
    const parts = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      const type = String(node.type || '');
      if (typeof node.text === 'string') {
        const marks = Array.isArray(node.marks) ? node.marks : [];
        const link = marks.find((mark) => String(mark && mark.type || '').toLowerCase() === 'link');
        const href = link && link.attrs ? String(link.attrs.href || link.attrs.url || '').trim() : '';
        parts.push(href ? `[${node.text}](${href})` : node.text);
        return;
      }
      if (type === 'hardBreak' || type === 'break') {
        parts.push('\n');
        return;
      }
      const kids = Array.isArray(node.content) ? node.content : [];
      for (const child of kids) walk(child);
      if (type === 'paragraph' || type === 'heading' || type === 'listItem' || type === 'blockquote') {
        parts.push('\n');
      }
    };
    walk(tree);
    return parts.join('').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
  }

  function noteText(content) {
    const text = String(content.text || '');
    const preview = String(content.preview_plain || '');
    const fromSuper = superDocToMarkdown(text);
    if (fromSuper && fromSuper.trim()) return fromSuper;
    if (String(content.noteType || '').toLowerCase() === 'super' && preview) return preview;
    if (text.startsWith('{') && preview && /"type"\s*:\s*"doc"/.test(text)) return preview;
    return text || preview;
  }

  function tagTitleKey(title) {
    return String(title || '').trim().toLowerCase();
  }

  function mergeTagsByTitle(incomingTags, notes, existingTags = []) {
    const keepByTitle = new Map();
    for (const tag of existingTags || []) {
      const uuid = String(tag && tag.uuid || '').trim();
      const key = tagTitleKey(tag && (tag.content && tag.content.title || tag.title));
      if (!uuid || !key || keepByTitle.has(key)) continue;
      keepByTitle.set(key, uuid);
    }
    const idMap = new Map();
    const tags = [];
    for (const tag of incomingTags || []) {
      const key = tagTitleKey(tag && tag.content && tag.content.title);
      const existing = key ? keepByTitle.get(key) : '';
      if (existing && existing !== tag.uuid) {
        idMap.set(tag.uuid, existing);
        continue;
      }
      if (key) keepByTitle.set(key, tag.uuid);
      tags.push(tag);
    }
    for (const note of notes || []) {
      if (!note || !note.content) continue;
      note.content.tags = [...new Set((note.content.tags || []).map((id) => idMap.get(id) || id))];
    }
    return { tags, notes, remapped: idMap.size };
  }

  function iso(value, fallback) {
    const date = new Date(value || '');
    if (Number.isFinite(date.getTime()) && date.getTime() > 0) return date.toISOString();
    return fallback || new Date().toISOString();
  }

  function bytesToB64(bytes) {
    if (!bytes || !bytes.length) return '';
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function b64ToBytes(text) {
    const clean = String(text || '').replace(/\s+/g, '');
    if (!clean) return null;
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function dataUriToBytes(uri) {
    const match = String(uri || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) return null;
    const payload = match[3] || '';
    if (match[2]) return b64ToBytes(payload);
    return new TextEncoder().encode(decodeURIComponent(payload));
  }

  function mimeFromDataUri(uri) {
    const match = String(uri || '').match(/^data:([^;,]+)/);
    return match ? match[1] : '';
  }

  function extForMime(mime) {
    const type = String(mime || '').toLowerCase();
    if (type.includes('png')) return 'png';
    if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
    if (type.includes('gif')) return 'gif';
    if (type.includes('webp')) return 'webp';
    if (type.includes('pdf')) return 'pdf';
    if (type.includes('heic')) return 'heic';
    return 'bin';
  }

  function fileBytesFromContent(content) {
    if (!content || typeof content !== 'object') return null;
    const keys = ['data', 'data_b64', 'binary', 'rawData', 'base64', 'fileData'];
    for (const key of keys) {
      const value = content[key];
      if (typeof value === 'string' && value.length >= 8) {
        if (value.startsWith('data:')) return dataUriToBytes(value);
        try {
          const bytes = b64ToBytes(value);
          if (bytes && bytes.length) return bytes;
        } catch (err) {
          /* try next field */
        }
      }
    }
    return null;
  }

  function walkSuperNodes(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    const children = Array.isArray(node.content) ? node.content : [];
    for (const child of children) walkSuperNodes(child, visit);
  }

  function extractSuperFiles(content, noteId) {
    const text = String(content && content.text || '');
    if (!text.startsWith('{')) return [];
    let tree;
    try {
      tree = JSON.parse(text);
    } catch (err) {
      return [];
    }
    if (!tree || typeof tree !== 'object') return [];
    const files = [];
    let imageIndex = 0;
    walkSuperNodes(tree, (node) => {
      const type = String(node.type || '').toLowerCase();
      const attrs = node.attrs && typeof node.attrs === 'object' ? node.attrs : {};
      const src = String(attrs.src || node.src || '');
      const fileUuid = String(attrs.fileUuid || attrs.fileId || attrs.uuid || '').trim();
      const isImage = type.includes('image') || type === 'snfile' || type === 'file';
      if (!isImage && !src.startsWith('data:')) return;
      if (src.startsWith('data:')) {
        const bytes = dataUriToBytes(src);
        if (!bytes || !bytes.length) return;
        imageIndex += 1;
        const mime = mimeFromDataUri(src) || 'image/png';
        files.push({
          uuid: `super-${noteId}-${imageIndex}`,
          name: String(attrs.name || attrs.alt || `image-${imageIndex}.${extForMime(mime)}`),
          mime,
          size: bytes.length,
          noteIds: [noteId],
          data_b64: bytesToB64(bytes),
        });
        return;
      }
      if (fileUuid) {
        files.push({
          uuid: fileUuid,
          name: String(attrs.name || attrs.alt || 'attachment'),
          mime: String(attrs.mimeType || attrs.mime || ''),
          size: Number(attrs.size || attrs.decryptedSize || 0) || 0,
          noteIds: [noteId],
          data_b64: '',
        });
      }
    });
    return files;
  }

  function pendingFromFile(file) {
    return {
      uuid: file.uuid,
      name: file.name || 'attachment',
      mime: file.mime || '',
      size: Number(file.size || 0) || 0,
    };
  }

  function mergePending(lists) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
      for (const item of list || []) {
        const uuid = String(item && item.uuid || '').trim();
        if (!uuid || seen.has(uuid)) continue;
        seen.add(uuid);
        out.push({
          uuid,
          name: String(item.name || 'attachment'),
          mime: String(item.mime || ''),
          size: Number(item.size || 0) || 0,
        });
      }
    }
    return out;
  }

  function convertSn(data) {
    const items = backupItems(data);
    const noteTags = new Map();
    const noteFiles = new Map();
    const tags = [];
    const notes = [];
    const filesById = new Map();
    let skipped = 0;

    function addNoteFile(noteId, file) {
      if (!noteId || !file || !file.uuid) return;
      const existing = filesById.get(file.uuid);
      if (existing) {
        if (!existing.noteIds.includes(noteId)) existing.noteIds.push(noteId);
        if (!existing.data_b64 && file.data_b64) existing.data_b64 = file.data_b64;
        if (!existing.name && file.name) existing.name = file.name;
      } else {
        filesById.set(file.uuid, {
          uuid: file.uuid,
          name: file.name || 'attachment',
          mime: file.mime || '',
          size: Number(file.size || 0) || 0,
          noteIds: [noteId],
          data_b64: file.data_b64 || '',
          created_at: file.created_at,
        });
      }
      const list = noteFiles.get(noteId) || [];
      if (!list.includes(file.uuid)) {
        list.push(file.uuid);
        noteFiles.set(noteId, list);
      }
    }

    for (const item of items) {
      if (!item || item.deleted) continue;
      if (item.content_type === 'Tag' && itemContentObject(item)) {
        const content = itemContentObject(item);
        const uuid = String(item.uuid || '').trim();
        if (!uuid) {
          skipped += 1;
          continue;
        }
        tags.push({
          uuid,
          content: {
            type: 'tag',
            title: String(content.title || 'Tag').trim() || 'Tag',
            color: String(content.color || '#4f8cff'),
            created_at: iso(item.created_at),
            updated_at: iso(item.updated_at || item.created_at),
          },
        });
        for (const ref of content.references || []) {
          if (!ref || ref.content_type !== 'Note' || !ref.uuid) continue;
          const list = noteTags.get(ref.uuid) || [];
          list.push(uuid);
          noteTags.set(ref.uuid, list);
        }
        continue;
      }
      if (isFileType(item.content_type) && itemContentObject(item)) {
        const content = itemContentObject(item);
        const uuid = String(item.uuid || '').trim();
        if (!uuid) {
          skipped += 1;
          continue;
        }
        const bytes = fileBytesFromContent(content);
        const noteIds = [
          ...(content.references || []).filter((ref) => ref && ref.content_type === 'Note' && ref.uuid).map((ref) => ref.uuid),
          ...(content.associatedItemIds || []).filter(Boolean),
        ];
        const file = {
          uuid,
          name: String(content.name || content.filename || content.title || 'attachment'),
          mime: String(content.mimeType || content.mime || ''),
          size: Number(content.decryptedSize || content.size || (bytes && bytes.length) || 0) || 0,
          noteIds: [],
          data_b64: bytes ? bytesToB64(bytes) : '',
          created_at: iso(item.created_at),
        };
        filesById.set(uuid, file);
        for (const noteId of noteIds) addNoteFile(noteId, file);
        continue;
      }
      if (item.content_type && item.content_type !== 'Note') {
        skipped += 1;
      }
    }

    for (const item of items) {
      if (!item || item.deleted || item.content_type !== 'Note') continue;
      const content = itemContentObject(item);
      if (!content) {
        skipped += 1;
        continue;
      }
      const uuid = String(item.uuid || '').trim();
      if (!uuid) {
        skipped += 1;
        continue;
      }
      const meta = snAppData(content);
      const fromNote = (content.references || [])
        .filter((ref) => ref && ref.content_type === 'Tag' && ref.uuid)
        .map((ref) => ref.uuid);
      const tagsForNote = [...new Set([...(noteTags.get(uuid) || []), ...fromNote])];
      for (const ref of content.references || []) {
        if (!ref || !ref.uuid || !isFileType(ref.content_type)) continue;
        const known = filesById.get(ref.uuid);
        addNoteFile(uuid, known || { uuid: ref.uuid, name: 'attachment', mime: '', size: 0, data_b64: '' });
      }
      for (const extra of extractSuperFiles(content, uuid)) addNoteFile(uuid, extra);
      const pending = (noteFiles.get(uuid) || [])
        .map((id) => filesById.get(id))
        .filter(Boolean)
        .map(pendingFromFile);
      notes.push({
        uuid,
        content: {
          type: 'note',
          title: String(content.title || 'Untitled'),
          content: noteText(content),
          tags: tagsForNote,
          attachments: [],
          sn_pending_files: pending,
          revisions: [],
          editor: editorFromSn(content),
          prevent_edit: false,
          locked: false,
          starred: !!(meta.starred || meta.pinned),
          pinned: !!meta.pinned,
          archived: !!meta.archived,
          trashed: !!meta.trashed,
          created_at: iso(item.created_at),
          updated_at: iso(item.updated_at || item.created_at),
        },
      });
    }

    const collapsed = mergeTagsByTitle(tags, notes, []);
    return {
      tags: collapsed.tags,
      notes: collapsed.notes,
      files: [...filesById.values()],
      skipped,
    };
  }

  function blobBaseName(path) {
    return String(path || '').split(/[/\\]/).pop() || '';
  }

  function isBackupJsonName(name) {
    const base = blobBaseName(name);
    return /Backup and Import File/i.test(base) || /^Standard Notes Backup/i.test(base);
  }

  function matchBlobToFile(file, blobs) {
    const uuid = String(file.uuid || '').toLowerCase();
    const name = blobBaseName(file.name).toLowerCase();
    for (const blob of blobs || []) {
      const path = String(blob.name || blob.path || '').replace(/\\/g, '/');
      const base = blobBaseName(path).toLowerCase();
      if (uuid && path.toLowerCase().includes(uuid)) return blob;
      if (name && base === name) return blob;
    }
    return null;
  }

  function applyBackupBlobs(converted, blobs) {
    if (!converted || converted.kind === 'sn-encrypted') return converted;
    const files = converted.files || [];
    const extras = [];
    const used = new Set();
    for (const file of files) {
      if (file.data_b64) continue;
      const blob = matchBlobToFile(file, blobs);
      if (!blob || !blob.bytes || !blob.bytes.length) continue;
      file.data_b64 = bytesToB64(blob.bytes);
      file.size = file.size || blob.bytes.length;
      used.add(blob);
    }
    for (const blob of blobs || []) {
      if (used.has(blob)) continue;
      const path = String(blob.name || '');
      if (isBackupJsonName(path) || (NOTE_DUMP.test(path) && !/files?\//i.test(path))) continue;
      if (!blob.bytes || !blob.bytes.length) continue;
      extras.push({
        name: blobBaseName(path),
        mime: blob.mime || '',
        data_b64: bytesToB64(blob.bytes),
        size: blob.bytes.length,
      });
    }
    converted.blobs = extras;
    return converted;
  }

  function parse(raw, { blobs } = {}) {
    const data = asObject(raw);
    if (isHomelab(data)) return { kind: 'homelab', data };
    if (isDecryptedSn(data)) {
      const converted = convertSn(data);
      const result = { kind: 'sn', ...converted };
      return applyBackupBlobs(result, blobs);
    }
    const items = backupItems(data);
    if (items.some(isEncryptedSnItem) || (data && data.keyParams && items.length)) {
      return {
        kind: 'sn-encrypted',
        error: 'This is an encrypted Standard Notes backup. On the iPhone open Standard Notes → Preferences → Backups and download a Decrypted backup. Unzip it, then import “Standard Notes Backup and Import File.txt”.',
      };
    }
    throw new Error('Unrecognized backup file. Export a decrypted Standard Notes backup or a Deeperguard vault.');
  }

  function readU16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function readU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function findEocd(bytes) {
    const start = Math.max(0, bytes.length - 22 - 65535);
    for (let i = bytes.length - 22; i >= start; i -= 1) {
      if (readU32(bytes, i) === 0x06054b50) return i;
    }
    return -1;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot open compressed zip backups. Import the unzipped .txt, then add the files.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const eocd = findEocd(bytes);
    if (eocd < 0) throw new Error('Not a zip file');
    const cdSize = readU32(bytes, eocd + 12);
    const cdOff = readU32(bytes, eocd + 16);
    let pos = cdOff;
    const entries = [];
    while (pos + 46 <= cdOff + cdSize) {
      if (readU32(bytes, pos) !== 0x02014b50) break;
      const method = readU16(bytes, pos + 10);
      const compSize = readU32(bytes, pos + 20);
      const nameLen = readU16(bytes, pos + 28);
      const extraLen = readU16(bytes, pos + 30);
      const commentLen = readU16(bytes, pos + 32);
      const localOff = readU32(bytes, pos + 42);
      const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
      pos += 46 + nameLen + extraLen + commentLen;
      if (!name || name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
      const localNameLen = readU16(bytes, localOff + 26);
      const localExtraLen = readU16(bytes, localOff + 28);
      const dataStart = localOff + 30 + localNameLen + localExtraLen;
      const compressed = bytes.subarray(dataStart, dataStart + compSize);
      let out;
      if (method === 0) out = compressed.slice();
      else if (method === 8) out = await inflateRaw(compressed);
      else continue;
      entries.push({ name, bytes: out });
    }
    return entries;
  }

  function looksLikeZip(name, bytes) {
    if (bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return true;
    return /\.zip$/i.test(String(name || ''));
  }

  function pickBackupEntry(entries) {
    const jsonLike = (entries || []).filter((entry) => /\.(txt|json)$/i.test(entry.name) && !entry.name.includes('__MACOSX'));
    return jsonLike.find((entry) => isBackupJsonName(entry.name))
      || jsonLike.find((entry) => {
        try {
          const text = new TextDecoder().decode(entry.bytes);
          const data = JSON.parse(text);
          return isDecryptedSn(data) || isHomelab(data);
        } catch (err) {
          return false;
        }
      })
      || null;
  }

  async function openBackupFile(file) {
    const name = file && file.name || '';
    const buffer = file instanceof Uint8Array
      ? file
      : new Uint8Array(await file.arrayBuffer());
    if (looksLikeZip(name, buffer)) {
      const entries = await unzip(buffer);
      const backup = pickBackupEntry(entries);
      const blobs = entries
        .filter((entry) => entry !== backup)
        .map((entry) => ({ name: entry.name, bytes: entry.bytes }));
      if (!backup) return { kind: 'files-only', blobs };
      const text = new TextDecoder().decode(backup.bytes);
      return { kind: 'backup', text, blobs };
    }
    if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser cannot open gzip backups. Use an unzipped .txt file.');
      }
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
      const text = await new Response(stream).text();
      return { kind: 'backup', text, blobs: [] };
    }
    const text = new TextDecoder().decode(buffer);
    return { kind: 'backup', text, blobs: [] };
  }

  function matchLooseFile(pending, name) {
    const base = blobBaseName(name).toLowerCase();
    if (!base) return null;
    return (pending || []).find((item) => blobBaseName(item.name).toLowerCase() === base) || null;
  }

  return {
    parse,
    convertSn,
    mergeTagsByTitle,
    mergePending,
    applyBackupBlobs,
    matchLooseFile,
    unzip,
    openBackupFile,
    isEncryptedSnItem,
    isDecryptedSn,
    isHomelab,
  };
})();
if (typeof window !== 'undefined') window.NotesSnImport = NotesSnImport;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesSnImport;
