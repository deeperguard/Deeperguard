/**
 * Backlink index benchmark (docs/NOTES_ORGANIZATION_SPEC.md 4.4/4.5).
 *   node tests/bench_notes_links.js [notes=5000] [links%=10]
 * Deterministic corpus (seeded PRNG): ~2 KB notes, links% of them with 5
 * links, plus worst cases (one hub note linked from every note, a 1 MB note
 * with 5 000 links, and `[[`/links inside code fences).
 */
const B = require('../app/static/js/backlinks.js');

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuidFor(i) {
  const h = (i + 1).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${h}`;
}

const WORDS = 'lorem ipsum dolor sit amet plan meeting idea draft review project budget notes link task'.split(' ');

function generateVault(n, linkPct = 10, { seed = 42, worstCases = true } = {}) {
  const rnd = prng(seed);
  const items = new Map();
  const hub = uuidFor(0);
  for (let i = 0; i < n; i += 1) {
    const uuid = uuidFor(i);
    let text = '';
    while (text.length < 2000) text += `${WORDS[Math.floor(rnd() * WORDS.length)]} `;
    if (rnd() * 100 < linkPct) {
      for (let k = 0; k < 5; k += 1) {
        const pos = Math.floor(rnd() * text.length);
        text = `${text.slice(0, pos)} [Note ${k}](dg-note:${uuidFor(Math.floor(rnd() * n))}) ${text.slice(pos)}`;
      }
    }
    if (worstCases && i > 0) {
      if (i % 50 === 0) text += `\n[Hub](dg-note:${hub})`; // hub linked from many notes
      if (i % 97 === 0) text += `\n\`\`\`\n[[x]] [Code](dg-note:${uuidFor(1)})\n\`\`\`\n`;
    }
    items.set(uuid, { uuid, deleted: false, content: { type: 'note', title: `Note ${i}`, content: text } });
  }
  if (worstCases && n > 2) {
    let big = '';
    for (let k = 0; big.length < 1_000_000 && k < 5000; k += 1) big += `${'x'.repeat(180)} [L](dg-note:${uuidFor(k % n)})\n`;
    items.get(uuidFor(1)).content.content = big;
  }
  return items;
}

async function timeBuild(items, opts = {}) {
  B.clear();
  const ids = [...items.keys()];
  const t0 = performance.now();
  const res = await B.build({ listIds: () => ids, getItem: (id) => items.get(id), ...opts });
  return { total: performance.now() - t0, longest: res.longest };
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] };
}

async function bench(n, linkPct, runs = 10) {
  const items = generateVault(n, linkPct);
  const yieldFn = () => Promise.resolve(); // scan cost only, no timer delay
  for (let i = 0; i < 2; i += 1) await timeBuild(items, { yieldFn });
  const totals = [];
  const longest = [];
  for (let i = 0; i < runs; i += 1) {
    const r = await timeBuild(items, { yieldFn });
    totals.push(r.total);
    longest.push(r.longest);
  }
  // Incremental update after one edit
  const one = [];
  const ids = [...items.keys()];
  for (let i = 0; i < 50; i += 1) {
    const id = ids[(i * 37) % ids.length];
    const it = items.get(id);
    it.content = { ...it.content, content: `${it.content.content} [E](dg-note:${ids[i]})` };
    const t0 = performance.now();
    B.update(id, it);
    one.push(performance.now() - t0);
  }
  const look = [];
  for (let i = 0; i < 1000; i += 1) {
    const t0 = performance.now();
    B.linksTo(ids[i % ids.length]);
    look.push(performance.now() - t0);
  }
  return { n, build: stats(totals), longestChunk: stats(longest), edit: stats(one), lookup: stats(look) };
}

if (require.main === module) {
  const n = Number(process.argv[2]) || 5000;
  const pct = Number(process.argv[3]) || 10;
  bench(n, pct).then((r) => {
    const f = (x) => `${x.toFixed(2)} ms`;
    console.log(`notes=${r.n} links%=${pct}`);
    console.log(`build  median ${f(r.build.median)}  p95 ${f(r.build.p95)}  (budget 5k: 150 ms / p95 300 ms)`);
    console.log(`longest chunk median ${f(r.longestChunk.median)}  (budget 50 ms)`);
    console.log(`edit   median ${f(r.edit.median)}  p95 ${f(r.edit.p95)}  (budget 2 ms)`);
    console.log(`lookup median ${f(r.lookup.median)}  p95 ${f(r.lookup.p95)}  (budget 0.1 ms)`);
  });
}

module.exports = { generateVault, uuidFor, timeBuild, bench, stats };
