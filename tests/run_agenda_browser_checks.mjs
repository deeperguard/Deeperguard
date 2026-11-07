#!/usr/bin/env node
/**
 * Local Playwright checks for Agenda centering + period navigation (not in CI).
 * Usage: node tests/run_agenda_browser_checks.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import('playwright');

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function startFlask(dataRoot, port) {
  const env = {
    ...process.env,
    NOTES_ROOT: dataRoot,
    NOTES_DATA: path.join(dataRoot, 'data'),
    NOTES_KEYS: path.join(dataRoot, 'keys'),
    NOTES_ALLOWED_CIDRS: '127.0.0.1/32',
    NOTES_SKIP_LOGIN: '0',
    NOTES_ALLOW_REGISTER: '1',
    NOTES_DISABLE_CIDR_GATE: '1',
    NOTES_STRICT_ZK: '1',
    NOTES_SECURE_COOKIES: '0',
    NOTES_DEFAULT_PLAN: 'free',
    FLASK_APP: 'app',
    PYTHONPATH: path.join(root, 'app'),
  };
  return spawn('python3', ['-m', 'flask', 'run', '--host', '127.0.0.1', `--port=${port}`], {
    cwd: path.join(root, 'app'),
    env,
    stdio: 'ignore',
  });
}

const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '428', width: 428, height: 926 },
  { name: '1280', width: 1280, height: 800 },
];

const dataRoot = await mkdtemp(path.join(tmpdir(), 'dg-agenda-br-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const proc = startFlask(dataRoot, port);
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch({ headless: true });
const results = [];

try {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.goto(`${base}/register`, { waitUntil: 'domcontentloaded' });
    const email = `agenda-br-${vp.name}@e2e.invalid`;
    const pass = 'agenda-browser-pass1';
    await page.fill('input[name="email"]', email);
    await page.fill('#register-password', pass);
    await page.fill('#register-password2', pass);
    await page.check('#register-terms');
    await page.check('#register-recover-ack');
    await page.click('#register-submit');
    await page.waitForFunction("() => location.pathname === '/app'", { timeout: 120_000 });

    await page.evaluate(() => {
      const mon = new Date();
      mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
      mon.setHours(14, 0, 0, 0);
      const wed = new Date(mon);
      wed.setDate(wed.getDate() + 2);
      wed.setHours(8, 0, 0, 0);
      const e1 = NotesStore.newUuid();
      const e2 = NotesStore.newUuid();
      NotesStore.upsertAgendaEvent(e1, {
        title: 'Audit Mon 14:00',
        start: mon.toISOString(),
        end: new Date(mon.getTime() + 3600000).toISOString(),
        all_day: false,
        ical_uid: 'br-mon',
      });
      NotesStore.upsertAgendaEvent(e2, {
        title: 'Audit Wed 08:00',
        start: wed.toISOString(),
        end: new Date(wed.getTime() + 3600000).toISOString(),
        all_day: false,
        ical_uid: 'br-wed',
      });
      return NotesStore.flush();
    });

    await page.click('#app-tab-agenda');
    await page.waitForSelector('.agenda-scroll-wrap', { timeout: 20_000 });
    await page.waitForTimeout(600);

    const titleBefore = await page.locator('.agenda-title').innerText();
    const scrollGeo = await page.evaluate(() => {
      const wrap = document.querySelector('.agenda-scroll-wrap');
      const pxPerHour = 52;
      const vh = wrap?.clientHeight || 0;
      const earliestMin = 8 * 60;
      const eventTop = (earliestMin / 60) * pxPerHour;
      const target = Math.max(0, eventTop - vh / 2);
      const top = wrap?.scrollTop ?? 0;
      return { top, target, vh, diff: Math.abs(top - target) };
    });
    results.push({
      vp: vp.name,
      check: 'center_wed08',
      ok: scrollGeo.diff < 80,
      detail: scrollGeo,
    });

    const searchBefore = await page.evaluate(() => document.querySelector('.agenda-scroll-wrap')?.scrollTop ?? 0);
    await page.fill('#agenda-search', 'Mon');
    await page.waitForTimeout(500);
    const searchAfter = await page.evaluate(() => document.querySelector('.agenda-scroll-wrap')?.scrollTop ?? 0);
    results.push({
      vp: vp.name,
      check: 'search_no_jump',
      ok: searchBefore === searchAfter,
      detail: { searchBefore, searchAfter },
    });
    await page.fill('#agenda-search', '');
    await page.waitForTimeout(400);

    await page.click('[data-agenda-view="month"]');
    await page.waitForTimeout(500);
    const titleMonth = await page.locator('.agenda-title').innerText();

    const box = await page.locator('.agenda-body').boundingBox();
    if (box) {
      const x0 = box.x + box.width * 0.8;
      const x1 = box.x + box.width * 0.2;
      const y = box.y + box.height * 0.4;
      await page.touchscreen.tap(x0, y);
      await page.waitForTimeout(80);
      await page.touchscreen.tap(x1, y);
      await page.waitForTimeout(600);
    }
    const titleAfterSwipe = await page.locator('.agenda-title').innerText();
    results.push({
      vp: vp.name,
      check: 'month_swipe_period',
      ok: titleMonth !== titleAfterSwipe,
      detail: { titleMonth, titleAfterSwipe },
    });

    await page.close();
  }
} finally {
  await browser.close();
  proc.kill('SIGTERM');
  await rm(dataRoot, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ results, failed: failed.length }, null, 2));
process.exit(failed.length ? 1 : 0);
