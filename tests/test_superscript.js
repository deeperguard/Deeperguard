const assert = require('assert');
const {
  render,
  convertTo,
  convertFrom,
  normalizeContent,
  linkifyPlain,
  toggleTaskAt,
} = require('../app/static/js/superscript.js');

const booking = 'https://www.booking.com/hotel/nl/jansen-bajeskwartier.html?label=genius'
  + '&aid=123&checkin=2026-01-01&checkout=2026-01-02';

assert.match(normalizeContent(`(${booking})`), /<https:\/\/www\.booking\.com/);
assert.match(normalizeContent(`(${booking})`), />$/m);

const wrapped = `7_0_2_0&atlas_src=sr_iw_title)](${booking}))]`;
const repaired = normalizeContent(wrapped);
assert.match(repaired, /<https:\/\/www\.booking\.com/);
assert.doesNotMatch(repaired, /atlas_src=sr_iw_title\]/);

const plainBlock = `( ${booking} )`;
const linked = linkifyPlain(plainBlock.trim());
assert.match(linked, /<https:\/\/www\.booking\.com/);

const html = render(`${booking}\n\n(${booking})`);
const linkCount = (html.match(/<a href="https:\/\/www\.booking\.com/g) || []).length;
assert.ok(linkCount >= 2, `expected 2 booking links, got ${linkCount}`);

const converted = convertTo('Visit https://example.com/docs\n- [x] Done\n- [ ] Todo', 'checklist');
assert.match(converted, /<https:\/\/example\.com\/docs>/);
assert.match(converted, /☑ Done/);

const fromPlain = convertTo(`(${booking})`, 'plain');
assert.match(fromPlain, /<https:\/\/www\.booking\.com/);

const stripped = convertFrom(`<${booking}>`);
assert.strictEqual(stripped, booking);

const roundTrip = convertTo(stripped, 'plain');
assert.match(roundTrip, /<https:\/\/www\.booking\.com/);

const mixed = normalizeContent('[Docs](https://example.com) or https://open.example.org');
assert.match(mixed, /<https:\/\/open\.example\.org>/);
assert.match(mixed, /\[Docs\]\(https:\/\/example\.com\)/);

const urlThenMarkdown = normalizeContent('See https://a.example and [Guide](https://guide.example)');
assert.match(urlThenMarkdown, /<https:\/\/a\.example>/);
assert.match(urlThenMarkdown, /\[Guide\]\(https:\/\/guide\.example\)/);
assert.doesNotMatch(urlThenMarkdown, /\[Guide\]\(<https:/);

const fromUnquotedHtml = convertTo('See <a href=https://cursor.com/agents>Cursor web</a>', 'plain');
assert.match(fromUnquotedHtml, /\[Cursor web\]\(https:\/\/cursor\.com\/agents\)/);

const fromMarkdownLink = convertTo('[Cursor](https://cursor.com/agents)', 'markdown');
assert.match(fromMarkdownLink, /\[Cursor\]\(https:\/\/cursor\.com\/agents\)/);

const fromHtmlLink = convertTo('See <a href="https://cursor.com/agents">Cursor web</a> now', 'plain');
assert.match(fromHtmlLink, /\[Cursor web\]\(https:\/\/cursor\.com\/agents\)/);
assert.match(render(fromHtmlLink), /<a href="https:\/\/cursor\.com\/agents"/);

const superDoc = JSON.stringify({
  type: 'doc',
  content: [{
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Open ' },
      {
        type: 'text',
        text: 'Cursor',
        marks: [{ type: 'link', attrs: { href: 'https://cursor.com/agents' } }],
      },
    ],
  }],
});
const fromSuper = convertTo(superDoc, 'markdown');
assert.match(fromSuper, /\[Cursor\]\(https:\/\/cursor\.com\/agents\)/);
assert.match(render(fromSuper), /<a href="https:\/\/cursor\.com\/agents"/);

const superHtml = render('E=mc^2^ and [Docs](https://example.com/path(withparen))');
assert.match(superHtml, /<sup>2<\/sup>/);
assert.match(superHtml, /<a href="https:\/\/example\.com\/path\(withparen\)"/);

assert.strictEqual(toggleTaskAt('- [ ] one\n- [x] two', 0), '- [x] one\n- [x] two');

const ampersandUrl = 'https://www.booking.com/hotel/nl/test.html?foo=1&bar=2';
const ampHtml = render(ampersandUrl);
assert.match(ampHtml, /href="https:\/\/www\.booking\.com\/hotel\/nl\/test\.html\?foo=1&amp;bar=2"/);

const angleGoogle = render('<https://Www.google.com>');
assert.match(angleGoogle, /<a href="https:\/\/Www\.google\.com"/);
assert.doesNotMatch(angleGoogle, /&lt;&lt;/);

const repairedDouble = normalizeContent('<<https://Www.google.com>>');
assert.strictEqual(repairedDouble, '<https://Www.google.com>');

console.log('ok');
