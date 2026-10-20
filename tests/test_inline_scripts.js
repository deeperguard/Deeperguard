/**
 * Parse every inline <script> in app/marketing templates so a broken ternary
 * (or other syntax error) cannot ship and kill the whole boot block again.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const root = path.join(__dirname, '..');
const templates = [
  'app/templates/app.html',
  'app/templates/marketing.html',
  'app/templates/compare-standard-notes.html',
  'app/templates/login.html',
  'app/templates/register.html',
  'app/templates/legal.html',
].map((rel) => path.join(root, rel)).filter((p) => fs.existsSync(p));

function stripJinja(src) {
  return src
    .replace(/\{#[\s\S]*?#\}/g, '')
    .replace(/\{%[\s\S]*?%\}/g, '\n')
    .replace(/\{\{[\s\S]*?\}\}/g, '""');
}

function extractInlineScripts(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = match[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const body = String(match[2] || '').trim();
    if (!body) continue;
    scripts.push(body);
  }
  return scripts;
}

function assertParses(label, source) {
  // new Function catches SyntaxError the same way the browser does.
  try {
    // eslint-disable-next-line no-new-func
    new Function(source);
  } catch (err) {
    assert.fail(`${label}: ${err.message}`);
  }
  // Also run node --check on a temp file for a second parser.
  const tmp = path.join(os.tmpdir(), `dg-inline-${process.pid}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(tmp, source);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || err);
    assert.fail(`${label} (node --check): ${detail}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

let total = 0;
for (const file of templates) {
  const raw = fs.readFileSync(file, 'utf8');
  const html = stripJinja(raw);
  const scripts = extractInlineScripts(html);
  scripts.forEach((body, i) => {
    total += 1;
    assertParses(`${path.relative(root, file)} inline#${i + 1}`, body);
  });
}

assert.ok(total >= 3, 'expected several inline scripts');

// Explicit regression: the Round 36 health helper must have a complete ternary.
const appHtml = fs.readFileSync(path.join(root, 'app/templates/app.html'), 'utf8');
assert.ok(appHtml.includes('AbortController'));
assert.ok(
  /var timer = ctrl \? setTimeout\([\s\S]*?\) : null;/.test(appHtml),
  'health abort timer ternary must include : null',
);
assert.ok(!/var timer = ctrl \? setTimeout\([\s\S]*?\}, ms\);/.test(appHtml)
  || /var timer = ctrl \? setTimeout\([\s\S]*?\}, ms\) : null;/.test(appHtml));

console.log(`test_inline_scripts ok (${total} scripts)`);
