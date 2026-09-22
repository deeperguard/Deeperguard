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

console.log('ok');
