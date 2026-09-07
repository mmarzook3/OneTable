#!/usr/bin/env node
/**
 * Synthetic Phase1 browser/API transaction. No existing/demo tenant fallback.
 * Required env: PHASE1_FIXTURE=tmp/phase1-fixture.json, BASE_URL (same loopback
 * origin as fixture), PHASE1_LIVE_MODE=false, PHASE1_STRIPE_SECRET_KEY=sk_test_...,
 * PHASE1_OWNER_PASSWORD. Supply PUPPETEER_EXECUTABLE_PATH for local Chrome, or
 * PUPPETEER_CONNECT_URL for an existing loopback browser. No installs performed.
 *
 * node front/scripts/test-phase1-transaction.mjs --check
 *   Offline manifest/configuration validation only; no browser/network/writes.
 * node front/scripts/test-phase1-transaction.mjs --execute --allow-local-synthetic
 *   Explicitly creates a local synthetic order and a real Stripe TEST payment.
 *   Retains fixture/order/print job for inspection; never silently cleans up.
 *
 * Coverage: UI login/basket/notes/submission/no-refresh KDS/reports; API retry idempotency, Stripe
 * browser test-card settlement, exact WebSocket events, KDS item transition, receipt payload, report reconciliation.
 * Not covered: 3DS, webhooks, restricted staff roles, hardware
 * printing, browser receipt layout, refunds, offline operation, production.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { loginStaff } from './staff-login.mjs';

const passed = [];
const uncovered = ['3DS', 'Stripe webhook delivery/retries',
  'restricted staff permissions', 'physical printing/browser receipt layout',
  'refunds/offline/production'];
let browser;
let fixture;
let stage = 'configuration';
let orderId;
const screenshots = [];
let paymentUiError;
const transport = { websocket_connections: 0, websocket_frames: 0, sse_events: 0,
  matched_new_order: false, matched_order_paid: false,
  interpretation: 'Observed traffic only; no-refresh visibility does not prove push caused the update (KDS also polls).' };

function localOrigin(raw) {
  const url = new URL(raw);
  assert.equal(url.protocol, 'http:', 'HTTP loopback required');
  assert(['localhost', '127.0.0.1', '[::1]', 'haproxy'].includes(url.hostname),
    'Loopback or exact Compose host haproxy required');
  assert(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    'Bare loopback origin required');
  return url.origin;
}

async function main() {
  const args = process.argv.slice(2);
  const stdin = args.includes('--credentials-stdin');
  const options = args.filter(arg => arg !== '--credentials-stdin');
  const remote = options.includes('--allow-remote-synthetic');
  const check = options.length === 1 && options[0] === '--check';
  assert(check || (options.length === 2 && options.includes('--execute') &&
    options.includes(remote ? '--allow-remote-synthetic' : '--allow-local-synthetic')),
  'Use --check or --execute with exactly one synthetic opt-in');
  assert.equal(process.env.PHASE1_LIVE_MODE, 'false', 'PHASE1_LIVE_MODE must be false');
  for (const key of ['APP_ENV', 'ENVIRONMENT', 'NODE_ENV']) {
    assert(remote || !['production', 'prod', 'live'].includes((process.env[key] || '').toLowerCase()),
      'Production environment refused');
  }
  const credentials = stdin ? JSON.parse(readFileSync(0, 'utf8')) : {};
  const secret = credentials.stripe_secret_key || process.env.PHASE1_STRIPE_SECRET_KEY || '';
  const ownerPassword = credentials.owner_password || process.env.PHASE1_OWNER_PASSWORD || '';
  assert(/^(sk|rk)_test_/.test(secret) && secret.length > 16, 'Stripe test secret required');
  assert(ownerPassword.length >= 14, 'Owner password required');
  assert(process.env.PHASE1_FIXTURE, 'PHASE1_FIXTURE is required');
  const envelope = JSON.parse(readFileSync(process.env.PHASE1_FIXTURE, 'utf8').replace(/^\uFEFF/, ''));
  assert(typeof envelope.payload === 'string' && /^[a-f0-9]{64}$/.test(envelope.signature),
    'Invalid signed fixture envelope');
  const expected = createHmac('sha256', secret).update(envelope.payload).digest();
  assert(timingSafeEqual(expected, Buffer.from(envelope.signature, 'hex')), 'Fixture signature mismatch');
  fixture = JSON.parse(envelope.payload);
  assert.equal(fixture.schema, 1);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.livemode, false);
  assert(/^[a-f0-9]{32}$/.test(fixture.run_id), 'Invalid unique run ID');
  assert.equal(fixture.tenant_name, `Scanaki Phase 1 ${fixture.run_id}`);
  assert.equal(fixture.owner_email, `phase1-${fixture.run_id}@amvara.de`);
  assert.equal(fixture.product_name, `Synthetic Soup ${fixture.run_id}`);
  assert(Number.isSafeInteger(fixture.question_id) && fixture.question_id > 0, 'Invalid question_id');
  assert.equal(fixture.question_label, 'Soup finish');
  assert.equal(fixture.question_option, 'No garnish');
  assert.equal(fixture.amount_cents, 500);
  assert.equal(fixture.currency, 'gbp');
  assert(/^[a-f0-9]{64}$/.test(fixture.publishable_key_sha256), 'Missing publishable-key fingerprint');
  const age = Date.now() / 1000 - fixture.created_at;
  assert(Number.isFinite(age) && age >= -30 && age <= 1800, 'Fixture expired or clock invalid');
  let base;
  if (remote) {
    assert.equal(process.env.PHASE1_ALLOW_REMOTE_SYNTHETIC, '1', 'Explicit remote env opt-in required');
    const url = new URL(process.env.BASE_URL || '');
    assert.equal(url.protocol, 'https:');
    assert(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash);
    base = url.origin;
    assert.equal(base, process.env.PHASE1_REMOTE_ORIGIN, 'Remote origin acknowledgement mismatch');
    assert.equal(fixture.target, 'remote');
  } else {
    base = localOrigin(process.env.BASE_URL || '');
    assert.equal(fixture.target, 'local');
  }
  assert.equal(base, fixture.base_url, 'Fixture origin mismatch');
  for (const key of ['tenant_id', 'location_id', 'table_id', 'product_id']) {
    assert(Number.isSafeInteger(fixture[key]) && fixture[key] > 0, `Invalid ${key}`);
  }
  passed.push('signed local synthetic manifest/configuration');
  if (check) {
    console.log(JSON.stringify({ result: 'configuration-only', run_id: fixture.run_id,
      passed, transaction_executed: false, uncovered }));
    return;
  }

  async function stripe(path) {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(20000),
    });
    assert(response.ok, `Stripe ${path.split('/')[0]} HTTP ${response.status}`);
    const result = await response.json();
    if (result.object === 'list') {
      assert(Array.isArray(result.data), 'Stripe list data missing');
      assert(result.data.every(item => item.livemode === false), 'Stripe list contains non-test object');
    } else {
      assert.equal(result.livemode, false, 'Stripe object must explicitly be test mode');
    }
    return result;
  }
  stage = 'Stripe test-mode preflight';
  await stripe('payment_intents?limit=1');
  passed.push(stage);
  const require = createRequire(import.meta.url);
  const puppeteer = require('puppeteer-core');
  if (process.env.PUPPETEER_CONNECT_URL) {
    localOrigin(process.env.PUPPETEER_CONNECT_URL);
    browser = await puppeteer.connect({ browserURL: process.env.PUPPETEER_CONNECT_URL });
  } else {
    assert(process.env.PUPPETEER_EXECUTABLE_PATH, 'PUPPETEER_EXECUTABLE_PATH required');
    browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }
  const staffContext = await browser.createBrowserContext();
  const guestContext = await browser.createBrowserContext();
  try {
    const staff = await staffContext.newPage();
    const guest = await guestContext.newPage();
    // Parse frames transiently; retain only counts and exact order/type match booleans.
    const network = await staff.createCDPSession();
    await network.send('Network.enable');
    network.on('Network.webSocketHandshakeResponseReceived', event => {
      if (event.response.status === 101) transport.websocket_connections++;
    });
    network.on('Network.webSocketFrameReceived', event => {
      transport.websocket_frames++;
      if (!Number.isSafeInteger(orderId) || event.response.opcode !== 1) return;
      try {
        const message = JSON.parse(event.response.payloadData);
        if (message?.order_id !== orderId) return;
        if (message.type === 'new_order') transport.matched_new_order = true;
        if (message.type === 'order_paid') transport.matched_order_paid = true;
      } catch {
        // Non-JSON frames are not evidence; never log their contents.
      }
    });
    network.on('Network.eventSourceMessageReceived', () => transport.sse_events++);
    const pageErrors = [];
    for (const page of [staff, guest]) {
      page.on('pageerror', () => pageErrors.push('browser pageerror'));
      await page.evaluateOnNewDocument(() => localStorage.setItem('pos_language', 'en'));
      page.setDefaultTimeout(15000);
    }
    async function goto(page, path) {
      const response = await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      assert(response?.ok(), `Page ${path.split('/')[1]} failed`);
      assert.equal(new URL(page.url()).origin, base, 'Cross-origin navigation refused');
    }
    async function api(page, path, method = 'GET', body) {
      const result = await page.evaluate(async ({ base, path, method, body }) => {
        const response = await fetch(`${base}/api${path}`, {
          method, credentials: 'include', redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        return { status: response.status, body: await response.json() };
      }, { base, path, method, body });
      assert(result.status >= 200 && result.status < 300,
        `Endpoint contract failed: ${method} ${path.split('?')[0]} HTTP ${result.status}`);
      return result.body;
    }
    async function poll(read, accept, label) {
      const deadline = Date.now() + 20000;
      do {
        const value = await read();
        if (accept(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 400));
      } while (Date.now() < deadline);
      throw new Error(`Timed out: ${label}`);
    }
    stage = 'staff login and tenant identity';
    await loginStaff(staff, { baseUrl: base, email: fixture.owner_email,
      password: ownerPassword, tenantId: fixture.tenant_id });
    const me = await api(staff, '/users/me');
    assert.equal(me.tenant_id, fixture.tenant_id);
    assert.equal(me.email, fixture.owner_email);
    const settings = await api(staff, '/tenant/settings');
    assert.equal(settings.name, fixture.tenant_name);
    assert(settings.stripe_publishable_key?.startsWith('pk_test_'), 'Backend publishable key is not test mode');
    assert.equal(createHash('sha256').update(settings.stripe_publishable_key).digest('hex'),
      fixture.publishable_key_sha256, 'Backend publishable key changed');
    assert.equal(settings.stripe_payment_mode, 'tenant_keys');
    assert(!settings.stripe_connected_account_id, 'Connect mode refused');
    assert.equal(settings.ordering_mode, 'automatic');
    assert.equal(settings.immediate_payment_required, true);
    const tables = await api(staff, '/tables');
    assert(tables.some(t => t.id === fixture.table_id && t.token === fixture.table_token &&
      t.location_id === fixture.location_id),
      'Fixture table mismatch');
    assert.deepEqual(await api(staff, '/orders'), [], 'Fixture already used: create a fresh run');
    passed.push(stage);

    const date = new Date().toISOString().slice(0, 10);
    const reportPath = `/reports/sales?from_date=${date}&to_date=${date}`;
    const before = await api(staff, reportPath);
    assert.equal(before.summary.total_orders, 0);
    assert.equal(before.summary.total_revenue_cents, 0);
    stage = 'KDS open before checkout';
    await goto(staff, '/kitchen');
    await staff.waitForSelector('[data-testid="kds-active-count"]');
    await staff.waitForFunction(() =>
      document.querySelector('[data-testid="kds-active-count"]')?.textContent.trim() === '0');
    const documentMarker = await staff.evaluate(() => {
      window.__phase1DocumentMarker = `${Date.now()}-${Math.random()}`;
      return window.__phase1DocumentMarker;
    });
    let kdsNavigations = 0;
    const onNavigation = frame => { if (frame === staff.mainFrame()) kdsNavigations++; };
    staff.on('framenavigated', onNavigation);
    passed.push(stage);

    stage = 'guest basket UI and notes';
    await goto(guest, `/menu/${encodeURIComponent(fixture.table_token)}`);
    await guest.waitForSelector('[data-testid="ordering-product-card"]');
    await guest.waitForFunction(name => document.body.innerText.includes(name), {}, fixture.product_name);
    const menu = await api(guest, `/menu/${encodeURIComponent(fixture.table_token)}`);
    assert(menu.tenant_stripe_publishable_key?.startsWith('pk_test_'),
      'Guest publishable key is not test mode');
    assert.equal(createHash('sha256').update(menu.tenant_stripe_publishable_key).digest('hex'),
      fixture.publishable_key_sha256, 'Guest publishable key mismatch');
    assert(!menu.tenant_stripe_connected_account_id, 'Guest Connect mode refused');
    assert(menu.products.some(p => p.id === fixture.product_id && p.price_cents === 500),
      'Synthetic menu product contract mismatch');
    const questions = menu.products.find(p => p.id === fixture.product_id).questions;
    assert.equal(questions?.length, 1, 'Expected exactly one customization question');
    assert.equal(questions[0].id, fixture.question_id);
    assert.equal(questions[0].label, fixture.question_label);
    assert.equal(questions[0].type, 'choice');
    assert.equal(questions[0].required, true);
    assert.deepEqual(questions[0].options, ['With garnish', fixture.question_option]);
    const customizationAnswers = { [fixture.question_id]: fixture.question_option };
    const orderPath = `/menu/${encodeURIComponent(fixture.table_token)}/order`;
    // Use native UI interactions; never inject cart state or call Angular methods.
    if (await guest.$('.name-input')) {
      await guest.type('.name-input', `Synthetic ${fixture.run_id}`);
      await guest.keyboard.press('Enter');
      await guest.waitForSelector('.name-input', { hidden: true });
    }
    await guest.click(`[data-testid="ordering-product-card"][data-product-name="${fixture.product_name}"] .add-to-cart-btn`);
    await guest.waitForSelector('.customization-question .question-select', { visible: true });
    assert.equal(await guest.$eval('.customization-question .question-label', el => el.textContent.replace(/\s+/g, ' ').trim()),
      `${fixture.question_label} *`);
    await guest.select('.customization-question .question-select', fixture.question_option);
    assert.equal(await guest.$eval('.customization-question .question-select', el => el.value),
      fixture.question_option);
    await guest.locator('.modal-sheet .modal-actions .btn-primary').click();
    await guest.waitForSelector('.customization-question', { hidden: true });
    await guest.waitForSelector('.cart-sheet');
    if (!await guest.$('.cart-expanded-content')) await guest.click('.cart-summary');
    await guest.waitForSelector('.cart-expanded-content', { visible: true });
    assert.equal(await guest.$$eval('.cart-item-card', rows => rows.length), 1,
      'Basket must contain exactly one line');
    assert.equal(await guest.$eval('.cart-item-name', el => el.textContent.trim()), fixture.product_name,
      'Basket product mismatch');
    assert.equal(await guest.$eval('.qty-display', el => el.textContent.trim()), '1',
      'Basket quantity mismatch');
    assert((await guest.$eval('.cart-item-customization', el => el.textContent))
      .includes(fixture.question_option), 'Basket customization missing');
    const itemNote = `Item ${fixture.run_id}`;
    const orderNote = `Order ${fixture.run_id}`;
    await guest.click('.cart-item-card .comment-toggle-btn');
    await guest.waitForSelector('.cart-item-comment-field textarea', { visible: true });
    await guest.type('.cart-item-comment-field textarea', itemNote);
    const typedNote = await guest.$eval('.cart-item-comment-field textarea', el => el.value);
    assert.equal(typedNote, itemNote, `Typed item note length ${typedNote.length}, expected ${itemNote.length}`);
    await guest.type('#cart-order-notes', orderNote);
    await guest.click('.table-confirmation input');
    passed.push(stage);

    stage = 'single UI submission and API retry idempotency';
    const orderUrl = `${base}/api${orderPath}`;
    let uiSubmissions = 0;
    let replaying = false;
    guest.on('request', request => {
      if (!replaying && request.method() === 'POST' && request.url() === orderUrl) uiSubmissions++;
    });
    const [response] = await Promise.all([
      guest.waitForResponse(res => res.url() === orderUrl && res.request().method() === 'POST'),
      (async () => {
        await guest.click('.place-order-btn');
        // Some menu configurations ask for the optional name on submission.
        await guest.waitForFunction(() => document.querySelector('.name-input') ||
          !document.querySelector('.cart-item-card'));
        if (await guest.$('.name-input')) {
          await guest.type('.name-input', `Synthetic ${fixture.run_id}`);
          await guest.keyboard.press('Enter');
        }
      })(),
    ]);
    assert(response.ok(), 'UI order submission HTTP failure');
    const body = JSON.parse(response.request().postData());
    assert.equal(body.items.length, 1, 'Submitted basket line count mismatch');
    assert.equal(body.items[0].product_id, fixture.product_id, 'Submitted product mismatch');
    assert.equal(body.items[0].quantity, 1, 'Submitted quantity mismatch');
    assert.deepEqual(body.items[0].customization_answers, customizationAnswers,
      'UI submission customization mismatch');
    assert.equal(body.items[0].notes, itemNote,
      `Item note mismatch: expected ${itemNote.length} characters, got ${body.items[0].notes?.length ?? 0}`);
    assert.equal(body.notes, orderNote, 'Order note was not submitted');
    assert(typeof body.session_id === 'string' && body.session_id.length > 0, 'UI session missing');
    assert(typeof body.idempotency_key === 'string' && body.idempotency_key.length > 0,
      'UI idempotency key missing');
    const created = await response.json();
    orderId = created.order_id;
    assert(Number.isSafeInteger(orderId) && orderId > 0, 'Missing order_id');
    assert.equal(created.payment_required, true);
    replaying = true;
    try {
      assert.equal((await api(guest, orderPath, 'POST', body)).order_id, orderId);
    } finally {
      replaying = false;
    }
    assert.equal(uiSubmissions, 1, 'UI submitted more than once');
    const hidden = await api(staff, '/orders/kitchen-feed');
    assert(!hidden.some(o => o.id === orderId), 'Unpaid order leaked to KDS');
    assert.equal(await staff.$(`[data-order-id="${orderId}"]`), null,
      'Unpaid order visible in KDS UI');
    passed.push(stage);

    stage = 'browser Stripe test-card checkout: create intent';
    await guest.waitForSelector('.payment-options-sheet .payment-option-btn', { visible: true });
    const matchesPaymentEndpoint = (res, endpoint) => {
      const url = new URL(res.url());
      return url.origin === base && url.pathname === `/api/orders/${orderId}/${endpoint}` &&
        res.request().method() === 'POST';
    };
    const [intentResponse] = await Promise.all([
      guest.waitForResponse(res => matchesPaymentEndpoint(res, 'create-payment-intent')),
      guest.locator('.payment-options-sheet .payment-option-btn').click(),
    ]);
    assert(intentResponse.ok(), `UI create-payment-intent HTTP ${intentResponse.status()}`);
    const intent = await intentResponse.json();
    assert.equal(intent.amount, 500);
    assert(/^pi_[A-Za-z0-9]+$/.test(intent.payment_intent_id), 'Invalid payment intent ID');
    const payment = await stripe(`payment_intents/${intent.payment_intent_id}`);
    assert.equal(payment.amount, 500);
    assert.equal(payment.currency, 'gbp');
    assert.equal(payment.metadata.tenant_id, String(fixture.tenant_id));
    assert.equal(payment.metadata.order_id, String(orderId));
    assert.equal(payment.metadata.location_id, String(fixture.location_id));
    assert.equal(payment.metadata.payment_account_snapshot, 'tenant-default');
    assert.equal(payment.status, 'requires_payment_method');
    assert.equal(intent.client_secret, payment.client_secret, 'UI PaymentIntent secret mismatch');
    stage = 'browser Stripe test-card entry';
    const cardFrame = await poll(async () => {
      const element = await guest.$('.payment-modal #card-element iframe');
      if (!element) return null;
      try { return await element.contentFrame(); } finally { await element.dispose(); }
    }, frame => Boolean(frame?.url()?.startsWith('https://js.stripe.com/')),
    'Stripe Card Element iframe unavailable');
    assert.equal(new URL(cardFrame.url()).origin, 'https://js.stripe.com',
      'Unexpected card iframe origin');
    await cardFrame.waitForSelector('input[name="cardnumber"]', { visible: true });
    await cardFrame.type('input[name="cardnumber"]', '4242424242424242');
    const expiryYear = String((new Date().getUTCFullYear() + 3) % 100).padStart(2, '0');
    await cardFrame.type('input[name="exp-date"]', `12${expiryYear}`);
    await cardFrame.type('input[name="cvc"]', '123');
    await cardFrame.waitForSelector('input[name="postal"]', { visible: true });
    if (await cardFrame.$('input[name="postal"]')) {
      const placeholder = await cardFrame.$eval('input[name="postal"]', el => el.placeholder);
      await cardFrame.locator('input[name="postal"]').fill(/zip/i.test(placeholder) ? '12345' : 'SW1A 1AA');
    }
    stage = 'browser Stripe confirmation and server settlement';
    const [settlementResponse] = await Promise.all([
      guest.waitForResponse(res => matchesPaymentEndpoint(res, 'confirm-payment'), { timeout: 30000 }),
      guest.locator('.payment-modal .modal-actions .btn-primary').click(),
    ]);
    assert(settlementResponse.ok(), `UI confirm-payment HTTP ${settlementResponse.status()}`);
    const confirmationUrl = new URL(settlementResponse.url());
    assert.equal(confirmationUrl.searchParams.get('payment_intent_id'), payment.id,
      'UI confirmed a different PaymentIntent');
    const settlement = await settlementResponse.json();
    assert.equal(settlement.status, 'paid');
    await guest.waitForSelector('.payment-modal .payment-success', { visible: true });
    const confirmed = await stripe(`payment_intents/${payment.id}`);
    assert.equal(confirmed.id, payment.id);
    assert.equal(confirmed.status, 'succeeded', 'Browser test-card payment did not succeed');
    assert.equal(confirmed.amount, fixture.amount_cents);
    assert.equal(confirmed.amount_received, fixture.amount_cents);
    assert.equal(confirmed.currency, fixture.currency);
    assert.deepEqual(confirmed.metadata, payment.metadata, 'PaymentIntent metadata changed');
    const ledger = await api(staff, `/orders/${orderId}/payments`);
    assert.equal(ledger.amount_paid_cents, 500);
    assert.equal(ledger.amount_remaining_cents, 0);
    passed.push(stage);

    stage = 'exact paid-order WebSocket event verification';
    await poll(async () => transport.matched_new_order && transport.matched_order_paid,
      matched => matched, 'matching new_order and order_paid WebSocket events');
    passed.push(stage);

    stage = 'paid KDS ticket and notes without reload';
    const ticket = `[data-order-id="${orderId}"]`;
    await staff.waitForSelector(ticket, { visible: true, timeout: 30000 });
    await staff.waitForFunction(({ ticket, name, itemNote, orderNote, option }) => {
      const el = document.querySelector(ticket);
      return el?.querySelector('.item-name')?.textContent.trim() === name &&
        el.querySelector('.item-notes')?.textContent.includes(itemNote) &&
        el.querySelector('.item-customization')?.textContent.includes(option) &&
        el.querySelector('.customer-request')?.textContent.includes(orderNote) &&
        el.querySelector('.payment-badge-paid')?.textContent.trim() === 'PAID';
    }, {}, { ticket, name: fixture.product_name, itemNote, orderNote, option: fixture.question_option });
    assert.equal(kdsNavigations, 0, 'KDS navigated or reloaded before paid ticket appeared');
    assert.equal(await staff.evaluate(() => window.__phase1DocumentMarker), documentMarker,
      'KDS document was replaced');
    staff.off('framenavigated', onNavigation);
    assert.equal(uiSubmissions, 1, 'UI submitted more than once during payment');
    passed.push(stage);

    stage = 'KDS API fulfillment';
    const feed = await poll(() => api(staff, '/orders/kitchen-feed'),
      rows => rows.some(o => o.id === orderId), 'paid order in KDS');
    const order = feed.find(o => o.id === orderId);
    assert.equal(order.items.length, 1);
    assert.deepEqual(order.items[0].customization_answers, customizationAnswers,
      'KDS customization answers mismatch');
    assert(order.items[0].customization_summary?.includes(fixture.question_option),
      'KDS customization summary missing');
    for (const status of ['preparing', 'ready', 'delivered']) {
      await api(staff, `/orders/${orderId}/items/${order.items[0].id}/status`, 'PUT', { status });
    }
    await poll(() => api(staff, '/orders'), rows => rows.some(o =>
      o.id === orderId && o.status === 'completed'), 'completed paid order');
    passed.push(stage);

    stage = 'receipt API payload';
    const receipt = await api(staff, '/print-jobs', 'POST', {
      job_type: 'receipt', order_id: orderId, printer_role: 'receipt',
    });
    assert.equal(receipt.job.order_id, orderId);
    assert.equal(receipt.job.payload.total_cents, 500);
    assert.equal(receipt.job.payload.lines.length, 1);
    assert.equal(receipt.job.payload.lines[0].name, fixture.product_name);
    assert.equal(receipt.job.payload.lines[0].quantity, 1);
    passed.push(stage);

    stage = 'reports API reconciliation and UI';
    assert.equal(new Date().toISOString().slice(0, 10), date, 'Run crossed UTC midnight; use a fresh fixture');
    const after = await api(staff, reportPath);
    assert.equal(after.summary.total_orders, 1);
    assert.equal(after.summary.total_revenue_cents, 500);
    await goto(staff, '/reports');
    await staff.waitForSelector('[data-testid="reports-page"]');
    assert.equal(pageErrors.length, 0, 'Browser JavaScript errors occurred');
    passed.push(stage);
    console.log(JSON.stringify({ result: 'passed-bounded-coverage', run_id: fixture.run_id,
      tenant_id: fixture.tenant_id, order_id: orderId, passed, uncovered, transport,
      retained: 'Synthetic tenant, test payment, order and receipt job; no cleanup performed' }));
  } catch (error) {
    const [failedGuest] = await guestContext.pages();
    if (failedGuest) {
      paymentUiError = await failedGuest.$eval('.card-error', el => el.textContent.trim())
        .catch(() => undefined);
      paymentUiError = paymentUiError?.replace(/(?:sk|rk|pk)_(?:test|live)_\w+|whsec_\w+|pi_\w+_secret_\w+|https?:\/\/\S+/g, '[redacted]');
    }
    // Fail closed: only screenshot after replacing unknown text and hiding all
    // inputs/embedded content. No raw screenshot, HTML or network dump is saved.
    for (const [label, context] of [['guest', guestContext], ['staff', staffContext]]) {
      try {
        const [page] = await context.pages();
        assert(page && new URL(page.url()).origin === base);
        await page.evaluate(({ product, runId }) => {
          const allowed = new Set([product, `Item ${runId}`, `Order ${runId}`,
            'PAID', 'NOT PAID', 'Customer request', 'Total', 'Place order']);
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const nodes = [];
          while (walker.nextNode()) nodes.push(walker.currentNode);
          for (const node of nodes) {
            if (node.parentElement?.closest('style,script')) continue;
            if (node.textContent.trim() && !allowed.has(node.textContent.trim())) node.textContent = '[redacted]';
          }
          for (const el of document.querySelectorAll('*')) {
            el.removeAttribute('title');
            el.removeAttribute('placeholder');
            el.style.setProperty('background-image', 'none', 'important');
          }
          const style = document.createElement('style');
          style.textContent = 'input,textarea,select,iframe,img,svg,canvas,video,object,embed{visibility:hidden!important}*::before,*::after{content:none!important}';
          document.head.append(style);
          // Freeze the redacted DOM so Angular cannot repopulate secret text.
          const clone = document.body.cloneNode(true);
          document.body.replaceWith(clone);
        }, { product: fixture.product_name, runId: fixture.run_id });
        assert(process.env.PHASE1_EVIDENCE_DIR, 'Explicit evidence directory required');
        const directory = resolve(process.env.PHASE1_EVIDENCE_DIR, fixture.run_id);
        mkdirSync(directory, { recursive: true });
        const path = resolve(directory, `${label}-failure.png`);
        await page.screenshot({ path, fullPage: true });
        screenshots.push({ page: label, path, redacted: true });
      } catch {
        screenshots.push({ page: label, unavailable: 'Safe screenshot capture failed' });
      }
    }
    throw error;
  } finally {
    await guestContext.close();
    await staffContext.close();
  }
}

try {
  await main();
} catch (error) {
  // Do not dump responses, browser URLs, credentials, client secrets or stacks.
  console.error(JSON.stringify({ result: 'failed', stage, run_id: fixture?.run_id,
    order_id: orderId, passed, uncovered, transport, screenshots, paymentUiError,
    reason: error instanceof assert.AssertionError ? error.message.split('\n')[0]
      : error.message?.startsWith('No element found for selector:') ? error.message
      : error.message?.startsWith('Timed out:') || error.message?.startsWith('Staff login failed at ')
        ? error.message : error.name }));
  process.exitCode = 1;
} finally {
  if (browser) {
    if (process.env.PUPPETEER_CONNECT_URL) browser.disconnect();
    else await browser.close();
  }
}
