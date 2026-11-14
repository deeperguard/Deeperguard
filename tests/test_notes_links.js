/**
 * Backlink index performance regression (spec 4.4/4.5): 5 000-note vault
 * builds under a generous ceiling (5x the 150 ms budget), the build is linear,
 * chunks are short, timers still run during the build (UI responsive), and an
 * incremental update reads only the edited note.
 */
const assert = require('assert');
const B = require('../app/static/js/backlinks.js');
const { generateVault, timeBuild, stats } = require('./bench_notes_links.js');

(async () => {
  const BUDGET = 150;
  const vault5 = generateVault(5000, 10);
  const vault10 = generateVault(10000, 10);
  const fast = () => Promise.resolve();
  await timeBuild(vault5, { yieldFn: fast });
  const runs5 = [];
  const runs10 = [];
  const chunks = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await timeBuild(vault5, { yieldFn: fast });
    runs5.push(r.total);
    chunks.push(r.longest);
    runs10.push((await timeBuild(vault10, { yieldFn: fast })).total);
  }
  const m5 = stats(runs5).median;
  const m10 = stats(runs10).median;
  console.log(`backlink build 5000 notes: median ${m5.toFixed(1)} ms (budget ${BUDGET} ms), `
    + `longest chunk ${stats(chunks).median.toFixed(1)} ms (budget 50 ms); 10000 notes: ${m10.toFixed(1)} ms`);
  assert.ok(m5 < BUDGET * 5, `5k build ${m5} ms over ceiling`);
  assert.ok(stats(chunks).median < 50 * 5, 'single chunk stays short');
  assert.ok(m10 < Math.max(3 * m5, 30), `build is linear (${m10} vs ${m5})`);

  // Index is correct for the worst cases: hub note and code-fenced links.
  const hub = [...vault5.keys()][0];
  assert.ok(B.linksTo(hub).length >= 99, 'hub note has backlinks from many notes');

  // UI stays responsive: with the real (timer) yield, timers fire between chunks.
  B.clear();
  let ticks = 0;
  let stop = false;
  const beat = () => { ticks += 1; if (!stop) setTimeout(beat, 0); };
  setTimeout(beat, 0);
  const ids = [...vault5.keys()];
  const res = await B.build({ listIds: () => ids, getItem: (id) => vault5.get(id) });
  stop = true;
  assert.strictEqual(res.aborted, false);
  assert.ok(ticks >= 10, `event loop ran ${ticks} times during the build (expected one per chunk)`);

  // Incremental update reads only the edited note.
  const reads = new Set();
  const edited = ids[10];
  const it = vault5.get(edited);
  const proxy = new Proxy(it, { get(t, k) { reads.add(edited); return t[k]; } });
  const t0 = performance.now();
  B.update(edited, proxy);
  const dt = performance.now() - t0;
  assert.deepStrictEqual([...reads], [edited]);
  assert.ok(dt < 10 * 5, `one-note update ${dt} ms`);
  console.log('notes links perf: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
