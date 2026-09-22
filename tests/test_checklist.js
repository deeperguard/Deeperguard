const assert = require('assert');
const NotesChecklist = require('../app/static/js/checklist.js');

const rows = NotesChecklist.parse('- [ ] Milk\n- [x] Eggs\n  - [ ] Nested', { nested: true });
assert.equal(rows.length, 3);
assert.equal(rows[0].text, 'Milk');
assert.equal(rows[1].done, true);
assert.equal(rows[2].indent, 1);

const back = NotesChecklist.serialize(rows, { nested: true });
assert.match(back, /- \[ \] Milk/);
assert.match(back, /- \[x\] Eggs/);
assert.match(back, /  - \[ \] Nested/);

const toggled = NotesChecklist.toggle(rows, rows[0].id);
assert.equal(toggled[0].done, true);

const added = NotesChecklist.addRow(rows, rows[0].id, { nested: true });
assert.equal(added.length, 4);
assert.equal(added[1].indent, 0);

const addedWithText = NotesChecklist.addRow(rows, rows[0].id, { nested: true, text: 'Bread' });
assert.equal(addedWithText.length, 4);
assert.equal(addedWithText[1].text, 'Bread');

const addedToEnd = NotesChecklist.addRow(rows, null, { nested: true, text: 'Last item' });
assert.equal(addedToEnd.length, 4);
assert.equal(addedToEnd[3].text, 'Last item');

const indented = NotesChecklist.bumpIndent(rows, rows[0].id, 1);
assert.equal(indented[0].indent, 1);

const cleared = NotesChecklist.removeDone(rows);
assert.equal(cleared.length, 2);
assert.equal(cleared[0].text, 'Milk');
assert.equal(cleared[1].text, 'Nested');
assert.equal(cleared.every((row) => !row.done), true);

const allDone = NotesChecklist.parse('- [x] A\n- [x] B');
const emptyAfterClear = NotesChecklist.removeDone(allDone);
assert.equal(emptyAfterClear.length, 1);
assert.equal(emptyAfterClear[0].done, false);
assert.equal(emptyAfterClear[0].text, '');

console.log('ok');
