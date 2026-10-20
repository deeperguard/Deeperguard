import { chromium, webkit } from 'playwright';
import { mkdir } from 'fs/promises';
import path from 'path';

const baseUrl = process.env.MK_BASE_URL || 'http://127.0.0.1:8765';
const outDir = process.env.MK_SCREENSHOT_DIR || '/opt/cursor/artifacts/screenshots';
const prefix = process.env.MK_SHOT_PREFIX || 'after';

const devices = [
  { name: 'iphone-se', width: 320, height: 568 },
  { name: 'iphone-15', width: 393, height: 852 },
];

async function shot(page, file, url, opts = {}) {
  await page.setViewportSize({ width: opts.width, height: opts.height || 852 });
  if (opts.colorScheme) {
    await page.emulateMedia({ colorScheme: opts.colorScheme });
  }
  await page.goto(url, { waitUntil: 'networkidle' });
  if (opts.scrollTo) {
    const selectors = String(opts.scrollTo).split(',').map((s) => s.trim());
    let scrolled = false;
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        await loc.waitFor({ state: 'visible', timeout: 8000 });
        await loc.scrollIntoViewIfNeeded();
        scrolled = true;
        break;
      } catch {
        /* try next selector */
      }
    }
    if (!scrolled) {
      throw new Error(`No scroll target found among: ${selectors.join(', ')}`);
    }
  }
  await page.screenshot({ path: path.join(outDir, file), fullPage: opts.fullPage });
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await webkit.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  for (const d of devices) {
    await shot(page, `${prefix}-homepage-hero-${d.name}.png`, `${baseUrl}/`, {
      width: d.width,
      height: d.height,
    });
    await shot(page, `${prefix}-homepage-pricing-table-${d.name}.png`, `${baseUrl}/#pricing`, {
      width: d.width,
      scrollTo: '.mk-compare-plans, table.mk-compare',
    });
  }

  await shot(page, `${prefix}-compare-sn-table-iphone-se.png`, `${baseUrl}/compare/standard-notes`, {
    width: 320,
    height: 568,
    scrollTo: '.mk-compare-sn, #compare-table table.mk-compare',
  });
  await shot(page, `${prefix}-compare-sn-table-iphone-15.png`, `${baseUrl}/compare/standard-notes`, {
    width: 393,
    scrollTo: '.mk-compare-sn, #compare-table table.mk-compare',
  });

  await shot(page, `${prefix}-homepage-dark-393.png`, `${baseUrl}/`, {
    width: 393,
    colorScheme: 'dark',
  });

  await shot(page, `${prefix}-dark-compare-featured-1280.png`, `${baseUrl}/#compare`, {
    width: 1280,
    height: 900,
    colorScheme: 'dark',
    scrollTo: '.mk-distinction-card.featured',
  });
  await shot(page, `${prefix}-dark-pricing-1280.png`, `${baseUrl}/#pricing`, {
    width: 1280,
    height: 900,
    colorScheme: 'dark',
    scrollTo: 'table.mk-compare',
  });
  await shot(page, `${prefix}-dark-sn-compare-393.png`, `${baseUrl}/compare/standard-notes`, {
    width: 393,
    colorScheme: 'dark',
    scrollTo: '.mk-compare-sn, #compare-table table.mk-compare',
  });
  await shot(page, `${prefix}-dark-oss-hero-393.png`, `${baseUrl}/`, {
    width: 393,
    colorScheme: 'dark',
    scrollTo: '.mk-oss-callout, .mk-hero',
  });

  await browser.close();
  console.log('Screenshots written to', outDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
