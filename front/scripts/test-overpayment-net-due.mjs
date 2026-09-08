#!/usr/bin/env node
/**
 * Real cash-only overpayment UI regression. No installs or provider calls.
 * Private fixture JSON on stdin: {synthetic, marker, tenantId, token, target,
 * baseUrl, cases:[{name,orderId}]}. Caller must always clean its fixture.
 * Local: --execute --allow-synthetic; VPS also needs --allow-remote-synthetic.
 * Companion disposable fixture/runner are under tmp/phase3-overpayment-*.
 * Discounts are seeded: this tests settlement arithmetic, not redemption.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const scenarios = {
  'net-exact': { basket: 500, fee: 0, storedTip: 0, prior: 0, entered: 300, tip: 0 },
  'auto-tip': { basket: 500, fee: 0, storedTip: 0, prior: 0, entered: 350, tip: 50 },
  'delivery-prior': { basket: 500, fee: 100, storedTip: 50, prior: 100, entered: 350, tip: 50 },
  'capped-discount': { basket: 100, fee: 0, storedTip: 50, prior: 0, entered: 50, tip: 50 },
  underpayment: { basket: 500, fee: 0, storedTip: 0, prior: 0, entered: 299, tip: 0, reject: true },
  'voided-prior': { basket: 500, fee: 0, storedTip: 0, prior: 100, entered: 200, tip: 0, voided: 200 },
};
let browser;
let stage = 'configuration';
let blockedWrites = 0;
let paymentRequests = 0;
let pageErrors = 0;
let summaryFault = null;
let staleTipOrderId = null;
let staleTipResponses = 0;
const report = { result: 'FAIL', cases: [] };
try {
  const fixture = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(fixture.synthetic, true);
  assert.match(fixture.marker, /^Phase3 Overpayment [a-f0-9]{32}$/);
  assert(Number.isSafeInteger(fixture.tenantId) && ![1, 23, 25].includes(fixture.tenantId));
  const base = new URL(fixture.baseUrl);
  assert.equal(base.href, `${base.origin}/`);
  assert(!base.username && !base.password);
  const args = process.argv.slice(2).sort();
  if (fixture.target === 'local') {
    assert.deepEqual(args, ['--allow-synthetic', '--execute']);
    assert.equal(base.protocol, 'http:');
    assert(['haproxy', 'localhost', '127.0.0.1'].includes(base.hostname));
  } else {
    assert.equal(fixture.target, 'vps');
    assert.equal(base.origin, 'https://scanaki.uk');
    assert.deepEqual(args, ['--allow-remote-synthetic', '--allow-synthetic', '--execute']);
  }
  assert.deepEqual(fixture.cases.map(c => c.name).sort(), Object.keys(scenarios).sort());
  assert.equal(new Set(fixture.cases.map(c => c.orderId)).size, 6);
  for (const c of fixture.cases) assert(Number.isSafeInteger(c.orderId) && ![147, 149, 157].includes(c.orderId));
  report.target = fixture.target;
  report.tenant_id = fixture.tenantId;
  report.marker = fixture.marker;
  async function read(path) {
    const response = await fetch(`${base.origin}/api${path}`, {
      headers: { Authorization: `Bearer ${fixture.token}` }, redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, 'Fixture read failed');
    return response.json();
  }
  const me = await read('/users/me');
  assert.equal(me.tenant_id, fixture.tenantId);
  assert.equal(me.role, 'owner');
  const settings = await read('/tenant/settings');
  assert.equal(settings.name, fixture.marker);
  assert.equal(settings.tip_entry_mode, 'overpayment');
  assert.equal(settings.tse_mode, 'off');

  browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1440, height: 1100 });
  await page.evaluateOnNewDocument(() => localStorage.setItem('pos_language', 'en'));
  await page.setCookie({ name: 'access_token', value: fixture.token, url: base.origin,
    httpOnly: true, secure: base.protocol === 'https:', sameSite: 'Lax' });
  page.on('pageerror', () => pageErrors++);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base.origin) return void request.abort();
    if (staleTipOrderId && request.method() === 'GET' && url.pathname === '/api/orders') {
      try {
        const orders = await read(`/orders${url.search}`);
        assert(Array.isArray(orders));
        const found = orders.find(o => o.id === staleTipOrderId);
        if (found) { found.tip_amount_cents = 0; staleTipResponses++; }
        return void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(orders) });
      } catch { blockedWrites++; return void request.abort(); }
    }
    if (summaryFault && request.method() === 'GET'
      && url.pathname === `/api/orders/${summaryFault.orderId}/payments`) {
      const fault = summaryFault;
      summaryFault = null;
      return void request.respond({ status: fault.status, contentType: 'application/json',
        body: JSON.stringify(fault.status === 503 ? { detail: 'Synthetic summary failure' } : {}) });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      let allowed = false;
      try {
        const body = JSON.parse(request.postData() || '{}');
        allowed = request.method() === 'PUT' && body.payment_method === 'cash'
          && fixture.cases.some(c => url.pathname === `/api/orders/${c.orderId}/mark-paid`);
      } catch { /* No unrecognized writes. */ }
      if (!allowed) { blockedWrites++; return void request.abort(); }
      paymentRequests++;
    }
    return void request.continue();
  });
  async function input(selector, cents) {
    await page.$eval(selector, (element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, (cents / 100).toFixed(2));
  }
  const money = value => Math.round(Number(value.replace(',', '.')) * 100);
  for (const c of fixture.cases) {
    const spec = scenarios[c.name];
    const netBase = Math.max(0, spec.basket + spec.fee - 200);
    const beforeDue = netBase + spec.storedTip;
    stage = `${c.name}: canonical baseline`;
    const order = (await read('/orders')).find(o => o.id === c.orderId);
    assert(order && order.notes === fixture.marker && !order.paid_at);
    assert.equal(order.loyalty_discount_cents, 200);
    const before = await read(`/orders/${c.orderId}/payments`);
    assert.equal(before.amount_due_cents, beforeDue);
    assert.equal(before.amount_paid_cents, spec.prior);
    assert.equal(before.amount_remaining_cents, Math.max(0, beforeDue - spec.prior));
    const initialIds = before.payments.filter(p => !p.voided_at).map(p => p.id);
    assert.equal(initialIds.length, spec.prior ? 1 : 0);

    stage = `${c.name}: actual payment modal`;
    staleTipOrderId = c.name === 'delivery-prior' ? c.orderId : null;
    await page.goto(`${base.origin}/staff/orders`, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('button.filter-tab');
    if (spec.fee) {
      let found = false;
      for (const tab of await page.$$('button.filter-tab')) {
        if (/delivery/i.test(await tab.evaluate(el => el.textContent))) {
          await tab.click(); found = true; break;
        }
      }
      assert(found, 'Delivery tab unavailable');
    } else await page.click('button.filter-tab');
    await page.waitForSelector(`#order-card-${c.orderId}`);
    let opened = false;
    for (const button of await page.$$(`#order-card-${c.orderId} button`)) {
      if (/^pay now$/i.test(await button.evaluate(el => el.textContent.trim())) && await button.boundingBox()) {
        await button.click(); opened = true; break;
      }
    }
    assert(opened, 'Fixture Pay now control missing');
    await page.waitForSelector('#payment-amount-charged', { visible: true });
    await page.select('#payment-method', 'cash');
    await input('#payment-amount-charged', spec.entered);
    await page.waitForFunction(cents => Math.round(Number(document.querySelector('#payment-tip-amount')?.value) * 100) === cents, {}, spec.tip);
    assert.equal(money(await page.$eval('#payment-tip-amount', el => el.value)), spec.tip);
    const preview = await page.$eval('.payment-tip-preview', el =>
      (el.textContent.match(/\d+[.,]\d{2}/g) || []).map(v => Math.round(Number(v.replace(',', '.')) * 100)));
    assert.deepEqual(preview, [spec.tip, netBase + spec.tip]);
    const requestsBefore = paymentRequests;
    if (c.name === 'net-exact') {
      for (const [name, status] of [['failed-summary', 503], ['missing-summary', 200]]) {
        stage = `${name}: fail closed`;
        summaryFault = { orderId: c.orderId, status };
        const summaryResponse = page.waitForResponse(r => r.request().method() === 'GET'
          && new URL(r.url()).pathname === `/api/orders/${c.orderId}/payments`);
        await page.click('.modal:has(#payment-method) .modal-actions button.btn-primary');
        assert.equal((await summaryResponse).status(), status);
        await page.waitForSelector('#payment-method', { hidden: true });
        assert.equal(summaryFault, null);
        assert.equal(paymentRequests, requestsBefore, 'Unavailable summary must not submit payment');
        const untouched = await read(`/orders/${c.orderId}/payments`);
        assert.equal(untouched.amount_paid_cents, 0);
        assert.equal(untouched.payments.length, 0);
        assert(!(await read('/orders')).find(o => o.id === c.orderId).paid_at);
        report.cases.push({ name, result: 'PASS', ui_payment_requests: 0 });
        await page.waitForSelector(`#order-card-${c.orderId}`);
        await page.waitForFunction(id => [...document.querySelectorAll(`#order-card-${id} button`)]
          .some(button => /^pay now$/i.test(button.textContent.trim()) && button.getClientRects().length), {}, c.orderId);
        let reopened = false;
        for (const button of await page.$$(`#order-card-${c.orderId} button`)) {
          if (/^pay now$/i.test(await button.evaluate(el => el.textContent.trim())) && await button.boundingBox()) {
            await button.click(); reopened = true; break;
          }
        }
        assert(reopened, 'Pay now unavailable after rejected summary');
        await page.waitForSelector('#payment-amount-charged', { visible: true });
        await page.select('#payment-method', 'cash');
        await input('#payment-amount-charged', spec.entered);
      }
    }
    if (spec.reject) {
      stage = `${c.name}: UI rejection`;
      await page.click('.modal:has(#payment-method) .modal-actions button.btn-primary');
      // The validation toast is the completion signal; no timing-only pass.
      await page.waitForFunction(() => /amount charged must cover/i.test(document.body.innerText));
      assert.equal(paymentRequests, requestsBefore);
      assert(await page.$('#payment-method'));
      stage = `${c.name}: authoritative rejection`;
      const rejection = await page.evaluate(async ({ id, amount }) => {
        const r = await fetch(`/api/orders/${id}/mark-paid`, { method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payment_method: 'cash', tip_amount_cents: 0, amount_paid_cents: amount }) });
        return r.status;
      }, { id: c.orderId, amount: spec.entered });
      assert.equal(rejection, 400);
      const unchanged = await read(`/orders/${c.orderId}/payments`);
      assert.equal(unchanged.amount_paid_cents, 0);
      assert.equal(unchanged.amount_due_cents, netBase);
      assert.equal(unchanged.payments.filter(p => !p.voided_at).length, 0);
      assert(!(await read('/orders')).find(o => o.id === c.orderId).paid_at);
      report.cases.push({ name: c.name, order_id: c.orderId, result: 'PASS',
        ui_payment_requests: 0, backend_rejection_status: rejection, active_payment_amounts: [] });
      continue;
    }
    stage = `${c.name}: settlement`;
    const requestPromise = page.waitForRequest(r => r.method() === 'PUT'
      && new URL(r.url()).pathname === `/api/orders/${c.orderId}/mark-paid`);
    const responsePromise = page.waitForResponse(r => r.request().method() === 'PUT'
      && new URL(r.url()).pathname === `/api/orders/${c.orderId}/mark-paid`);
    await page.click('.modal:has(#payment-method) .modal-actions button.btn-primary');
    const body = JSON.parse((await requestPromise).postData());
    assert.equal(body.amount_paid_cents, spec.entered);
    assert.equal(body.tip_amount_cents, spec.tip);
    assert.equal((await responsePromise).status(), 200);
    await page.waitForSelector('#payment-method', { hidden: true });
    const after = await read(`/orders/${c.orderId}/payments`);
    const active = after.payments.filter(p => !p.voided_at);
    const expected = [...(spec.prior ? [spec.prior] : []), spec.entered].sort((a, b) => a - b);
    assert.deepEqual(active.map(p => p.amount_cents).sort((a, b) => a - b), expected);
    assert.equal(active.filter(p => !initialIds.includes(p.id)).length, 1);
    assert(active.every(p => p.payment_method === 'cash' && !p.stripe_payment_intent_id));
    assert.equal(after.amount_due_cents, netBase + spec.tip);
    assert.equal(after.amount_paid_cents, spec.prior + spec.entered);
    assert.equal(after.amount_remaining_cents, 0);
    const settled = (await read('/orders')).find(o => o.id === c.orderId);
    assert(settled.paid_at);
    assert.equal(settled.tip_amount_cents || 0, spec.tip);
    assert.equal(settled.loyalty_discount_cents, 200);
    assert.equal(paymentRequests, requestsBefore + 1);
    if (c.name === 'delivery-prior') assert(staleTipResponses > 0, 'Stale initial tip response was not exercised');
    report.cases.push({ name: c.name, order_id: c.orderId, result: 'PASS', entered_cents: spec.entered,
      tip_cents: spec.tip, due_cents: after.amount_due_cents, active_payment_amounts: expected,
      ignored_voided_cents: spec.voided || 0, new_payment_rows: 1 });
  }
  assert.equal(pageErrors, 0);
  assert.equal(blockedWrites, 0);
  report.result = 'PASS';
} catch (error) {
  report.stage = stage;
  report.error_type = error.name;
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  report.blocked_writes = blockedWrites;
  report.page_errors = pageErrors;
  report.provider_calls = 0;
  report.completed_utc = new Date().toISOString();
  console.log(JSON.stringify(report));
}
