/*
 * Readable (unencrypted) ZIP export of all notes, their attachments and the agenda.
 * Layout, naming and front-matter: docs/IMPORT_EXPORT_SPEC.md section 2.
 * Pure function over data the caller already holds in memory: it makes no
 * network request and writes nothing to disk. The caller owns the download.
 *
 * NotesReadableExport.build({ notes, tags, getAttachment, getAttachmentBytes,
 *   onProgress, now, appBuild }) -> Promise<null | { bytes, filename, counts, notExported }>
 *   notes: vault items {uuid, content}; tags: tag items; getAttachment(uuid) -> item;
 *   getAttachmentBytes(uuid) -> Promise<Uint8Array>. include2fa (default false) + totpAccounts
 *   (vault items) add 2fa/otpauth.txt; without include2fa no secret is read or written.
 *   agendaEvents: decrypted agenda events (NotesStore.listAgendaEvents()) -> agenda/agenda.ics,
 *   built with NotesAgendaIcs; throws when that module is missing. Returns null when no note
 *   and no agenda event qualifies.
 */
const NotesReadableExport = (() => {
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  const WARNING = [
    'WARNING: THIS ARCHIVE IS NOT ENCRYPTED.',
    'Everything in it is readable by anyone who has this file: notes, attachments,',
    'your calendar and, if present, the 2fa/ folder with authenticator secrets.',
    'Store it somewhere private and delete it when you no longer need it.',
    'The encrypted .dgbackup file from Settings is the safe way to keep a backup.',
  ];

  function cutCodePoints(text, maxPoints, maxBytes) {
    const encoder = new TextEncoder();
    let out = '';
    let points = 0;
    let bytes = 0;
    for (const ch of text) {
      const size = encoder.encode(ch).length;
      if (points + 1 > maxPoints || bytes + size > maxBytes) break;
      out += ch;
      points += 1;
      bytes += size;
    }
    return out;
  }

  /** Spec 2.6 steps 1 to 6. `attachment` keeps the extension and cuts the base. */
  function safeName(raw, { attachment = false, reserve = 0 } = {}) {
    let name = String(raw ?? '').normalize('NFC');
    name = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_');
    name = name.replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '');
    if (RESERVED.test(name)) name = `_${name}`;
    let ext = '';
    if (attachment) {
      const dot = name.lastIndexOf('.');
      if (dot > 0 && name.length - dot <= 16) { ext = name.slice(dot); name = name.slice(0, dot); }
    }
    const extPoints = [...ext].length;
    const extBytes = new TextEncoder().encode(ext).length;
    name = cutCodePoints(name, 80 - extPoints - reserve, 200 - extBytes - reserve).replace(/[ .]+$/g, '');
    if (!name) name = attachment ? 'unnamed' : 'Untitled';
    return name + ext;
  }

  function yamlString(value) {
    const text = String(value ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r?\n|\r/g, '\\n')
      .replace(/[\u0000-\u001f\u007f]/g, '');
    return `"${text}"`;
  }

  const yamlList = (items) => `[${items.map(yamlString).join(', ')}]`;

  function linkPath(path) {
    return path.split('/').map((seg) => encodeURIComponent(seg).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  }

  /** Standard otpauth URI (Key URI Format) for one 2FA vault item; null without a usable secret. */
  function otpauthUri(content) {
    const secret = String(content?.secret || '').replace(/[\s-]/g, '').replace(/=+$/g, '').toUpperCase();
    if (!secret) return null;
    const issuer = String(content.issuer || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    const account = String(content.account || content.label || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || issuer || 'Account';
    const algorithm = ['SHA1', 'SHA256', 'SHA512'].includes(String(content.algorithm || '').toUpperCase())
      ? String(content.algorithm).toUpperCase() : 'SHA1';
    const digits = [6, 7, 8].includes(Number(content.digits)) ? Number(content.digits) : 6;
    const period = Number(content.period) > 0 ? Math.floor(Number(content.period)) : 30;
    const label = issuer ? `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` : encodeURIComponent(account);
    const query = [`secret=${secret}`];
    if (issuer) query.push(`issuer=${encodeURIComponent(issuer)}`);
    query.push(`algorithm=${algorithm}`, `digits=${digits}`, `period=${period}`);
    return `otpauth://totp/${label}?${query.join('&')}`;
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const utcDate = (d) => d.toISOString().slice(0, 10);

  async function build({
    notes, tags = [], getAttachment, getAttachmentBytes, onProgress, now = new Date(), appBuild = '',
    include2fa = false, totpAccounts = [], agendaEvents = [],
  }) {
    const encoder = new TextEncoder();
    const tagTitles = new Map(tags.map((t) => [t.uuid, t.content?.title || '']));
    const eligible = [];
    let locked = 0;
    let trashed = 0;
    for (const note of notes) {
      if (note.content?.trashed) trashed += 1;
      else if (note.content?.locked) locked += 1;
      else eligible.push(note);
    }
    const events = (agendaEvents || []).filter((ev) => ev && ev.start && ev.end);
    if (!eligible.length && !events.length) return null;
    eligible.sort((a, b) => String(a.content.created_at || '').localeCompare(String(b.content.created_at || ''))
      || String(a.uuid).localeCompare(String(b.uuid)));

    // Attachment ids: 8 hex characters, or the full uuid for every member of a clash.
    const attachmentUuids = [];
    for (const note of eligible) {
      for (const id of note.content.attachments || []) if (!attachmentUuids.includes(id)) attachmentUuids.push(id);
    }
    const prefixCount = new Map();
    for (const id of attachmentUuids) {
      const p = String(id).slice(0, 8).toLowerCase();
      prefixCount.set(p, (prefixCount.get(p) || 0) + 1);
    }
    const attachmentPath = new Map();
    const usedPaths = new Set();
    const unreadable = [];
    const entries = [];
    let attachmentCount = 0;
    const total = eligible.length + attachmentUuids.length;
    let done = 0;
    const report = async (status) => {
      if (onProgress) onProgress({ done, total, status });
      if (done % 10 === 0) await tick();
    };

    for (const id of attachmentUuids) {
      const item = getAttachment(id);
      done += 1;
      if (!item || item.content?.type !== 'attachment') { unreadable.push(String(id)); await report('Attachments'); continue; }
      let bytes = null;
      try { bytes = await getAttachmentBytes(id); } catch (err) { bytes = null; }
      if (!bytes) { unreadable.push(item.content.filename || String(id)); await report('Attachments'); continue; }
      const short = String(id).slice(0, 8).toLowerCase();
      const prefix = prefixCount.get(short) > 1 ? String(id) : short;
      const base = safeName(item.content.filename, { attachment: true, reserve: prefix.length + 1 });
      let path = `attachments/${prefix}-${base}`;
      for (let n = 2; usedPaths.has(path.toLowerCase()); n += 1) path = `attachments/${prefix}-${base} (${n})`;
      usedPaths.add(path.toLowerCase());
      attachmentPath.set(id, { path, mime: item.content.mime || '', label: item.content.filename || base });
      entries.push({ name: path, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) });
      attachmentCount += 1;
      await report('Attachments');
    }

    const usedNotes = new Set();
    for (const note of eligible) {
      const c = note.content;
      let path = `notes/${safeName(c.title)}.md`;
      for (let n = 2; usedNotes.has(path.toLowerCase()); n += 1) {
        const suffix = ` (${n})`;
        path = `notes/${safeName(c.title, { reserve: suffix.length })}${suffix}.md`;
      }
      usedNotes.add(path.toLowerCase());
      const linked = (c.attachments || []).map((id) => attachmentPath.get(id)).filter(Boolean);
      const front = [
        '---',
        `title: ${yamlString(c.title || '')}`,
        `created: ${c.created_at || ''}`,
        `modified: ${c.updated_at || ''}`,
        `tags: ${yamlList((c.tags || []).map((id) => tagTitles.get(id)).filter(Boolean))}`,
      ];
      if (linked.length) front.push(`attachments: ${yamlList(linked.map((a) => a.path.slice('attachments/'.length)))}`);
      front.push('---', '');
      let body = String(c.content || '');
      if (linked.length) {
        const lines = linked.map((a) => `${/^image\//i.test(a.mime) ? '!' : ''}[${a.label.replace(/[[\]]/g, '')}](../${linkPath(a.path)})`);
        body += `${body ? '\n\n' : ''}Attachments:\n\n${lines.map((l) => `- ${l}`).join('\n')}`;
      }
      entries.push({ name: path, bytes: encoder.encode(`${front.join('\n')}\n${body}\n`) });
      done += 1;
      await report('Notes');
    }

    const counts = { notes: eligible.length, attachments: attachmentCount };
    if (events.length) {
      const Ics = agendaIcsLib();
      const icsText = Ics.buildIcsCalendarFromEvents(Ics.flattenEventsForIcsExport(events));
      entries.push({ name: 'agenda/agenda.ics', bytes: encoder.encode(icsText) });
      counts.events = events.length;
    }
    const notExported = [];
    if (locked) notExported.push(`${locked} locked note(s)`);
    if (trashed) notExported.push(`${trashed} trashed note(s)`);
    for (const name of unreadable) notExported.push(`unreadable attachment: ${String(name).replace(/[\u0000-\u001f]/g, ' ')}`);
    let uris = [];
    if (include2fa) {
      uris = totpAccounts.filter((a) => !a.deleted && a.content?.type === 'totp').map((a) => otpauthUri(a.content)).filter(Boolean);
      if (uris.length) entries.push({ name: '2fa/otpauth.txt', bytes: encoder.encode(`${uris.join('\n')}\n`) });
    }
    notExported.push(include2fa ? 'folders' : 'folders and 2FA accounts');
    if (events.length) notExported.push('agenda reminders and agenda tasks');
    const readme = [
      ...WARNING,
      '',
      `Exported: ${now.toISOString()}`,
      ...(appBuild ? [`App build: ${appBuild}`] : []),
      `Notes: ${counts.notes}`,
      `Attachments: ${counts.attachments}`,
      ...(events.length ? [`Agenda events: ${events.length}`] : []),
      ...(include2fa ? [`2FA accounts: ${uris.length}`] : []),
      include2fa && uris.length ? '2fa/ included: yes, it contains live authenticator secrets.' : '2fa/ included: no.',
      '',
      'Not exported:',
      ...notExported.map((line) => `- ${line}`),
      '',
    ].join('\n');
    entries.unshift({ name: 'README.txt', bytes: encoder.encode(readme) });

    if (onProgress) onProgress({ done: total, total, status: 'Zipping' });
    await tick();
    const bytes = await zipLib().writeZip(entries);
    return { bytes, filename: `deeperguard-export-${utcDate(now)}.zip`, counts, notExported };
  }

  function agendaIcsLib() {
    let Ics = typeof NotesAgendaIcs !== 'undefined' ? NotesAgendaIcs : null;
    if (!Ics && typeof module !== 'undefined' && module.exports) {
      require('./agenda-ics.js');
      Ics = globalThis.NotesAgendaIcs;
    }
    if (!Ics || typeof Ics.buildIcsCalendarFromEvents !== 'function' || typeof Ics.flattenEventsForIcsExport !== 'function') {
      throw new Error('Agenda export unavailable: the calendar module is not loaded. Nothing was saved.');
    }
    return Ics;
  }

  function zipLib() {
    if (typeof NotesZip !== 'undefined') return NotesZip;
    return require('./ziplib.js');
  }

  return { build, safeName, otpauthUri };
})();
if (typeof window !== 'undefined') window.NotesReadableExport = NotesReadableExport;
if (typeof module !== 'undefined' && module.exports) module.exports = NotesReadableExport;
