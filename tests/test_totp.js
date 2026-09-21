const assert = require('assert');
const NotesTotp = require('../app/static/js/totp.js');

function note(title, content, extra = {}) {
  return {
    uuid: extra.uuid || 'note-2fa',
    deleted: false,
    content: {
      type: 'note',
      title,
      content,
      trashed: !!extra.trashed,
      tags: extra.tags || [],
    },
  };
}

(async () => {
  const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  for (const [unix, expected] of vectors) {
    const totp = await NotesTotp.generate({ secret: rfcSecret, now: unix * 1000, period: 30, digits: 6, algorithm: 'SHA1' });
    assert.equal(totp.code, expected, `TOTP at ${unix}`);
    assert.ok(totp.remaining >= 1 && totp.remaining <= 30);
  }

  assert.ok(NotesTotp.looksLikeSecret('JBSWY3DPEHPK3PXP'));
  assert.ok(!NotesTotp.looksLikeSecret('short'));
  assert.ok(!NotesTotp.looksLikeSecret('not a secret!!'));
  assert.ok(NotesTotp.isTwoFaNote(note('2FA', 'x')));
  assert.ok(NotesTotp.isTwoFaNote(note('2fa codes', 'x')));
  assert.ok(NotesTotp.isTwoFaNote(note('🔐 2FA', 'x')));
  assert.ok(NotesTotp.isTwoFaNote(note('Authenticator', 'x')));
  assert.ok(NotesTotp.isTwoFaNote(note('Codes', 'x'), {
    tags: [{ uuid: 'tag-2fa', content: { title: '2FA' } }],
  }) === false);
  assert.ok(NotesTotp.isTwoFaNote(note('Codes', 'x', { tags: ['tag-2fa'] }), {
    tags: [{ uuid: 'tag-2fa', content: { title: '2FA' } }],
  }));
  assert.ok(!NotesTotp.isTwoFaNote(note('Bank login', 'x')));
  assert.ok(!NotesTotp.isTwoFaNote(note('2FA', 'x', { trashed: true })));

  const otp = NotesTotp.parseOtpauth('otpauth://totp/Amazon:dennis@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Amazon&digits=6&period=30');
  assert.equal(otp.issuer, 'Amazon');
  assert.equal(otp.account, 'dennis@example.com');
  assert.equal(otp.secret, 'JBSWY3DPEHPK3PXP');

  const parsed = NotesTotp.parseText(`# 2FA

Google
JBSWY3DPEHPK3PXP

GitHub: GEZDGNBVGY3TQOJQ

otpauth://totp/Amazon:dennis@example.com?secret=MFRGGZDFMZTWQ2LK&issuer=Amazon

otpauth://totp/Amazon:dennis@example.com?secret=MFRGGZDFMZTWQ2LK&issuer=Amazon
`);
  assert.ok(parsed.some((item) => item.issuer === 'Google' || item.account === 'Google'));
  assert.ok(parsed.some((item) => /github/i.test(`${item.account} ${item.issuer}`)));
  assert.ok(parsed.some((item) => item.issuer === 'Amazon'));
  assert.equal(parsed.filter((item) => item.secret === 'MFRGGZDFMZTWQ2LK').length, 1, 'dedupe otpauth');
  assert.equal(parsed.length, 3);

  const fields = NotesTotp.parseText(`Service: Proton
Account: dennis@example.com
Secret: JBSWY3DPEHPK3PXP`);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].issuer, 'Proton');
  assert.equal(fields[0].account, 'dennis@example.com');

  const vault = NotesTotp.parseNotes([
    note('Shopping', 'JBSWY3DPEHPK3PXP'),
    note('2FA', 'Google\nJBSWY3DPEHPK3PXP'),
  ]);
  assert.equal(vault.notes.length, 1);
  assert.equal(vault.entries.length, 1);
  assert.equal(vault.entries[0].account, 'Google');

  const superDoc = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Google' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'JBSWY3DPEHPK3PXP' }] },
    ],
  });
  const fromSuper = NotesTotp.parseText(superDoc);
  assert.equal(fromSuper.length, 1, 'Super / ProseMirror JSON');
  assert.ok(/google/i.test(`${fromSuper[0].account} ${fromSuper[0].issuer}`));

  const tokenVault = NotesTotp.parseText(JSON.stringify([
    { service: 'Amazon', account: 'dennis@example.com', secret: 'JBSWY3DPEHPK3PXP' },
  ]));
  assert.equal(tokenVault.length, 1, 'TokenVault JSON');
  assert.equal(tokenVault[0].issuer, 'Amazon');
  assert.equal(tokenVault[0].account, 'dennis@example.com');

  const table = NotesTotp.parseText(`| Service | Secret |
| --- | --- |
| GitHub | GEZDGNBVGY3TQOJQ |`);
  assert.equal(table.length, 1, 'markdown table');
  assert.ok(/github/i.test(`${table[0].account} ${table[0].issuer}`));

  const fallback = NotesTotp.parseNotes([
    note('Shopping', 'JBSWY3DPEHPK3PXP'),
    note('Passwords', 'otpauth://totp/Amazon:dennis@example.com?secret=MFRGGZDFMZTWQ2LK&issuer=Amazon'),
  ]);
  assert.equal(fallback.notes.length, 1, 'otpauth note without 2FA title');
  assert.equal(fallback.entries.length, 1);
  assert.equal(fallback.entries[0].issuer, 'Amazon');

  const fromSecret = NotesTotp.entryFromFields({ issuer: 'Amazon', account: 'dennis@example.com', secret: 'JBSWY3DPEHPK3PXP' });
  assert.equal(fromSecret.issuer, 'Amazon');
  assert.equal(fromSecret.account, 'dennis@example.com');
  assert.equal(fromSecret.secret, 'JBSWY3DPEHPK3PXP');
  const fromUrl = NotesTotp.entryFromFields({ secret: 'otpauth://totp/GitHub:dennis?secret=GEZDGNBVGY3TQOJQ&issuer=GitHub' });
  assert.equal(fromUrl.issuer, 'GitHub');
  assert.ok(!NotesTotp.entryFromFields({ secret: 'short' }));

  const migrate = NotesTotp.migrateFromNotes([
    note('2FA', 'Google\nJBSWY3DPEHPK3PXP'),
    note('Passwords', 'otpauth://totp/Amazon:dennis@example.com?secret=MFRGGZDFMZTWQ2LK&issuer=Amazon'),
  ], []);
  assert.equal(migrate.toAdd.length, 2);
  assert.ok(migrate.toAdd.some((entry) => /google/i.test(entry.account) || /google/i.test(entry.issuer)));
  assert.ok(migrate.toAdd.some((entry) => /amazon/i.test(entry.issuer)));
  assert.deepEqual(migrate.noteIds, ['note-2fa']);

  const already = NotesTotp.migrateFromNotes([
    note('2FA', 'Google\nJBSWY3DPEHPK3PXP'),
  ], [{ secret: 'JBSWY3DPEHPK3PXP' }]);
  assert.equal(already.toAdd.length, 0);
  assert.deepEqual(already.noteIds, ['note-2fa']);

  const keepUnread = NotesTotp.migrateFromNotes([
    note('2FA', 'please rotate these passwords soon!'),
  ], []);
  assert.equal(keepUnread.toAdd.length, 0);
  assert.equal(keepUnread.noteIds.length, 0);

  const keepNamed = NotesTotp.migrateFromNotes([
    note('Authenticator', 'Google\nJBSWY3DPEHPK3PXP', { uuid: 'note-auth' }),
  ], []);
  assert.equal(keepNamed.toAdd.length, 1);
  assert.equal(keepNamed.noteIds.length, 0);

  const duped = NotesTotp.planDedupe([
    { id: 'a', secret: 'JBSWY3DPEHPK3PXP', issuer: '', account: 'Google', created_at: '2026-01-02' },
    { id: 'b', secret: 'JBSWY3DPEHPK3PXP', issuer: 'Google', account: 'dennis@example.com', created_at: '2026-01-01' },
    { id: 'c', secret: 'GEZDGNBVGY3TQOJQ', issuer: 'GitHub', account: 'dennis', created_at: '2026-01-01' },
    { id: 'd', secret: 'gez dgnb vgy3 tqojq', issuer: 'GitHub', account: 'dennis', created_at: '2026-01-03' },
  ]);
  assert.deepEqual(duped.removeIds.sort(), ['a', 'd']);
  assert.equal(duped.keep.length, 2);
  assert.ok(duped.keep.some((entry) => entry.id === 'b'));
  assert.ok(duped.keep.some((entry) => entry.id === 'c'));

  console.log('ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
