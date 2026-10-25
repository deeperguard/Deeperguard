/**
 * Round 72.2: RELEASE_TAG must track the signed release About compares against.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const tag = fs.readFileSync(path.join(root, 'RELEASE_TAG'), 'utf8').trim();
const deploy = fs.readFileSync(path.join(root, 'deploy/deploy-deeperguard.sh'), 'utf8');
// Canonical copy until workflow-scoped push can sync .github/workflows.
const workflow = fs.readFileSync(
  path.join(root, 'deploy/github-workflows/release-client.yml'),
  'utf8',
);

assert.ok(/^v0\.\d+\.\d+/.test(tag), `RELEASE_TAG=${tag}`);
assert.strictEqual(tag, 'v0.65.12', 'repo RELEASE_TAG must be current live release');

assert.ok(deploy.includes('NOTES_RELEASE_TAG'), 'deploy requires/writes release tag');
assert.ok(deploy.includes('check-release-tag.sh'), 'deploy runs check-release-tag');
assert.ok(deploy.includes('printf \'%s\\n\' "${release_tag}" > RELEASE_TAG')
  || deploy.includes('printf \'%s\\n\' "${release_tag}" > "${SRC}/RELEASE_TAG"')
  || deploy.includes('> RELEASE_TAG'), 'deploy writes RELEASE_TAG on host');
assert.ok(deploy.includes('manifest_sha256'), 'deploy can verify release hash');

assert.ok(workflow.includes('RELEASE_TAG must match git tag'));
assert.ok(workflow.includes('check-release-tag.sh'));
assert.ok(workflow.includes('GITHUB_REF_NAME'));

const ok = spawnSync('bash', ['scripts/check-release-tag.sh', '--expect', tag], {
  cwd: root,
  encoding: 'utf8',
});
assert.strictEqual(ok.status, 0, ok.stderr || ok.stdout);

const bad = spawnSync('bash', ['scripts/check-release-tag.sh', '--expect', 'v0.0.0'], {
  cwd: root,
  encoding: 'utf8',
});
assert.notStrictEqual(bad.status, 0, 'mismatch must fail closed');
assert.ok(/expected 'v0\.0\.0'/.test(bad.stderr || ''), bad.stderr);

console.log('test_round72_2_release_tag ok', tag);
