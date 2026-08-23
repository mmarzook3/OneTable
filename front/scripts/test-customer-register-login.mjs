#!/usr/bin/env node
/**
 * Puppeteer smoke: end-user customer register + login (#340).
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:4202 node front/scripts/test-customer-register-login.mjs
 *
 * Env:
 *   BASE_URL, CUSTOMER_EMAIL, CUSTOMER_PASSWORD, CUSTOMER_FULL_NAME, HEADLESS
 */

import { isHeadless } from './puppeteer-headless.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  let baseUrl = process.env.BASE_URL;
  if (!baseUrl) {
    for (const port of [4203, 4202, 4200]) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          method: 'head',
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok || res.status < 500) {
          baseUrl = `http://127.0.0.1:${port}`;
          break;
        }
      } catch (_) {}
    }
    baseUrl = baseUrl || 'https://scanaski.uk';
  }

  const ts = Date.now();
  const email = process.env.CUSTOMER_EMAIL || `customer-${ts}@amvara.de`;
  const password = process.env.CUSTOMER_PASSWORD || 'testpass123';
  const fullName = process.env.CUSTOMER_FULL_NAME || 'Test Customer';

  console.log(`BASE_URL=${baseUrl}`);
  console.log(`Registering ${email}…`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: isHeadless(),
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto(new URL('/customer/register', baseUrl).href, {
      waitUntil: 'networkidle2',
    });
    await page.waitForSelector('[data-testid="customer-register-form"]');
    await page.type('[data-testid="customer-register-name"]', fullName);
    await page.type('[data-testid="customer-register-email"]', email);
    await page.type('[data-testid="customer-register-password"]', password);
    await Promise.all([
      page.click('[data-testid="customer-register-submit"]'),
      page.waitForSelector('[data-testid="customer-register-success"]', { timeout: 20000 }),
    ]);
    console.log('1. Register OK');

    await page.goto(new URL('/customer/login', baseUrl).href, {
      waitUntil: 'networkidle2',
    });
    await page.waitForSelector('[data-testid="customer-login-form"]');
    await page.type('[data-testid="customer-login-email"]', email);
    await page.type('[data-testid="customer-login-password"]', password);
    await Promise.all([
      page.click('[data-testid="customer-login-submit"]'),
      page.waitForSelector('[data-testid="customer-home"]', { timeout: 20000 }),
    ]);
    console.log('2. Login → /customer OK');

    const empty = await page.$('[data-testid="customer-orders-empty"]');
    if (!empty) {
      throw new Error('Expected empty orders message on new account');
    }
    console.log('3. Orders empty state OK');
    console.log('PASS');
  } catch (err) {
    console.error('FAIL:', err.message || err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
