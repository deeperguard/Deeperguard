const assert = require('assert');
const { render, toggleTaskAt } = require('../app/static/js/markdown.js');

const html = render('- [ ] Buy milk\n- [x] Done\n\n**bold** and `code`\n\n```\n*not italic*\n```');
assert.match(html, /task-toggle/);
assert.match(html, /data-checked="0"/);
assert.match(html, /data-checked="1"/);
assert.match(html, /<strong>bold<\/strong>/);
assert.match(html, /<pre><code>/);
assert.doesNotMatch(html, /<em>not italic<\/em>/);

const flipped = toggleTaskAt('- [ ] one\n- [x] two', 1);
assert.strictEqual(flipped, '- [ ] one\n- [ ] two');
assert.strictEqual(toggleTaskAt('- [ ] one', 0), '- [x] one');

console.log('ok');
