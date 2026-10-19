const assert = require('assert');
globalThis.NotesSuperscript = require('../app/static/js/superscript.js');
const NotesLinkOverlay = require('../app/static/js/link-overlay.js');

const html = NotesLinkOverlay.renderHtml('See [Docs](https://example.com) and https://open.example.org');
assert.match(html, /<a class="edit-link" href="https:\/\/example\.com"/);
assert.match(html, /<a class="edit-link" href="https:\/\/open\.example\.org"/);
assert.match(html, /\[Docs\]\(https:\/\/example\.com\)/);
const bare = NotesLinkOverlay.renderHtml('https://cursor.com/agents');
assert.match(bare, /<a class="edit-link" href="https:\/\/cursor\.com\/agents"[^>]*>https:\/\/cursor\.com\/agents<\/a>/);
const http = NotesLinkOverlay.renderHtml('http://192.168.178.152');
assert.match(http, />http:\/\/192\.168\.178\.152<\/a>/);

const unsafe = NotesLinkOverlay.renderHtml('[bad](javascript:alert(1))');
assert.doesNotMatch(unsafe, /<a[\s>]/i);
assert.doesNotMatch(unsafe, /href=/i);
assert.doesNotMatch(unsafe, /edit-link/);
assert.doesNotMatch(unsafe, /#javascript/);
assert.match(unsafe, /\[bad\]\(javascript:alert\(1\)\)/);

const dataUrl = NotesLinkOverlay.renderHtml('[x](data:text/html,hi)');
assert.doesNotMatch(dataUrl, /<a[\s>]/i);

const inDoc = NotesLinkOverlay.renderHtml('[Go](#intro) and [Heading](Introduction)');
assert.match(inDoc, /<a class="edit-link in-doc-link" href="#intro">/);
assert.match(inDoc, /<a class="edit-link in-doc-link" href="#introduction">/);

const mail = NotesLinkOverlay.renderHtml('[Mail](mailto:a@example.com)');
assert.match(mail, /<a class="edit-link" href="mailto:a@example.com"/);

console.log('ok');
