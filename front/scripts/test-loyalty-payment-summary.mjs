/**
 * Real staff UI regression; fixtures must be created and cleaned up by the caller.
 * Pipe private JSON on stdin: { synthetic: true, marker, tenantId, token,
 * cases: [{ name, orderId, memberId, memberToken, delivery, pay, beforeDue,
 * afterDue, paid, fee, tip, basket? }] }. Never put tokens in command arguments.
 * The summary-failure case injects one browser-only GET failure after redemption.
 * modal-switch also supplies switchOrderId and switchMemberToken for untouched B.
 * Required: BASE_URL. Docker Chromium is the default; no installs or screenshots.
 * Remote execution additionally requires --allow-remote-synthetic and scanaki.uk.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const results = [];
let browser;
let context;
let stage = 'configuration';
let pageErrors = 0;
let blockedWrites = 0;
let summaryFault = null;
const redemptionCounts = new Map();
let paymentRequests = 0;
try {
  const input = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
  const base = new URL(process.env.BASE_URL);
  assert.equal(base.href, `${base.origin}/`);
  const local = base.protocol === 'http:' && ['localhost', '127.0.0.1', 'haproxy'].includes(base.hostname);
  assert(local || (base.origin === 'https://scanaki.uk' && process.argv.includes('--allow-remote-synthetic')));
  assert.equal(input.synthetic, true);
  assert(/^Phase3 Staff Loyalty [a-f0-9]{32}$/.test(input.marker));
  assert(Number.isSafeInteger(input.tenantId) && ![1, 23, 25].includes(input.tenantId));
  assert(typeof input.token === 'string' && input.token.length > 20);
  assert(Array.isArray(input.cases) && input.cases.length >= 1 && input.cases.length <= 5);
  assert.equal(new Set(input.cases.map(c => c.orderId)).size, input.cases.length);
  for (const c of input.cases) {
    assert(Number.isSafeInteger(c.orderId) && ![147, 157].includes(c.orderId));
    assert(Number.isSafeInteger(c.memberId) && typeof c.memberToken === 'string');
    assert(['basic', 'fee-tip-paid', 'oversized-reward', 'summary-failure', 'modal-switch'].includes(c.name));
    if (c.name === 'modal-switch') {
      assert(Number.isSafeInteger(c.switchOrderId) && ![147, 157].includes(c.switchOrderId));
      assert(!input.cases.some(other => other.orderId === c.switchOrderId));
      assert(typeof c.switchMemberToken === 'string' && c.switchMemberToken !== c.memberToken);
    }
    for (const field of ['beforeDue', 'afterDue', 'paid', 'fee', 'tip']) {
      assert(Number.isSafeInteger(c[field]) && c[field] >= 0);
    }
    assert(Number.isSafeInteger(c.basket ?? 500) && (c.basket ?? 500) > 0);
    assert.equal(c.beforeDue, (c.basket ?? 500) + c.fee + c.tip);
    assert.equal(c.afterDue, Math.max(0, (c.basket ?? 500) + c.fee - 200) + c.tip);
    if (c.pay) {
      assert.equal(c.name, 'basic');
      assert.equal(c.beforeDue, 500);
      assert.equal(c.afterDue, 300);
      assert.equal(c.paid + c.fee + c.tip, 0);
    }
  }

  async function read(path) {
    const response = await fetch(`${base.origin}/api${path}`, {
      headers: { Authorization: `Bearer ${input.token}` }, redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, 'Authenticated fixture read failed');
    return response.json();
  }
  stage = 'verify synthetic identity';
  const me = await read('/users/me');
  assert.equal(me.tenant_id, input.tenantId);
  assert.equal(me.role, 'owner');
  const settings = await read('/tenant/settings');
  assert.equal(settings.name, input.marker);
  assert.equal(settings.tse_mode, 'off');
  const program = await read('/loyalty/program');
  assert.equal(program.wallet_passes_enabled, false);
  assert.equal(program.reward_discount_cents, 200);

  browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  page.setDefaultTimeout(20000);
  await page.evaluateOnNewDocument(() => localStorage.setItem('pos_language', 'en'));
  await page.setCookie({ name: 'access_token', value: input.token, url: base.origin,
    httpOnly: true, secure: base.protocol === 'https:', sameSite: 'Lax' });
  page.on('pageerror', () => pageErrors++);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== base.origin) return request.abort();
    if (summaryFault && request.method() === 'GET' &&
        url.pathname === `/api/orders/${summaryFault.orderId}/payments` && !summaryFault.request) {
      summaryFault.request = request;
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      if (url.pathname.endsWith('/mark-paid') || url.pathname.endsWith('/payments')) paymentRequests++;
      if (url.pathname.endsWith('/loyalty/redeem')) {
        redemptionCounts.set(url.pathname, (redemptionCounts.get(url.pathname) || 0) + 1);
      }
      let allowed = false;
      try {
        const body = JSON.parse(request.postData() || '{}');
        allowed = input.cases.some(c =>
          (request.method() === 'POST' && url.pathname === `/api/orders/${c.orderId}/loyalty/redeem` && body.member_token === c.memberToken) ||
          (c.pay && request.method() === 'PUT' && url.pathname === `/api/orders/${c.orderId}/mark-paid` && body.payment_method === 'cash'));
      } catch { /* Reject unknown writes. */ }
      if (!allowed) { blockedWrites++; return request.abort(); }
    }
    return request.continue();
  });

  async function summaryAmounts() {
    return page.$eval('[data-testid="split-pay-summary"] > p', element =>
      (element.textContent.match(/\d+[.,]\d{2}/g) || []).map(value => Math.round(Number(value.replace(',', '.')) * 100)));
  }
  for (const c of input.cases) {
    stage = `${c.name}: initial persisted amounts`;
    const before = (await read('/orders')).find(order => order.id === c.orderId);
    assert(before && before.notes === input.marker && !before.paid_at);
    assert.equal(before.amount_due_cents, c.beforeDue, 'Initial amount due mismatch');
    assert.equal(before.amount_paid_cents || 0, c.paid, 'Initial paid amount mismatch');
    // Some order-list serializers omit the separate fee field. Its contribution
    // must still be present in the authoritative reconciliation amount.
    if (before.delivery_fee_cents != null) assert.equal(before.delivery_fee_cents, c.fee);
    assert.equal(before.tip_amount_cents || 0, c.tip, 'Initial tip mismatch');
    const lineSubtotal = before.items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0);
    assert.equal(lineSubtotal, c.basket ?? 500, 'Expected synthetic basket');
    assert.equal(before.amount_due_cents, lineSubtotal + c.fee + c.tip);
    await page.goto(`${base.origin}/staff/orders`, { waitUntil: 'networkidle2', timeout: 30000 });
    if (c.delivery) {
      await page.waitForSelector('button.filter-tab');
      const tabs = await page.$$('button.filter-tab');
      let selected = false;
      for (const tab of tabs) {
        if (/delivery/i.test(await tab.evaluate(el => el.textContent))) { await tab.click(); selected = true; break; }
      }
      assert(selected, 'Delivery tab missing');
    } else {
      await page.waitForSelector('button.filter-tab');
      await page.click('button.filter-tab');
    }
    stage = `${c.name}: open payment modal`;
    await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(el => /^pay now$/i.test(el.textContent.trim())));
    const buttons = await page.$$(`#order-card-${c.orderId} button`);
    let opened = false;
    for (const button of buttons) {
      if (/^pay now$/i.test(await button.evaluate(el => el.textContent.trim())) && await button.boundingBox()) {
        await button.click(); opened = true; break;
      }
    }
    assert(opened, 'Visible Pay now control missing');
    await page.waitForSelector('#payment-method', { visible: true });
    assert(await page.$eval('.modal:has(#payment-method)', (el, id) => new RegExp(`#?${id}\\b`).test(el.textContent), c.orderId), 'Wrong order payment modal');
    const expectedSummary = due => c.paid ? [due, c.paid, due - c.paid] : [due];
    assert.deepEqual(await summaryAmounts(), expectedSummary(c.beforeDue), 'Initial displayed reconciliation mismatch');

    stage = `${c.name}: displayed redemption amounts before payment`;
    await page.type('#loyalty-member-token', c.memberToken);
    const paymentsBefore = paymentRequests;
    if (['summary-failure', 'modal-switch'].includes(c.name)) summaryFault = { orderId: c.orderId, request: null };
    const redemption = page.waitForResponse(r => new URL(r.url()).pathname === `/api/orders/${c.orderId}/loyalty/redeem` && r.request().method() === 'POST');
    await page.click('[data-testid="loyalty-redeem-block"] button');
    const redeemed = await redemption;
    assert.equal(redeemed.status(), 200, 'UI redemption failed');
    const reward = await redeemed.json();
    assert.equal(reward.membership_id, c.memberId);
    assert.equal(reward.discount_cents, 200);
    if (summaryFault) {
      stage = `${c.name}: payment blocked while authoritative GET is pending`;
      const deadline = Date.now() + 10000;
      while (!summaryFault.request && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert(summaryFault.request, 'Authoritative summary GET not requested');
      if (c.name === 'modal-switch') {
        stage = 'modal-switch: A consumed token cleared while summary is held';
        await page.waitForFunction(() => document.querySelector('#loyalty-member-token')?.value === '');
        const beforeB = (await read('/orders')).find(order => order.id === c.switchOrderId);
        assert(beforeB && beforeB.notes === input.marker && !beforeB.paid_at && !beforeB.loyalty_membership_id);
        await page.click('.modal:has(#payment-method) .modal-actions button.btn-secondary');
        await page.waitForSelector('#payment-method', { hidden: true });
        const bButtons = await page.$$(`#order-card-${c.switchOrderId} button`);
        let openedB = false;
        for (const button of bButtons) {
          if (/^pay now$/i.test(await button.evaluate(el => el.textContent.trim())) && await button.boundingBox()) {
            await button.click(); openedB = true; break;
          }
        }
        assert(openedB, 'Order B Pay now control missing');
        await page.waitForSelector('#loyalty-member-token', { visible: true });
        assert.equal(await page.$eval('#loyalty-member-token', el => el.value), '', 'A token leaked into B');
        const bSummary = await summaryAmounts();
        assert.deepEqual(bSummary, [beforeB.amount_due_cents]);
        await page.type('#loyalty-member-token', c.switchMemberToken);
        stage = 'modal-switch: late A summary must preserve B modal, summary and new token';
        const heldRequest = summaryFault.request;
        summaryFault = null;
        const completedA = page.waitForResponse(r => new URL(r.url()).pathname === `/api/orders/${c.orderId}/payments` && r.request().method() === 'GET');
        await heldRequest.continue();
        const responseA = await completedA;
        assert.equal(responseA.status(), 200);
        assert.equal((await responseA.json()).amount_due_cents, c.afterDue);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert(await page.$('#payment-method'), 'Late A response closed B modal');
        assert(await page.$eval('.modal:has(#payment-method)', (el, id) => new RegExp(`#?${id}\\b`).test(el.textContent), c.switchOrderId), 'Late A response replaced B modal');
        assert.deepEqual(await summaryAmounts(), bSummary, 'Late A response overwrote B summary');
        assert.equal(await page.$eval('#loyalty-member-token', el => el.value), c.switchMemberToken, 'Late A response cleared new B token');
        assert.equal(redemptionCounts.get(`/api/orders/${c.switchOrderId}/loyalty/redeem`) || 0, 0);
        assert.equal(redemptionCounts.get(`/api/orders/${c.orderId}/loyalty/redeem`), 1);
        assert.equal(paymentRequests, paymentsBefore);
        const afterB = (await read('/orders')).find(order => order.id === c.switchOrderId);
        assert.deepEqual(afterB, beforeB, 'Order B changed on the backend');
        await page.click('.modal:has(#payment-method) .modal-actions button.btn-secondary');
        results.push({ case: c.name, result: 'PASS', real_summary_get_status: 200,
          consumed_A_token_cleared: true, no_A_token_in_B: true, B_modal_preserved: true,
          B_summary_preserved: bSummary, new_B_token_preserved: true,
          A_redemptions: 1, B_redemptions: 0, payment_requests: 0, B_backend_unchanged: true });
        continue;
      }
      await page.waitForFunction(() => document.querySelector('.modal:has(#payment-method) .modal-actions button.btn-primary')?.disabled === true);
      assert.equal(await page.$eval('[data-testid="loyalty-redeem-block"] button', el => el.disabled), true);
      await page.click('.modal:has(#payment-method) .modal-actions button.btn-primary');
      assert.equal(paymentRequests, paymentsBefore, 'Payment attempted with stale summary');
      const heldRequest = summaryFault.request;
      summaryFault = null;
      await heldRequest.respond({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ detail: 'Synthetic summary GET failure' }) });
      await page.waitForSelector('#payment-method', { hidden: true });
      const canonical = await read(`/orders/${c.orderId}/payments`);
      assert.equal(canonical.amount_due_cents, c.afterDue);
      assert.equal(canonical.amount_paid_cents, c.paid);
      assert.equal(redemptionCounts.get(`/api/orders/${c.orderId}/loyalty/redeem`), 1);
      assert.equal(paymentRequests, paymentsBefore);
      results.push({ case: c.name, result: 'PASS', injected_browser_get_status: 503,
        pending_payment_disabled: true, modal_closed: true, redemption_requests: 1,
        payment_requests: 0, authoritative_due_cents: canonical.amount_due_cents });
      continue;
    }
    await page.waitForSelector('[data-testid="loyalty-discount-line"]', { visible: true });
    assert.deepEqual(await summaryAmounts(), expectedSummary(c.afterDue), 'Displayed due/paid/remaining stale after redemption');
    const after = (await read('/orders')).find(order => order.id === c.orderId);
    assert.equal(after.amount_due_cents, c.afterDue);
    assert.equal(after.amount_remaining_cents, c.afterDue - c.paid);
    assert.equal(after.amount_paid_cents || 0, c.paid);
    if (after.delivery_fee_cents != null) assert.equal(after.delivery_fee_cents, c.fee);
    assert.equal(after.tip_amount_cents || 0, c.tip);
    assert.equal(after.loyalty_membership_id, c.memberId);

    if (c.pay) {
      stage = `${c.name}: actual cash payment`;
      await page.select('#payment-method', 'cash');
      const settlement = page.waitForResponse(r => new URL(r.url()).pathname === `/api/orders/${c.orderId}/mark-paid` && r.request().method() === 'PUT');
      await page.click('.modal:has(#payment-method) .modal-actions button.btn-primary');
      const response = await settlement;
      assert.equal(response.status(), 200, 'Cash modal settlement failed');
      const paid = await response.json();
      assert.equal(paid.payment_method, 'cash');
      assert.equal(paid.amount_paid_cents, 300);
      assert.equal(paid.amount_remaining_cents, 0);
      await page.waitForSelector('#payment-method', { hidden: true });
      const ledger = await read(`/orders/${c.orderId}/payments`);
      assert.equal(ledger.amount_paid_cents, 300);
      assert.equal(ledger.amount_remaining_cents, 0);
    } else {
      await page.click('.modal:has(#payment-method) .modal-actions button.btn-secondary');
    }
    results.push({ case: c.name, result: 'PASS', displayed_before: expectedSummary(c.beforeDue),
      displayed_after: expectedSummary(c.afterDue), fee_cents: c.fee, tip_cents: c.tip,
      paid_before_cents: c.paid, cash_settlement_cents: c.pay ? 300 : null });
  }
  assert.equal(pageErrors, 0, 'Browser runtime errors');
  assert.equal(blockedWrites, 0, 'Unexpected application mutation attempted');
  console.log(JSON.stringify({ result: 'PASS', results, page_errors: pageErrors, provider_calls: 0,
    cleanup: 'Caller must remove its synthetic fixtures' }));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', stage, reason: error.name,
    detail: error.message?.split('\n')[0].slice(0, 160), results,
    page_errors: pageErrors, blocked_writes: blockedWrites }));
  process.exitCode = 1;
} finally {
  if (summaryFault?.request) await summaryFault.request.abort().catch(() => {});
  if (context) await context.close();
  if (browser) await browser.close();
}
