#!/usr/bin/env node
/** Read-only smoke test for the QR/NFC table-ordering menu. */

import { createRequire } from 'module';
import { isHeadless } from './puppeteer-headless.mjs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:4202').replace(/\/$/, '');
const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  const tenantsResponse = await fetch(`${BASE_URL}/api/public/tenants`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!tenantsResponse.ok) throw new Error(`Public tenants returned ${tenantsResponse.status}`);
  const tenants = await tenantsResponse.json();
  const demo = tenants.find(
    (tenant) => tenant.is_demo === true && tenant.take_away_table_token,
  );
  if (!demo?.take_away_table_token) throw new Error('Demo ordering table is missing');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: isHeadless(),
    defaultViewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    const response = await page.goto(`${BASE_URL}/menu/${demo.take_away_table_token}`, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    if (!response || response.status() >= 400) {
      throw new Error(`Ordering menu returned ${response?.status()}`);
    }
    await page.waitForSelector('[data-testid="ordering-menu-search"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="ordering-product-card"]', { timeout: 15000 });
    await page.evaluate(() => {
      const skip = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Skip',
      );
      skip?.click();
    });

    const initial = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="ordering-product-card"]'));
      const images = Array.from(document.querySelectorAll('img.product-image'));
      const grid = document.querySelector('.products-grid');
      return {
        cards: cards.length,
        images: images.length,
        loadedImages: images.filter((image) => image.complete && image.naturalWidth > 0).length,
        categoryChips: document.querySelectorAll('.category-chip').length,
        quickFilters: document.querySelectorAll('.quick-filter-chip').length,
        columns: grid
          ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
          : 0,
        horizontalOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    if (initial.cards < 8 || initial.images < 3 || initial.loadedImages < 1) {
      throw new Error(`Ordering content or images missing: ${JSON.stringify(initial)}`);
    }
    if (initial.categoryChips < 2 || initial.columns < 2) {
      throw new Error(`Ordering discovery controls failed: ${JSON.stringify(initial)}`);
    }
    if (initial.horizontalOverflow) throw new Error('Desktop ordering menu overflows horizontally');

    await page.type('[data-testid="ordering-menu-search"]', 'Fish');
    await page.waitForFunction(
      () => {
        const cards = Array.from(document.querySelectorAll('[data-testid="ordering-product-card"]'));
        return cards.length >= 1 && cards.every((card) => /fish/i.test(card.textContent || ''));
      },
      { timeout: 5000 },
    );
    await page.click('.menu-search-clear');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="ordering-product-card"]').length >= 8,
      { timeout: 5000 },
    );

    await page.type('[data-testid="ordering-menu-search"]', 'not-a-real-menu-item');
    await page.waitForSelector('.empty-state .clear-menu-filters-btn', { timeout: 5000 });
    await page.click('.empty-state .clear-menu-filters-btn');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="ordering-product-card"]').length >= 8,
      { timeout: 5000 },
    );

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.waitForFunction(() => window.innerWidth === 390);
    const mobile = await page.evaluate(() => ({
      cards: document.querySelectorAll('[data-testid="ordering-product-card"]').length,
      searchVisible: Boolean(document.querySelector('[data-testid="ordering-menu-search"]')),
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    if (!mobile.searchVisible || mobile.cards < 8 || mobile.horizontalOverflow) {
      throw new Error(`Mobile ordering layout failed: ${JSON.stringify(mobile)}`);
    }

    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join(' | ')}`);
    console.log('ORDERING_MENU_MODERN_SMOKE_OK');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
