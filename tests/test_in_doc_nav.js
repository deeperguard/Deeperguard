const assert = require('assert');
globalThis.NotesInDocNav = require('../app/static/js/in-doc-nav.js');
globalThis.NotesSuperscript = require('../app/static/js/superscript.js');

const body = [
  '## Sound Basis for Trade',
  '',
  'See [Sound Basis for Trade](sound-basis-for-trade) for more.',
  'Chapter 7: Sound Money and Individual Freedom',
].join('\n');

const html = NotesSuperscript.render(body);
assert.match(html, /id="sound-basis-for-trade"/);
assert.match(html, /href="#sound-basis-for-trade"/);

const target = NotesInDocNav.resolveHeadingTarget(body, 'sound-basis-for-trade');
assert.strictEqual(target.line, 0);

const chapter = NotesInDocNav.resolveHeadingTarget(body, 'Chapter 7: Sound Money and Individual Freedom');
assert.ok(chapter.line >= 0);

console.log('ok');
