const NotesChecklist = (() => {
  const TASK = /^(\s*)[-*] \[([ xX])\](.*)$/;

  function parse(text, { nested = false } = {}) {
    const rows = [];
    String(text || '').split('\n').forEach((line, index) => {
      const match = line.match(TASK);
      if (match) {
        const indent = nested ? Math.min(6, Math.floor(match[1].replace(/\t/g, '  ').length / 2)) : 0;
        rows.push({
          id: `c-${index}`,
          text: match[3].replace(/^\s+/, ''),
          done: match[2] !== ' ',
          indent,
        });
        return;
      }
      if (line.trim() && !rows.length) {
        rows.push({ id: `c-${index}`, text: line.trim(), done: false, indent: 0 });
      }
    });
    if (!rows.length) rows.push({ id: 'c-0', text: '', done: false, indent: 0 });
    return rows;
  }

  function serialize(rows, { nested = false } = {}) {
    return (rows || [])
      .map((row) => {
        const indent = nested ? '  '.repeat(Math.max(0, Number(row.indent) || 0)) : '';
        return `${indent}- [${row.done ? 'x' : ' '}] ${String(row.text || '').replace(/\n/g, ' ')}`;
      })
      .join('\n');
  }

  function toggle(rows, id) {
    return (rows || []).map((row) => (row.id === id ? { ...row, done: !row.done } : row));
  }

  function setText(rows, id, text) {
    return (rows || []).map((row) => (row.id === id ? { ...row, text } : row));
  }

  function addRow(rows, afterId, { nested = false, text = '' } = {}) {
    const next = [...(rows || [])];
    const at = afterId ? next.findIndex((row) => row.id === afterId) : -1;
    const prev = at >= 0 ? next[at] : (next[next.length - 1] || { indent: 0 });
    const insertAt = at >= 0 ? at + 1 : next.length;
    next.splice(insertAt, 0, {
      id: `c-${Date.now()}-${next.length}`,
      text: text || '',
      done: false,
      indent: nested ? (prev?.indent || 0) : 0,
    });
    return next;
  }

  function removeRow(rows, id) {
    const next = (rows || []).filter((row) => row.id !== id);
    return next.length ? next : [{ id: 'c-0', text: '', done: false, indent: 0 }];
  }

  function bumpIndent(rows, id, delta) {
    return (rows || []).map((row) => {
      if (row.id !== id) return row;
      return { ...row, indent: Math.max(0, Math.min(6, (Number(row.indent) || 0) + delta)) };
    });
  }

  const api = { parse, serialize, toggle, setText, addRow, removeRow, bumpIndent };
  if (typeof window !== 'undefined') window.NotesChecklist = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
