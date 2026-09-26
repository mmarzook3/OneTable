#!/usr/bin/env node
/**
 * Real-app, destructive smoke for a freshly seeded, disposable kitchen fixture.
 * Required explicit environment (no .env loading and no fixture defaults):
 *   ALLOW_SYNTHETIC=1 BASE_URL LOGIN_EMAIL LOGIN_PASSWORD
 *   TEST_TENANT_ID TEST_ORDER_ID
 * Tenant name: scanaki-first-swipe-smoke-<nonce>
 * Owner email: <exact tenant name>@scanaki.uk (also LOGIN_EMAIL).
 * Seed exactly one fresh, kitchen-visible order with non-removed pending items,
 * no other orders, no print jobs, and no connected physical print agent.
 * The owner must have kitchen status and printing permissions; no OTP challenge.
 * Optional: PUPPETEER_EXECUTABLE_PATH; HEADLESS=0 for a visible browser.
 * Run: node front/scripts/test-kitchen-first-swipe-print.mjs
 * This leaves the order completed and five print jobs for primary-owned cleanup.
 * No API mutation replay: UI requests retain the application's CSRF handling.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { isHeadless } from './puppeteer-headless.mjs';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class SmokeFailure extends Error {}
function check(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

let phase = 'environment guards';
async function main() {
  check(process.env.ALLOW_SYNTHETIC === '1', 'ALLOW_SYNTHETIC must explicitly equal 1.');
  for (const key of ['BASE_URL', 'LOGIN_EMAIL', 'LOGIN_PASSWORD', 'TEST_TENANT_ID', 'TEST_ORDER_ID']) {
    check(Boolean(process.env[key]?.trim()), `Required environment variable missing: ${key}.`);
  }
  const base = new URL(process.env.BASE_URL);
  check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password &&
    base.pathname === '/' && !base.search && !base.hash, 'BASE_URL must be an HTTP(S) origin without credentials.');
  const tenantId = Number(process.env.TEST_TENANT_ID);
  const orderId = Number(process.env.TEST_ORDER_ID);
  check([tenantId, orderId].every((id) => Number.isSafeInteger(id) && id > 0),
    'Fixture IDs must be positive safe integers.');
  const email = process.env.LOGIN_EMAIL;
  check(/^scanaki-first-swipe-smoke-[a-z0-9-]+@scanaki\.uk$/.test(email),
    'LOGIN_EMAIL must identify a marker-scoped synthetic owner.');
  const marker = email.slice(0, email.indexOf('@'));
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((path) => existsSync(path));
  check(Boolean(executablePath) && existsSync(executablePath),
    'Provide PUPPETEER_EXECUTABLE_PATH pointing to an existing browser.');
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath, headless: isHeadless(), defaultViewport: { width: 1440, height: 1000 },
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    let consoleErrors = 0;
    let pageErrors = 0;
    let apiErrors = 0;
    // Do not log browser messages, response bodies, URLs, credentials, or fixture PII.
    // No blanket font/network exclusions: every console error fails this smoke.
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors++; });
    page.on('pageerror', () => { pageErrors++; });
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === base.origin && url.pathname.startsWith('/api/') && response.status() >= 400) apiErrors++;
    });
    function cleanBrowser() {
      check(consoleErrors === 0 && pageErrors === 0 && apiErrors === 0,
        `Browser errors: console=${consoleErrors}, page=${pageErrors}, API=${apiErrors}.`);
    }
    async function read(path) {
      const result = await page.evaluate(async (apiPath) => {
        const response = await fetch(apiPath, { credentials: 'same-origin', cache: 'no-store',
          signal: AbortSignal.timeout(10000) });
        return { status: response.status, body: response.ok ? await response.json() : null };
      }, `/api${path}`);
      check(result.status === 200, `Fixture API read failed with HTTP ${result.status}.`);
      return result.body;
    }
    async function guardIdentity() {
      const me = await read('/users/me');
      check(me?.tenant_id === tenantId && me.email === email && me.role === 'owner',
        'Authenticated user must be the matching synthetic tenant owner.');
      const tenant = await read(`/public/tenants/${tenantId}`);
      check(tenant?.id === tenantId && tenant.name === marker,
        'Tenant identity does not match the synthetic marker.');
    }
    let itemIds;
    async function orderState(expectedStatus) {
      const orders = await read('/orders?include_removed=true');
      check(Array.isArray(orders) && orders.length === 1 && orders[0].id === orderId,
        'Fixture must contain exactly the specified order and no other orders.');
      const items = orders[0].items;
      check(Array.isArray(items) && items.length > 0 && items.every((item) => !item.removed_by_customer),
        'Fixture must contain non-removed kitchen items.');
      const ids = items.map((item) => item.id).sort((a, b) => a - b);
      check(ids.every(Number.isSafeInteger) && new Set(ids).size === ids.length,
        'Fixture item IDs must be unique integers.');
      if (!itemIds) itemIds = ids;
      check(JSON.stringify(ids) === JSON.stringify(itemIds), 'Fixture items changed during smoke.');
      check(items.every((item) => item.status === expectedStatus),
        `All fixture items must have status ${expectedStatus}.`);
    }
    let previousJobIds = new Set();
    async function jobs(expected) {
      const rows = await read('/print-jobs?limit=200');
      check(Array.isArray(rows) && rows.length === expected,
        `Expected exactly ${expected} tenant print jobs.`);
      check(rows.every((job) => job.tenant_id === tenantId && job.order_id === orderId &&
        job.job_type === 'kitchen'), 'Unexpected tenant, order, or type in print jobs.');
      const ids = new Set(rows.map((job) => job.id));
      check(ids.size === rows.length && [...ids].every(Number.isSafeInteger), 'Print job IDs must be unique integers.');
      check([...previousJobIds].every((id) => ids.has(id)), 'Previously observed print jobs disappeared.');
      previousJobIds = ids;
    }
    async function stable(expected, status) {
      // Observe a bounded interval, including the normal KDS refresh window.
      for (let sample = 0; sample < 7; sample++) {
        if (sample) await sleep(1000);
        await jobs(expected);
        cleanBrowser();
      }
      await orderState(status);
    }
    async function mutation(path, method, action, validateRequest) {
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.origin === base.origin && url.pathname === `/api${path}` &&
          response.request().method() === method;
      });
      const [response] = await Promise.all([responsePromise, action()]);
      check(response.ok(), `UI mutation failed with HTTP ${response.status()}.`);
      if (validateRequest) validateRequest(JSON.parse(response.request().postData() || '{}'));
    }
    const activePrint = `[data-testid="kitchen-print-order-${orderId}"]`;
    const historyPrint = `[data-testid="kitchen-history-print-order-${orderId}"]`;
    async function enabled(selector) {
      await page.waitForSelector(selector, { visible: true });
      await page.waitForFunction((s) => {
        const element = document.querySelector(s);
        return element && !element.disabled;
      }, {}, selector);
    }
    async function swipe(actionClass, target, expectedJobs) {
      phase = `${target} swipe`;
      await guardIdentity();
      await orderState(target === 'preparing' ? 'pending' : target === 'ready' ? 'preparing' : 'ready');
      const selector = `[data-testid="kitchen-order-action-${orderId}"].order-swipe-action.${actionClass}`;
      await enabled(selector);
      const handle = await page.$(selector);
      await handle.scrollIntoView();
      const box = await handle.boundingBox();
      check(box && box.width > 80 && box.height > 0, 'Swipe control must be visible and usable.');
      await mutation(`/orders/${orderId}/kitchen-status`, 'PUT', async () => {
        await page.mouse.move(box.x + 16, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2, { steps: 18 });
        await page.mouse.up();
      }, (body) => {
        check(body.status === target, 'Swipe requested an unexpected kitchen status.');
        check(target === 'preparing' ? body.print_on_first_swipe === true : !body.print_on_first_swipe,
          'First-swipe print flag is incorrect.');
      });
      await stable(expectedJobs, target);
    }
    async function manualPrint(selector, expectedJobs, status) {
      phase = 'manual print';
      await guardIdentity();
      await orderState(status);
      await enabled(selector);
      await mutation('/print-jobs', 'POST', () => page.click(selector), (body) => {
        check(body.order_id === orderId && body.job_type === 'kitchen', 'Manual print targeted an unexpected order/type.');
      });
      await stable(expectedJobs, status);
    }

    phase = 'login';
    await page.goto(`${base.origin}/login`, { waitUntil: 'networkidle2' });
    const tenant = await read(`/public/tenants/${tenantId}`);
    check(tenant?.id === tenantId && tenant.name === marker, 'Refusing login: tenant marker mismatch.');
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', process.env.LOGIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !location.pathname.startsWith('/login'));
    await guardIdentity();
    await orderState('pending');
    await jobs(0);
    const agents = await read('/tenant/print-agents');
    check(Array.isArray(agents) && agents.length === 0, 'Disposable fixture must have no print agents.');

    phase = 'initial kitchen view';
    await page.goto(`${base.origin}/kitchen`, { waitUntil: 'networkidle2' });
    await enabled(activePrint);
    await stable(0, 'pending');
    await swipe('order-swipe-start', 'preparing', 1);

    phase = 'reload does not reprint';
    await page.reload({ waitUntil: 'networkidle2' });
    await enabled(activePrint);
    await guardIdentity();
    await stable(1, 'preparing');
    await swipe('order-swipe-ready', 'ready', 1);
    await manualPrint(activePrint, 2, 'ready');
    await manualPrint(activePrint, 3, 'ready');
    await swipe('order-swipe-complete', 'delivered', 3);

    phase = 'history';
    await page.waitForSelector(activePrint, { hidden: true });
    await page.click('[data-testid="kitchen-all-orders-button"]');
    await enabled(historyPrint);
    await stable(3, 'delivered');
    await manualPrint(historyPrint, 4, 'delivered');
    await manualPrint(historyPrint, 5, 'delivered');
    cleanBrowser();
    console.log('PASS: first swipe creates one job; reload and later swipes add none; four deliberate print clicks create four distinct jobs.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  // Only our fixed, non-sensitive diagnostics are safe to print.
  console.error(`FAIL during ${phase}: ${error instanceof SmokeFailure ? error.message : 'Browser/tooling operation failed; details suppressed to protect fixture data.'}`);
  process.exitCode = 1;
});
