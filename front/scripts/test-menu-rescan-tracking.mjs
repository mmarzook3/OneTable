#!/usr/bin/env node
/**
 * Synthetic-only, opt-in live regression. No .env defaults or provider calls.
 * Required: ALLOW_SYNTHETIC=1 BASE_URL FIXTURE_MANIFEST LOGIN_PASSWORD
 * Manifest is the private tmp/qr-tracking-fixture.py seed result; do not log it.
 * Seed creates a paid/preparing order directly (not a Stripe/payment test).
 * Uses customer-order-tracker-<id>, customer-order-status-<id> test IDs.
 * Primary owns authorization to run and cleanup, after closing browsers.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isHeadless } from './puppeteer-headless.mjs';
const require = createRequire(import.meta.url);
class Failure extends Error {}
const check = (condition, message) => { if (!condition) throw new Failure(message); };
let phase = 'guards';
async function main() {
  check(process.env.ALLOW_SYNTHETIC === '1', 'Explicit synthetic opt-in required.');
  const f = JSON.parse(readFileSync(process.env.FIXTURE_MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
  check(f.ok === true && /^scanaki-qr-tracking-[a-z0-9][a-z0-9-]{7,39}$/.test(f.marker)
    && f.email === `${f.marker}@scanaki.uk` && f.tenant_id > 1 && f.order_id > 0
    && typeof f.table_token === 'string' && f.table_token.length > 8
    && typeof f.session_id === 'string' && f.session_id.length >= 16, 'Invalid isolated fixture manifest.');
  check(Boolean(process.env.LOGIN_PASSWORD), 'Synthetic owner password required.');
  const base = new URL(process.env.BASE_URL);
  check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password
    && base.pathname === '/' && !base.search && !base.hash, 'BASE_URL must be an origin.');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || ['/usr/bin/chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
  check(executablePath && existsSync(executablePath), 'Existing Chromium executable required.');
  const browser = await require('puppeteer-core').launch({ executablePath,
    headless: isHeadless(), defaultViewport: { width: 1100, height: 900 } });
  const errors = [];
  let intentionalOffline = false;
  function watch(page) {
    page.setDefaultTimeout(25000);
    page.on('pageerror', () => errors.push('runtime'));
    page.on('console', m => { if (m.type() === 'error' && !intentionalOffline) errors.push('console'); });
    page.on('response', r => {
      const u = new URL(r.url());
      if (u.origin === base.origin && u.pathname.startsWith('/api/') && r.status() >= 400
        && !intentionalOffline) errors.push(`API ${r.status()}`);
    });
  }
  const menuURL = `${base.origin}/menu/${encodeURIComponent(f.table_token)}`;
  const selector = `[data-testid="customer-order-tracker-${f.order_id}"]`;
  async function tracked(page, status) {
    await page.waitForSelector(selector, { visible: true });
    await page.waitForFunction(({ id, status }) => {
      const element = document.querySelector(`[data-testid="customer-order-status-${id}"]`);
      const text = element?.textContent?.toLowerCase() || '';
      return status === 'delivered' ? /delivered|completed|served|done/.test(text) : text.includes(status);
    }, {}, { id: f.order_id, status });
    check(await page.evaluate(({ key, session }) => localStorage.getItem(key) === session,
      { key: `session_${f.table_token}`, session: f.session_id }), 'Customer session changed.');
  }
  async function api(page, path, method = 'GET', body) {
    const result = await page.evaluate(async ({ path, method, body }) => {
      const headers = { 'Content-Type': 'application/json' };
      const csrf = document.cookie.split('; ').find(v => v.startsWith('csrf_token='));
      if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf.slice('csrf_token='.length));
      const r = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      return { status: r.status, body: r.ok ? await r.json() : null };
    }, { path, method, body });
    check(result.status >= 200 && result.status < 300, `Scoped API failed: HTTP ${result.status}.`);
    return result.body;
  }
  try {
    const staffContext = await browser.createBrowserContext();
    const staff = await staffContext.newPage(); watch(staff);
    phase = 'isolated tenant identity';
    await staff.goto(`${base.origin}/login`, { waitUntil: 'networkidle2' });
    const tenant = await api(staff, `/public/tenants/${f.tenant_id}`);
    check(tenant.id === f.tenant_id && tenant.name === f.marker, 'Tenant marker mismatch.');
    await staff.type('input[type="email"]', f.email);
    await staff.type('input[type="password"]', process.env.LOGIN_PASSWORD);
    await staff.click('button[type="submit"]');
    await staff.waitForFunction(() => !location.pathname.startsWith('/login'));
    const me = await api(staff, '/users/me');
    check(me.tenant_id === f.tenant_id && me.email === f.email && me.role === 'owner', 'Owner scope mismatch.');
    const orders = await api(staff, '/orders?include_removed=true');
    check(orders.length === 1 && orders[0].id === f.order_id
      && orders[0].items.every(i => i.status === 'preparing'), 'Unexpected fixture orders.');
    check((await api(staff, '/tenant/print-agents')).length === 0, 'Physical agents forbidden.');

    phase = 'paid order restored without order cache';
    const customerContext = await browser.createBrowserContext();
    let customer = await customerContext.newPage(); watch(customer);
    await customer.goto(`${base.origin}/login`, { waitUntil: 'networkidle2' });
    await customer.evaluate(({ token, session, name }) => {
      localStorage.clear(); localStorage.setItem(`session_${token}`, session);
      localStorage.setItem(`customer_name_${token}`, name);
    }, { token: f.table_token, session: f.session_id, name: f.marker });
    await customer.goto(menuURL, { waitUntil: 'networkidle2' });
    await tracked(customer, 'preparing');
    phase = 'new tab rescan';
    await customer.goto(`${base.origin}/login`, { waitUntil: 'networkidle2' });
    const next = await customerContext.newPage(); watch(next); await customer.close(); customer = next;
    await customer.goto(menuURL, { waitUntil: 'networkidle2' });
    await tracked(customer, 'preparing');

    phase = 'separate browser isolation';
    const strangerContext = await browser.createBrowserContext();
    const stranger = await strangerContext.newPage(); watch(stranger);
    await stranger.goto(menuURL, { waitUntil: 'networkidle2' });
    check(await stranger.$(selector) === null, 'Another browser sees the private order.');
    check(!(await stranger.evaluate(() => document.body.innerText)).includes(`${f.marker}-PRIVATE-NOTE`),
      'Another browser sees private notes.');
    const privateRead = await stranger.evaluate(async token => {
      const session = localStorage.getItem(`session_${token}`);
      const r = await fetch(`/api/menu/${encodeURIComponent(token)}/order?session_id=${encodeURIComponent(session || '')}`);
      return { status: r.status, value: r.ok ? await r.json() : null };
    }, f.table_token);
    check(privateRead.status === 200 && !JSON.stringify(privateRead.value).includes(`${f.marker}-PRIVATE-NOTE`)
      && privateRead.value?.id !== f.order_id
      && privateRead.value?.order?.id !== f.order_id
      && !(privateRead.value?.orders || []).some(order => order.id === f.order_id),
      'Public API leaked another browser order.');

    phase = 'offline paid tracking and reconnect';
    intentionalOffline = true;
    await customer.setOfflineMode(true);
    await customer.evaluate(() => window.dispatchEvent(new Event('focus')));
    await customer.waitForSelector('[data-testid="customer-tracking-stale"]', { visible: true });
    await tracked(customer, 'preparing');
    await api(staff, `/orders/${f.order_id}/kitchen-status`, 'PUT', { status: 'ready' });
    await customer.setOfflineMode(false);
    intentionalOffline = false;
    await customer.evaluate(() => window.dispatchEvent(new Event('online')));
    await tracked(customer, 'ready');
    phase = 'completion after same QR reload';
    await api(staff, `/orders/${f.order_id}/kitchen-status`, 'PUT', { status: 'delivered' });
    await customer.reload({ waitUntil: 'networkidle2' });
    await tracked(customer, 'delivered');
    check((await api(staff, '/print-jobs?limit=10')).length === 0, 'Unexpected print job.');
    check(errors.length === 0, `Browser errors recorded: ${errors.length}.`);
    console.log('PASS: paid/preparing rescan, new-tab persistence, private browser isolation, reconnect and delivered tracking.');
  } finally { await browser.close(); }
}
main().catch(error => {
  console.error(`FAIL during ${phase}: ${error instanceof Failure ? error.message : 'Details suppressed to protect private fixture data.'}`);
  process.exitCode = 1;
});
