#!/usr/bin/env node
/**
 * Read-only real staff UI receipt smoke. Run only when explicitly requested.
 * Pipe JSON on stdin: {baseUrl, tenant_id, order_id, email, password}.
 * BASE_URL must equal baseUrl; PUPPETEER_EXECUTABLE_PATH must name existing Chrome.
 * Requires existing puppeteer-core and ./staff-login.mjs; no installs.
 * Known fixtures: local order 5397; VPS order 147 (148 is refunded).
 * Requires synthetic Phase 1 owner/tenant, paid GBP 5.00 Soup order, no refund,
 * no tip/discount/billing customer, fiscal mode off, actual print bridge offline.
 * UI: /orders?focusOrder=ID -> .modal-order-edit -> third modal action button.
 * Native window.open/document.write remain untouched; only print/close are
 * suppressed synchronously in the real popup so its DOM can be inspected.
 * Checks print-media geometry and Chromium PDF generation in memory; no files,
 * receipt HTML construction, API mocking, payments, fiscal issuance or jobs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { loginStaff } from './staff-login.mjs';

let browser;
let stage = 'configuration';
const deadline = setTimeout(() => {
  console.error('FAIL receipt: overall deadline (120 seconds)');
  void browser?.close();
  process.exit(1);
}, 120000);

function cents(text) {
  const normalized = text.replace(/[^0-9,.-]/g, '');
  assert(/^\d+[.,]\d{2}$/.test(normalized), 'Unexpected money format');
  return Math.round(Number(normalized.replace(',', '.')) * 100);
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
  const { baseUrl, tenant_id: tenantId, order_id: orderId, email, password } = input;
  const url = new URL(baseUrl);
  assert.equal(url.origin, baseUrl);
  assert.equal(baseUrl, process.env.BASE_URL);
  assert(url.protocol === 'https:' || (url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]', 'haproxy'].includes(url.hostname)));
  assert(Number.isSafeInteger(tenantId) && tenantId > 0);
  assert(Number.isSafeInteger(orderId) && orderId > 0);
  assert(typeof email === 'string' && /^phase1-[a-f0-9]{32}@amvara\.de$/.test(email));
  assert(typeof password === 'string' && password.length > 0);
  assert(process.env.PUPPETEER_EXECUTABLE_PATH);
  const runId = email.slice(7, 39);

  stage = 'browser launch';
  browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    headless: true, timeout: 20000,
    args: process.env.PUPPETEER_NO_SANDBOX === '1'
      ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  stage = 'staff login';
  await loginStaff(page, { baseUrl, email, password, tenantId });

  // After login, fail closed on writes, including accidental print jobs.
  let blockedWrites = 0;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      blockedWrites++;
      void request.abort().catch(() => {});
    } else {
      void request.continue().catch(() => {});
    }
  });
  async function read(path) {
    return page.evaluate(async path => {
      const response = await fetch(path, { credentials: 'include', redirect: 'error',
        signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Read failed');
      return response.json();
    }, path);
  }

  stage = 'synthetic paid order preconditions';
  const me = await read('/api/users/me');
  assert.equal(me.role, 'owner');
  assert.equal(me.tenant_id, tenantId);
  const settings = await read('/api/tenant/settings');
  assert.equal(settings.name, `Scanaki Phase 1 ${runId}`);
  assert(!['test', 'live'].includes(settings.fiscal_mode));
  const orders = await read('/api/orders');
  assert(Array.isArray(orders));
  const order = orders.find(row => row.id === orderId);
  assert(order);
  if (order.tenant_id != null) assert.equal(order.tenant_id, tenantId);
  assert(['paid', 'completed'].includes(order.status));
  assert.equal(order.payment_state, 'succeeded');
  assert.equal(order.total_cents, 500);
  assert.equal(order.tip_amount_cents || 0, 0);
  assert.equal(order.loyalty_discount_cents || 0, 0);
  assert.equal(order.billing_customer_id ?? null, null);
  const items = order.items.filter(item => !item.removed_by_customer);
  assert(items.length > 0);
  for (const item of items) {
    assert.equal(item.product_name, `Synthetic Soup ${runId}`);
    assert(Number.isSafeInteger(item.quantity) && item.quantity > 0);
    assert(Number.isSafeInteger(item.price_cents) && item.price_cents > 0);
  }
  assert.equal(items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0), 500);
  assert.equal((await read('/api/print-jobs/status')).agent_online, false);

  stage = 'real orders UI';
  await page.goto(`${baseUrl}/staff/orders?focusOrder=${orderId}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.modal-order-edit .modal-actions', { visible: true });
  assert(await page.$eval('.modal-order-edit .modal-header h3', (el, id) =>
    new RegExp(`#${id}(?!\\d)`).test(el.textContent), orderId));
  const printButton = '.modal-order-edit .modal-actions button:nth-child(3)';
  await page.waitForSelector(printButton, { visible: true });

  // Install before clicking: intercepting targetcreated alone races document.write/onload.
  await page.evaluate(() => {
    const nativeOpen = window.open.bind(window);
    window.open = (...args) => {
      const popup = nativeOpen(...args);
      if (popup) {
        popup.__receiptPrintCalls = 0;
        popup.print = () => { popup.__receiptPrintCalls++; };
        popup.close = () => {};
      }
      return popup;
    };
  });
  stage = 'UI-generated receipt popup';
  const [target] = await Promise.all([
    browser.waitForTarget(target => target.opener() === page.target(), { timeout: 15000 }),
    page.click(printButton),
  ]);
  const receipt = await target.page();
  assert(receipt);
  await receipt.waitForFunction(() => window.__receiptPrintCalls === 1 &&
    document.querySelector('.total-row'), { timeout: 15000 });
  await receipt.setViewport({ width: 800, height: 1000 });
  await receipt.emulateMediaType('print');
  stage = 'receipt content and print layout';
  const actual = await receipt.evaluate(() => {
    const table = document.querySelector('table');
    const body = document.body.getBoundingClientRect();
    const rows = [...table.rows];
    const cells = [...table.querySelectorAll('th, td')];
    return {
      title: document.title,
      name: document.querySelector('.header h1')?.textContent,
      headers: table.querySelectorAll('thead th').length,
      items: rows.filter(row => row.cells.length === 5 && row.cells[0].tagName === 'TD')
        .map(row => [...row.cells].map(cell => cell.innerText.trim())),
      total: document.querySelector('.total-row td:last-child')?.textContent,
      width: body.width,
      contentWidth: parseFloat(getComputedStyle(document.body).width),
      maxWidth: getComputedStyle(document.body).maxWidth,
      layout: cells.every(cell => {
        const box = cell.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.left >= body.left - 1 &&
          box.right <= body.right + 1 && cell.scrollWidth <= cell.clientWidth + 1;
      }),
      totalBold: Number(getComputedStyle(document.querySelector('.total-row')).fontWeight) >= 700,
      footer: !!document.querySelector('.footer')?.textContent.trim(),
      taxRows: rows.filter(row => row.cells.length === 2 &&
        !row.classList.contains('total-row')).map(row => [...row.cells].map(cell => cell.innerText.trim())),
    };
  });
  assert.equal(actual.title, `Invoice #${orderId}`);
  assert.equal(actual.name, settings.name);
  assert.equal(actual.headers, 5);
  assert.equal(actual.items.length, items.length);
  items.forEach((item, index) => {
    const row = actual.items[index];
    assert.equal(row[0].split('\n')[0], item.product_name);
    assert.equal(Number(row[1]), item.quantity);
    assert.equal(cents(row[2]), item.price_cents);
    assert.equal(cents(row[4]), item.price_cents * item.quantity);
    if (item.tax_amount_cents > 0) assert.equal(cents(row[3]), item.tax_amount_cents);
    else assert.equal(row[3], '\u2014');
  });
  assert.equal(cents(actual.total), 500);
  assert(actual.total.includes('\u00a3') || actual.total.includes('GBP'));
  const taxes = new Map();
  for (const item of items) {
    if (item.tax_rate_percent > 0 && item.tax_amount_cents > 0) {
      taxes.set(item.tax_rate_percent, (taxes.get(item.tax_rate_percent) || 0) + item.tax_amount_cents);
    }
  }
  assert.equal(actual.taxRows.length, taxes.size + (taxes.size ? 1 : 0));
  for (const [rate, amount] of taxes) {
    const row = actual.taxRows.find(row => row[0] === `IVA ${rate}%`);
    assert(row);
    assert.equal(cents(row[1]), amount);
  }
  if (taxes.size) assert.equal(cents(actual.taxRows.at(-1)[1]),
    [...taxes.values()].reduce((sum, amount) => sum + amount, 0));
  assert.equal(actual.maxWidth, '400px');
  console.log(`Receipt geometry: contentWidth=${actual.contentWidth}, cellsFit=${actual.layout}, totalBold=${actual.totalBold}, footer=${actual.footer}`);
  assert(actual.contentWidth <= 400 && actual.layout && actual.totalBold && actual.footer);
  stage = 'Chromium print PDF';
  const pdf = await receipt.pdf({ format: 'A4', printBackground: true, timeout: 15000 });
  assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), '%PDF-');
  assert(pdf.length > 1000);
  stage = 'final read-only checks';
  const finalOrder = (await read('/api/orders')).find(row => row.id === orderId);
  assert.equal(finalOrder?.status, order.status);
  assert.equal(finalOrder?.payment_state, 'succeeded');
  assert.equal(blockedWrites, 0);
  console.log(`PASS receipt order_id=${orderId} tenant_id=${tenantId}: real UI popup, GBP 5.00, item/tax totals, print layout, Chromium PDF`);
} catch (error) {
  // Never print exceptions/assertion values, credentials, bodies, URLs or DOM.
  console.error(`FAIL receipt at ${stage}: ${error.name}; assertion line ${error.stack?.match(/test-phase1-receipt\.mjs:(\d+)/)?.[1] || 'unknown'}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  clearTimeout(deadline);
}
