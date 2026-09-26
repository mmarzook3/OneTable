#!/usr/bin/env node
// Disposable fixture only: one completed order, two delivered items, no jobs/agents.
// Creates two queued tickets, never sends them to a physical printer.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class GuardError extends Error {}
const check = (value, message) => { if (!value) throw new GuardError(message); };
let browser;
let stage = 'guard';
try {
  const { LOGIN_EMAIL: email, LOGIN_PASSWORD: password, BASE_URL: base } = process.env;
  const tenant = Number(process.env.TEST_TENANT_ID);
  const order = Number(process.env.TEST_ORDER_ID);
  check(process.env.ALLOW_SYNTHETIC === '1' && tenant > 1 && Number.isSafeInteger(tenant) && Number.isSafeInteger(order), 'Explicit disposable fixture required');
  check(/^scanaki-first-swipe-smoke-[a-z0-9-]+@scanaki\.uk$/.test(email || '') && password, 'Synthetic credentials required');
  check(base && new URL(base).origin === base, 'BASE_URL must be an origin');
  browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], defaultViewport: { width: 1440, height: 1000 } });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  let errors = 0;
  page.on('pageerror', () => errors++);
  page.on('console', (message) => { if (message.type() === 'error') errors++; });
  page.on('response', (response) => {
    if (response.url().startsWith(`${base}/api/`) && response.status() >= 400) errors++;
  });
  const read = async (path) => {
    const result = await page.evaluate(async (path) => {
      const response = await fetch(`/api${path}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
      return { status: response.status, body: response.ok ? await response.json() : null };
    }, path);
    check(result.status === 200, `Read HTTP ${result.status}`);
    return result.body;
  };
  const state = async () => {
    const orders = await read('/orders?include_removed=true&kitchen_released_only=true');
    check(orders.length === 1 && orders[0].id === order && orders[0].status === 'completed', 'Completed fixture mismatch');
    check(orders[0].items.length === 2 && orders[0].items.every((item) => item.status === 'delivered'), 'Delivered items required');
    return JSON.stringify({ status: orders[0].status, paid_at: orders[0].paid_at, payment_state: orders[0].payment_state,
      items: orders[0].items.map((item) => [item.id, item.status]) });
  };
  const jobs = async (expected) => {
    const rows = await read('/print-jobs?limit=200');
    check(rows.length === expected && new Set(rows.map((row) => row.id)).size === expected, 'Unexpected job count/IDs');
    check(rows.every((row) => row.tenant_id === tenant && row.order_id === order && row.job_type === 'kitchen' && !row.claimed_by_agent_id), 'Unexpected job ownership');
  };
  stage = 'login';
  await page.goto(`${base}/login`, { waitUntil: 'networkidle2' });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !location.pathname.startsWith('/login'));
  const me = await read('/users/me');
  const venue = await read(`/public/tenants/${tenant}`);
  check(me.email === email && me.tenant_id === tenant && me.role === 'owner' && venue.name === email.split('@')[0], 'Tenant identity mismatch');
  check((await read('/tenant/print-agents')).length === 0, 'No physical agents permitted');
  const original = await state();
  await jobs(0);
  stage = 'completed history';
  await page.goto(`${base}/kitchen`, { waitUntil: 'networkidle2' });
  check(!(await page.$(`[data-testid="kitchen-print-order-${order}"]`)), 'Completed order leaked into active board');
  await page.click('[data-testid="kitchen-all-orders-button"]');
  const selector = `[data-testid="kitchen-history-print-order-${order}"]`;
  await page.waitForSelector(selector, { visible: true });
  for (let count = 1; count <= 2; count++) {
    stage = `history reprint ${count}`;
    await page.waitForFunction((selector) => !document.querySelector(selector)?.disabled, {}, selector);
    const [response] = await Promise.all([
      page.waitForResponse((response) => response.url() === `${base}/api/print-jobs` && response.request().method() === 'POST'),
      page.click(selector),
    ]);
    check(response.ok(), 'History print request failed');
    await sleep(3000);
    await jobs(count);
    check(await state() === original, 'Reprinting changed production/payment state');
  }
  stage = 'reopen after reload';
  await page.reload({ waitUntil: 'networkidle2' });
  await page.click('[data-testid="kitchen-all-orders-button"]');
  await page.waitForSelector(selector, { visible: true });
  await sleep(3000);
  await jobs(2);
  check(await state() === original && errors === 0, 'Final state/browser error check failed');
  console.log('PASS: completed order visible after reload; two history reprints queued exactly two jobs; payment/item states unchanged; no browser/API errors.');
} catch (error) {
  console.error(`FAIL during ${stage}: ${error instanceof GuardError ? error.message : 'Browser/tooling failure (sensitive details suppressed)'}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
