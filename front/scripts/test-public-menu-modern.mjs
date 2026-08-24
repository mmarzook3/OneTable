#!/usr/bin/env node
/** Smoke test for the modern guest-facing public menu. */

import { createRequire } from 'module';
import { isHeadless } from './puppeteer-headless.mjs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:4202').replace(/\/$/, '');
const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const tenantsResponse = await fetch(`${BASE_URL}/api/public/tenants`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!tenantsResponse.ok) throw new Error(`Public tenants returned ${tenantsResponse.status}`);
  const tenants = await tenantsResponse.json();
  const demo = tenants.find((tenant) => tenant.is_demo === true);
  if (!demo?.id) throw new Error('Fictional demo tenant is missing');

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
    const response = await page.goto(`${BASE_URL}/public-menu/${demo.id}`, {
      waitUntil: 'networkidle2',
      timeout: 25000,
    });
    if (!response || response.status() >= 400) {
      throw new Error(`Public menu returned ${response?.status()}`);
    }
    await page.waitForSelector('#public-menu-search', { timeout: 15000 });
    await page.waitForSelector('[data-testid="public-menu-product-card"]', { timeout: 15000 });

    const initial = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="public-menu-product-card"]'));
      const images = Array.from(document.querySelectorAll('.public-menu-product-image'));
      const multiGrid = Array.from(document.querySelectorAll('.public-menu-product-grid')).find(
        (grid) => grid.querySelectorAll('[data-testid="public-menu-product-card"]').length >= 2,
      );
      const columns = multiGrid
        ? getComputedStyle(multiGrid).gridTemplateColumns.split(' ').filter(Boolean).length
        : 0;
      return {
        cards: cards.length,
        images: images.length,
        loadedImages: images.filter((image) => image.complete && image.naturalWidth > 0).length,
        chips: document.querySelectorAll('.public-menu-category-chip').length,
        columns,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    if (initial.cards < 10 || initial.images < 10 || initial.loadedImages < 3) {
      throw new Error(`Menu content or images missing: ${JSON.stringify(initial)}`);
    }
    if (initial.chips < 2 || initial.columns < 2 || initial.horizontalOverflow) {
      throw new Error(`Menu discovery or layout failed: ${JSON.stringify(initial)}`);
    }

    await page.type('#public-menu-search', 'Fish');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="public-menu-product-card"]').length === 1,
      { timeout: 5000 },
    );
    const fishName = await page.$eval('.public-menu-product__heading h3', (element) =>
      element.textContent.trim(),
    );
    if (fishName !== 'Fish & Chips') throw new Error(`Search returned ${fishName}`);

    await page.click('.public-menu-search-clear');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="public-menu-product-card"]').length >= 10,
      { timeout: 5000 },
    );
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('.public-menu-category-chip')).find((item) =>
        item.textContent.includes('Soft Drinks'),
      );
      button?.click();
    });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="public-menu-product-card"]').length === 2,
      { timeout: 5000 },
    );

    await page.type('#public-menu-search', 'not-a-real-menu-item');
    await page.waitForSelector('[data-testid="public-menu-no-results"]', { timeout: 5000 });
    await page.click('[data-testid="public-menu-no-results"] button');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="public-menu-product-card"]').length >= 10,
      { timeout: 5000 },
    );

    if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join(' | ')}`);
    console.log('PUBLIC_MENU_MODERN_SMOKE_OK');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
