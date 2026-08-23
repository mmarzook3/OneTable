#!/usr/bin/env node
/**
 * Full local smoke: platform operator provisions a restaurant, owner completes
 * first-login onboarding, dashboard opens, then the exact test tenant is purged.
 */
import { createRequire } from 'module';
import { isHeadless } from './puppeteer-headless.mjs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:4202').replace(/\/$/, '');
const OPERATOR_EMAIL = process.env.PLATFORM_OPERATOR_EMAIL || 'onboarding-platform-test@amvara.de';
const OPERATOR_PASSWORD = process.env.PLATFORM_OPERATOR_PASSWORD || 'onboarding-platform-password-42';
const CHROME_PATH =
  process.env.CHROME_PATH ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome');

async function clickAndWaitFor(page, selector, nextSelector) {
  await page.click(selector);
  await page.waitForSelector(nextSelector, { timeout: 15000 });
}

async function main() {
  const stamp = Date.now();
  const restaurantName = `Scanaki Onboarding Smoke ${stamp}`;
  const ownerEmail = `onboarding-smoke-${stamp}@amvara.de`;
  let ownerPassword = '';
  let ownerLoggedIn = false;

  const browser = process.env.PUPPETEER_WS_ENDPOINT
    ? await puppeteer.connect({ browserWSEndpoint: process.env.PUPPETEER_WS_ENDPOINT })
    : process.env.PUPPETEER_CONNECT_URL
      ? await puppeteer.connect({ browserURL: process.env.PUPPETEER_CONNECT_URL })
    : await puppeteer.launch({
        headless: isHeadless(),
        executablePath: CHROME_PATH,
        defaultViewport: { width: 1440, height: 1000 },
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('[pageerror]', error.message));

  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en' });
    await page.evaluateOnNewDocument(() => localStorage.setItem('pos_language', 'en'));

    console.log('1. Platform operator login');
    await page.goto(`${BASE_URL}/platform/login`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.type('input#email', OPERATOR_EMAIL);
    await page.type('input#password', OPERATOR_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => window.location.pathname === '/platform', { timeout: 15000 });

    console.log('2. Provision restaurant account');
    await page.click('[data-testid="platform-create-restaurant-link"]');
    await page.waitForSelector('[data-testid="platform-create-restaurant-form"]', { timeout: 15000 });
    await page.type('[data-testid="platform-restaurant-name"]', restaurantName);
    await page.type('[data-testid="platform-owner-name"]', 'Onboarding Smoke Owner');
    await page.type('[data-testid="platform-owner-email"]', ownerEmail);
    await clickAndWaitFor(
      page,
      '[data-testid="platform-create-submit"]',
      '[data-testid="platform-created-credentials"]',
    );
    const createdUsername = await page.$eval(
      '[data-testid="created-username"]',
      (element) => element.textContent?.trim() || '',
    );
    ownerPassword = await page.$eval(
      '[data-testid="created-temporary-password"]',
      (element) => element.textContent?.trim() || '',
    );
    if (createdUsername !== ownerEmail || ownerPassword.length < 12) {
      throw new Error('Provisioned credentials were missing or incorrect');
    }

    console.log('3. Owner login redirects to first-login setup');
    await page.evaluate(async (baseUrl) => {
      await fetch(`${baseUrl}/api/logout`, { method: 'POST', credentials: 'include' });
    }, BASE_URL);
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.type('input#email', ownerEmail);
    await page.type('input#password', ownerPassword);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => window.location.pathname === '/onboarding', { timeout: 20000 });
    ownerLoggedIn = true;
    await page.waitForSelector('[data-testid="onboarding-step-account"]', { timeout: 15000 });

    console.log('4. Complete password and restaurant details');
    const permanentPassword = `Owner-safe-${stamp}`;
    await page.type('[data-testid="onboarding-password"]', permanentPassword);
    await page.type('[data-testid="onboarding-password-confirm"]', permanentPassword);
    await clickAndWaitFor(
      page,
      '[data-testid="onboarding-account-next"]',
      '[data-testid="onboarding-step-business"]',
    );
    await page.type('#business-phone', '+442071838750');
    await page.type('#business-address', '1 High Street, London');
    await clickAndWaitFor(
      page,
      '[data-testid="onboarding-business-next"]',
      '[data-testid="onboarding-step-hours"]',
    );

    console.log('5. Save hours and create table links');
    await clickAndWaitFor(
      page,
      '[data-testid="onboarding-hours-next"]',
      '[data-testid="onboarding-step-tables"]',
    );
    await page.click('[data-testid="onboarding-table-count"]', { clickCount: 3 });
    await page.type('[data-testid="onboarding-table-count"]', '3');
    await clickAndWaitFor(
      page,
      '[data-testid="onboarding-tables-next"]',
      '[data-testid="onboarding-step-menu"]',
    );

    console.log('6. Seed starter menu and finish review');
    await clickAndWaitFor(
      page,
      '[data-testid="onboarding-menu-next"]',
      '[data-testid="onboarding-step-review"]',
    );
    await page.click('[data-testid="onboarding-finish"]');
    await page.waitForFunction(() => window.location.pathname === '/dashboard', { timeout: 20000 });
    await page.waitForSelector('app-dashboard', { timeout: 15000 });

    const rawKeys = await page.evaluate(
      () => (document.body.textContent || '').match(/RESTAURANT_ONBOARDING\.[A-Z0-9_]+/g) || [],
    );
    if (rawKeys.length) throw new Error(`Untranslated onboarding keys: ${rawKeys.join(', ')}`);

    console.log('OK: operator creation, owner redirect, all setup sections, and dashboard');
  } finally {
    if (ownerLoggedIn) {
      const cleanup = await page.evaluate(
        async ({ baseUrl, restaurant }) => {
          const response = await fetch(`${baseUrl}/api/tenant/purge`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm_tenant_name: restaurant }),
          });
          return { status: response.status, body: await response.text() };
        },
        { baseUrl: BASE_URL, restaurant: restaurantName },
      );
      if (cleanup.status !== 200) {
        console.error(`WARN: cleanup failed (${cleanup.status}): ${cleanup.body}`);
      } else {
        console.log('OK: exact smoke-test tenant removed');
      }
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error('FAIL:', error.message || error);
  process.exit(1);
});
