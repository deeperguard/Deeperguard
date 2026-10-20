const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'app/static/js/app.js'), 'utf8');
const marketingJs = fs.readFileSync(path.join(root, 'app/static/js/marketing.js'), 'utf8');
const markdownJs = fs.readFileSync(path.join(root, 'app/static/js/markdown.js'), 'utf8');
const marketingCss = fs.readFileSync(path.join(root, 'app/static/css/marketing.css'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'app/static/css/app.css'), 'utf8');
const home = fs.readFileSync(path.join(root, 'app/templates/marketing.html'), 'utf8');
const topbar = fs.readFileSync(path.join(root, 'app/templates/partials/mk-topbar.html'), 'utf8');
const compare = fs.readFileSync(path.join(root, 'app/templates/compare-standard-notes.html'), 'utf8');
const appPy = fs.readFileSync(path.join(root, 'app/app.py'), 'utf8');

assert.ok(home.includes('mk-nav-backdrop'));
assert.ok(topbar.includes('mk-nav-backdrop'));
assert.ok(compare.includes('mk-nav-backdrop'));
assert.ok(!home.includes('class="mk-nav-open-app"'));
assert.ok(home.includes('Open notes app</a>'));
assert.ok(home.includes('mk-compare-stack mk-compare-plans'));
assert.ok(compare.includes('mk-compare-stack mk-compare-sn'));
assert.ok(marketingCss.includes('@media (min-width: 768px)'));
assert.ok(marketingCss.includes('.mk-compare-stack'));
assert.ok(marketingCss.includes('prefers-color-scheme: dark'));
assert.ok(marketingCss.includes('flex: 1 1 auto'));

assert.ok(appPy.includes('return redirect("/#pricing", code=302)'));
assert.ok(!/def pricing_page\(\):\n\s+ctx = _marketing_context\(\)/.test(appPy));

assert.ok(appJs.includes('function emptyStateDismissKey'));
assert.ok(appJs.includes('clearEmptyStateDismissed'));
assert.ok(appJs.includes("notes_empty_state_dismissed:${email}"));
assert.ok(appJs.includes('// Escape does not dismiss the welcome empty state'));
assert.ok(!appJs.includes('if (ui.empty && !ui.empty.hidden && !currentId && !vaultSyncError)'));

const createTag = appJs.split('function createTag(')[1].split('function layoutFindBarOverDocViewer')[0];
assert.ok(createTag.includes("toast('Tag already exists')"));

assert.ok(appJs.includes('let totpRenderToken = 0'));
assert.ok(appJs.includes('const token = ++totpRenderToken'));
assert.ok(appJs.includes('if (token !== totpRenderToken) return'));
const removeTotp = appJs.split('async function removeTotpEntry')[1].split('function setTotpAddError')[0];
assert.ok(removeTotp.includes('totpEntries = totpEntries.filter'));
assert.ok(removeTotp.includes('await renderTotpList()'));

assert.ok(marketingJs.includes('closePublicNav'));
assert.ok(marketingJs.includes("event.key !== 'Escape'"));
assert.ok(marketingJs.includes('navToggle.focus'));

assert.ok(appJs.includes("e.key === '/'"));
assert.ok(appJs.includes("e.key.toLowerCase() === 'k'"));
assert.ok(appJs.includes('e.altKey && e.key.toLowerCase() === \'n\''));

assert.ok(markdownJs.includes('function extractTables'));
assert.ok(markdownJs.includes('md-table-wrap'));
assert.ok(markdownJs.includes('@@TABLE'));
assert.ok(appCss.includes('.preview .md-table-wrap'));
assert.ok(appCss.includes('overflow-x: auto'));

const { render } = require('../app/static/js/markdown.js');
const tableHtml = render('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```\n| not | a | table |\n```');
assert.match(tableHtml, /<div class="md-table-wrap"><table>/);
assert.match(tableHtml, /<th>A<\/th>/);
assert.match(tableHtml, /<td>1<\/td>/);
assert.match(tableHtml, /<pre class="code-preview"><code>/);
assert.doesNotMatch(tableHtml, /<pre[^>]*>[\s\S]*<table/);

console.log('test_round29_ui ok');
