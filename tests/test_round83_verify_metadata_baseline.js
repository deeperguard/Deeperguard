/**
 * Round 83: /verify metadata baseline (per-action server traffic table).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const verify = fs.readFileSync(path.join(root, 'app/templates/verify.html'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/static/css/marketing.css'), 'utf8');
const baselinePath = path.join(root, 'app/verify-metadata-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');

execFileSync('python3', [
  path.join(root, 'scripts/regenerate-verify-metadata-baseline.py'),
  '--check',
], { cwd: root, stdio: 'pipe' });

assert.ok(fs.existsSync(path.join(root, 'scripts/regenerate-verify-metadata-baseline.py')));
assert.ok(fs.existsSync(path.join(root, 'app/verify_metadata_baseline.py')));

assert.strictEqual(baseline.schema_version, 1);
assert.ok(Array.isArray(baseline.actions));
const ids = baseline.actions.map((a) => a.id);
assert.deepStrictEqual(ids, [
  'unlock',
  'open',
  'edit-save',
  'view-server-copy',
  'idle',
  'lock',
]);
for (const row of baseline.actions) {
  assert.ok(row.label);
  assert.ok(['checked', 'unchecked'].includes(row.measurement));
  assert.strictEqual(row.evidence_type, 'static_source_analysis');
  assert.strictEqual(row.note_plaintext_on_wire, false);
  assert.strictEqual(row.password_or_vault_key_on_wire, false);
}
assert.ok(Array.isArray(baseline.uncovered_actions));
assert.ok(baseline.uncovered_actions.length >= 5);
assert.ok(baseline.evidence_legend);
assert.ok(
  baseline.actions.filter((a) => a.measurement !== 'checked').length === 0,
  `unchecked rows: ${baseline.actions.filter((a) => a.measurement !== 'checked').map((a) => a.id).join(', ')}`,
);

assert.ok(verify.includes('id="verify-metadata-baseline"'));
assert.ok(verify.includes('Compare this with your own DevTools'));
assert.ok(verify.includes('mk-verify-metadata-cards'));
assert.ok(verify.includes('mk-verify-metadata-table'));
assert.ok(verify.includes('mk-verify-evidence static'));
assert.ok(verify.includes('Actions not in this table yet'));
assert.ok(verify.includes('Anchors OK'));
assert.ok(verify.includes('mk-verify-sends-none'));
assert.ok(verify.includes('verify_metadata_baseline.actions'));
assert.ok(verify.includes('id="verify-sync-metadata"'));

assert.ok(css.includes('.mk-verify-metadata-cards'));
assert.ok(css.includes('.mk-verify-sends-none'));
assert.ok(css.includes('min-width: 720px'));

assert.ok(appHtml.includes('/verify#verify-metadata-baseline'));
assert.ok(appPy.includes('verify_metadata_baseline'));

console.log('test_round83_verify_metadata_baseline ok');
