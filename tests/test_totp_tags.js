// 2FA search and tags (docs/2FA_IMPORT_SPEC.md sections 2, 2.2, 3.2, 3.3 and 7):
// filter logic, lazy schema 1 -> 2 migration, tags surviving an encrypted sync round trip,
// Aegis / 2FAS groups imported as tags, and the add/edit dialog not leaking tags between uses.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const h = require('./sync_harness');
const T = require('../app/static/js/totp.js');
global.NotesTotp = T;
const Imp = require('../app/static/js/totp-import.js');

const { NotesStore } = h;
const S1 = 'JBSWY3DPEHPK3PXP';
const S2 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const S3 = 'MFRGGZDFMZTWQ2LK';

(async () => {
  // --- normalizeTags ---
  assert.deepStrictEqual(T.normalizeTags(' Work, #home ,work,, Ünïcode '), ['Work', 'home', 'Ünïcode']);
  assert.deepStrictEqual(T.normalizeTags(['a\u0000b', 'x'.repeat(60)]), ['ab', 'x'.repeat(40)]);
  assert.strictEqual(T.normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 20);
  assert.deepStrictEqual(T.normalizeTags([null, {}, 7]), ['7']);

  // --- filter logic ---
  const entries = [
    { id: '1', issuer: 'GitHub', account: 'ann@example.test', host: 'github.com', tags: ['Work', 'Dev'] },
    { id: '2', issuer: 'Société Générale', account: 'ann', host: '', tags: ['Bank'] },
    { id: '3', issuer: 'Gitea', account: 'bob', host: '', tags: [], note: 'self hosted' },
  ];
  const ids = (list) => list.map((e) => e.id);
  assert.deepStrictEqual(ids(T.filterAccounts(entries, '')), ['1', '2', '3']);
  assert.deepStrictEqual(ids(T.filterAccounts(entries, 'git')), ['1', '3'], 'issuer substring');
  assert.deepStrictEqual(ids(T.filterAccounts(entries, 'GIT ann')), ['1'], 'terms are AND-ed, case-insensitive');
  assert.deepStrictEqual(ids(T.filterAccounts(entries, 'societe generale')), ['2'], 'accent-insensitive');
  assert.deepStrictEqual(ids(T.filterAccounts(entries, 'dev')), ['1'], 'free text matches tags');
  assert.deepStrictEqual(ids(T.filterAccounts(entries, 'hosted')), ['3'], 'free text matches note');
  assert.deepStrictEqual(ids(T.filterAccounts(entries, 'tag:work')), ['1']);
  assert.deepStrictEqual(ids(T.filterAccounts(entries, '#bank')), ['2']);
  assert.deepStrictEqual(ids(T.filterAccounts(entries, '#ban')), [], 'tag filter is exact');
  assert.deepStrictEqual(ids(T.filterAccounts(entries, '', 'work')), ['1'], 'active chip');
  assert.deepStrictEqual(ids(T.filterAccounts(entries, 'gitea', 'Work')), [], 'chip and text combine');
  assert.deepStrictEqual(T.tagCounts([...entries, { tags: ['work'] }]), [
    { name: 'Bank', count: 1 }, { name: 'Dev', count: 1 }, { name: 'Work', count: 2 },
  ]);
  assert.deepStrictEqual(T.renameTagIn(['Work', 'Dev'], 'work', 'Job'), ['Job', 'Dev']);
  assert.deepStrictEqual(T.renameTagIn(['Work', 'Dev'], 'Work', 'dev'), ['dev'], 'merge on rename');
  assert.deepStrictEqual(T.renameTagIn(['Work'], 'Work', ''), [], 'delete');
  assert.strictEqual(T.renameTagIn(['Dev'], 'Work', 'X'), null, 'unchanged');

  // --- migration: schema 1 is read lazily and upgraded losslessly on first write ---
  const v1 = { type: 'totp', issuer: 'Acme', account: 'ann', secret: S1, digits: 6, period: 30, algorithm: 'SHA1', host: '', created_at: 'c', updated_at: 'u', future_field: { keep: true } };
  const view = T.accountFields(v1);
  assert.deepStrictEqual([view.schema, view.label, view.tags, view.otp_type, view.icon_id], [1, 'ann', [], 'totp', null]);
  const up = T.upgradeContent(v1, { tags: ['Work'] });
  for (const k of Object.keys(v1)) assert.deepStrictEqual(up[k], v1[k], `field ${k} kept`);
  assert.deepStrictEqual([up.schema, up.label, up.account, up.tags], [2, 'ann', 'ann', ['Work']]);

  await h.unlockFresh();
  h.resetServer();
  const oldId = NotesStore.newUuid();
  NotesStore.upsert(oldId, { ...v1 });
  const before = JSON.parse(JSON.stringify(NotesStore.get(oldId).content));
  NotesStore.listTotpAccounts();
  assert.deepStrictEqual(NotesStore.get(oldId).content, before, 'reading does not rewrite');
  assert.strictEqual(NotesStore.updateTotpAccount(oldId, { issuer: 'Acme', account: 'ann', tags: ['Work', 'work', 'Home'] }), true);
  const migrated = NotesStore.get(oldId).content;
  for (const k of Object.keys(v1).filter((k) => k !== 'updated_at')) assert.deepStrictEqual(migrated[k], v1[k], `store kept ${k}`);
  assert.deepStrictEqual([migrated.schema, migrated.label, migrated.tags], [2, 'ann', ['Work', 'Home']]);
  // Editing without a tags argument (older code path) keeps the tags.
  NotesStore.updateTotpAccount(oldId, { issuer: 'Acme Inc', account: 'ann' });
  assert.deepStrictEqual(NotesStore.get(oldId).content.tags, ['Work', 'Home']);

  const added = NotesStore.addTotpAccount({ issuer: 'B', account: 'b', secret: S2, tags: 'Bank, #Home' });
  assert.ok(added.created);
  assert.deepStrictEqual(NotesStore.get(added.uuid).content.tags, ['Bank', 'Home']);
  assert.strictEqual(NotesStore.get(added.uuid).content.schema, 2);

  // Rename / delete touches every account carrying the tag.
  assert.strictEqual(NotesStore.renameTotpTag('home', 'Family'), 2);
  assert.deepStrictEqual(NotesStore.get(oldId).content.tags, ['Work', 'Family']);
  assert.deepStrictEqual(NotesStore.get(added.uuid).content.tags, ['Bank', 'Family']);
  assert.strictEqual(NotesStore.renameTotpTag('Bank', ''), 1);
  assert.deepStrictEqual(NotesStore.get(added.uuid).content.tags, ['Family']);

  // --- tags stay encrypted on the wire and survive a sync round trip ---
  const bodies = [];
  const pushed = [];
  h.server.pushResponder = (items, body) => {
    bodies.push(JSON.stringify(body));
    pushed.push(...items);
    return items.map((r) => ({ item_uuid: r.item_uuid, status: 'ok', rev: 1 }));
  };
  h.stopPushTimer();
  await NotesStore.pushDirty({ quiet: true });
  const wire = bodies.join('\n');
  assert.ok(wire.includes('ciphertext'));
  for (const secret of ['Family', 'Work', 'Acme', 'schema', 'tags']) assert.ok(!wire.includes(secret), `plaintext leak: ${secret}`);
  const row = pushed.find((r) => r.item_uuid === oldId);
  assert.ok(row, 'migrated account was pushed');
  assert.deepStrictEqual((await h.decryptRow(row)).tags, ['Work', 'Family'], 'tags inside the ciphertext');

  // Another device pulls the encrypted row: tags come back intact.
  const remoteId = NotesStore.newUuid();
  const remoteRow = await h.encryptedRow(remoteId, { ...up, secret: S3, issuer: 'Remote', updated_at: '2026-11-01T00:00:00.000Z' }, '2026-11-01T00:00:00.000Z', 6000);
  h.server.pullPages = [{ items: [remoteRow], has_more: false, total_undeleted: 3, cursor: 6000 }];
  await NotesStore.sync({ quiet: true });
  const pulled = NotesStore.listTotpAccounts().find((i) => i.uuid === remoteId);
  assert.ok(pulled, 'remote account arrived');
  assert.deepStrictEqual(pulled.content.tags, ['Work']);

  // --- import: Aegis and 2FAS groups become tags ---
  const aegis3 = JSON.stringify({
    version: 1,
    header: { slots: null, params: null },
    db: {
      version: 3,
      groups: [{ uuid: 'g-1', name: 'Work' }, { uuid: 'g-2', name: 'Cloud' }],
      entries: [
        { type: 'totp', name: 'ann', issuer: 'GitHub', favorite: true, groups: ['g-1', 'g-2', 'missing'], info: { secret: S1, algo: 'SHA1', digits: 6, period: 30 } },
        { type: 'totp', name: 'bob', issuer: 'Plain', groups: [], info: { secret: S2 } },
      ],
    },
  });
  const a3 = Imp.parse(aegis3);
  assert.ok(a3.ok);
  assert.deepStrictEqual(a3.entries[0].tags, ['Favourite', 'Work', 'Cloud']);
  assert.strictEqual(a3.entries[1].tags, undefined);
  const aegis2 = JSON.stringify({
    version: 1, header: { slots: null, params: null },
    db: { version: 2, entries: [{ type: 'totp', name: 'c', issuer: 'X', group: 'Personal', info: { secret: S3 } }] },
  });
  assert.deepStrictEqual(Imp.parse(aegis2).entries[0].tags, ['Personal']);
  const twofas = JSON.stringify({
    schemaVersion: 4,
    groups: [{ id: 'grp-a', name: 'Finance' }],
    services: [
      { name: 'Bank', secret: S1, groupId: 'grp-a', otp: { tokenType: 'TOTP', account: 'me' } },
      { name: 'Other', secret: S2, otp: { tokenType: 'TOTP' } },
    ],
  });
  const tf = Imp.parse(twofas);
  assert.ok(tf.ok);
  assert.deepStrictEqual(tf.entries[0].tags, ['Finance']);
  assert.strictEqual(tf.entries[1].tags, undefined);
  assert.deepStrictEqual(Imp.previewRows(Imp.plan(tf.entries, []))[0].tags, ['Finance']);
  // Saving an imported entry keeps its tags.
  const imported = NotesStore.addTotpAccount({ ...a3.entries[0], secret: 'KRSXG5CTMVRXEZLU' });
  assert.ok(imported.created);
  assert.deepStrictEqual(NotesStore.get(imported.uuid).content.tags, ['Favourite', 'Work', 'Cloud']);

  // --- entryFromFields carries tags (manual add and QR) ---
  assert.deepStrictEqual(T.entryFromFields({ secret: S1, tags: 'a, b' }).tags, ['a', 'b']);
  assert.deepStrictEqual(T.entryFromFields({ secret: `otpauth://totp/X:y?secret=${S1}`, tags: ['q'] }).tags, ['q']);

  // --- UI wiring: the tags field is reset on close and on "Add account" (no tags leak from an edit) ---
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'app/static/js/app.js'), 'utf8');
  const fnBody = (name) => {
    const start = appJs.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} exists`);
    return appJs.slice(start, appJs.indexOf('\n  }\n', start));
  };
  assert.ok(/resetTotpDialogTags\(\)/.test(fnBody('hideTotpAddDialog')), 'close clears tags');
  assert.ok(/resetTotpDialogTags\(\)/.test(fnBody('showTotpAddDialog')), 'add starts with empty tags');
  assert.ok(/resetTotpDialogTags\(\(item\.tags/.test(fnBody('showTotpEditDialog')), 'edit fills tags');
  assert.ok(/tags: readTotpDialogTags\(\)/.test(fnBody('applyTotpQrPayload')), 'QR keeps typed tags');
  assert.ok(/NotesTotp\.filterAccounts/.test(fnBody('filteredTotpEntries')), 'list uses the local filter');
  const html = fs.readFileSync(path.join(__dirname, '..', 'app/templates/app.html'), 'utf8');
  assert.ok(html.includes('id="totp-add-tags"') && html.includes('id="totp-tag-chips"'));

  console.log('test_totp_tags.js: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
