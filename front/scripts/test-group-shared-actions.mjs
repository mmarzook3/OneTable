#!/usr/bin/env node
/**
 * Shared-group write-action regression. Existing Docker Chromium/Puppeteer only.
 * Run with --execute --allow-synthetic; pass a fresh private fixture on stdin.
 * Fixture schema: { synthetic:true, run_id, target:'local'|'vps', base_url,
 *   group_id, catalog_id, catalog_name, owner_token,
 *   source:{tenant_id,customer_id,customer_name,product_id},
 *   own:{tenant_id,customer_id,customer_name} }.
 *
 * Mutations are limited to the fixture's own CRM row and newly created local
 * TenantProduct. The shared CRM/product are never mutation targets. Fixture
 * cleanup belongs to the caller, including when an assertion fails; sanitized
 * fixture IDs are emitted for that purpose. No credentials or URLs are logged.
 * Category options are fixture-only; catalog/CRM/product responses are real.
 * Durable seed/cleanup helper and private PowerShell invocation:
 * scripts/phase3-group-actions-fixture.py (from the repository root).
 * Do not save or print the seed output; it contains a short-lived JWT.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

async function main() {
  let browser;
  let stage = 'configuration';
  let createdProductId = null;
  const report = { result: 'FAIL', passed: [], unexpected_mutations_blocked: 0 };
  try {
    assert.deepEqual(process.argv.slice(2).sort(), ['--allow-synthetic', '--execute']);
    const fixture = JSON.parse(readFileSync(0, 'utf8'));
    assert.equal(fixture.synthetic, true);
    assert.match(fixture.run_id, /^[a-f0-9]{32}$/);
    const base = new URL(fixture.base_url);
    assert.equal(base.pathname, '/');
    assert(!base.username && !base.password && !base.search && !base.hash);
    if (fixture.target === 'local') {
      assert.equal(base.protocol, 'http:');
      assert(['haproxy', 'localhost', '127.0.0.1', 'host.docker.internal'].includes(base.hostname));
    } else {
      assert.equal(fixture.target, 'vps');
      assert.equal(base.origin, 'https://scanaki.uk');
    }
    for (const id of [fixture.group_id, fixture.catalog_id, fixture.source.tenant_id,
      fixture.source.customer_id, fixture.source.product_id, fixture.own.tenant_id,
      fixture.own.customer_id]) assert(Number.isSafeInteger(id) && id > 0);
    assert.notEqual(fixture.source.tenant_id, fixture.own.tenant_id);
    assert(![fixture.source.tenant_id, fixture.own.tenant_id].includes(23));
    assert.equal(fixture.catalog_name, `Synthetic Group Actions Catalog ${fixture.run_id}`);
    assert.equal(fixture.source.customer_name, `Synthetic Group Actions CRM A ${fixture.run_id}`);
    assert.equal(fixture.own.customer_name, `Synthetic Group Actions CRM B ${fixture.run_id}`);
    assert(typeof fixture.owner_token === 'string' && fixture.owner_token.length > 30);
    report.target = fixture.target;
    report.fixture = {
      run_id: fixture.run_id, group_id: fixture.group_id, catalog_id: fixture.catalog_id,
      tenant_ids: [fixture.source.tenant_id, fixture.own.tenant_id],
      source_customer_id: fixture.source.customer_id, own_customer_id: fixture.own.customer_id,
      source_product_id: fixture.source.product_id,
    };

    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (/^(data|blob):/.test(request.url())) return void request.continue();
      if (url.origin !== base.origin) return void request.abort();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        let permitted = false;
        if (url.pathname === `/api/billing-customers/${fixture.own.customer_id}`) {
          permitted = ['PUT', 'DELETE'].includes(request.method());
        } else if (url.pathname === '/api/tenant-products' && request.method() === 'POST') {
          try {
            const body = JSON.parse(request.postData() || '{}');
            permitted = body.catalog_id === fixture.catalog_id && body.provider_product_id == null;
          } catch { /* Refuse malformed payloads. */ }
        } else if (createdProductId && request.method() === 'DELETE') {
          permitted = url.pathname === `/api/tenant-products/${createdProductId}`;
        }
        if (!permitted) {
          report.unexpected_mutations_blocked++;
          return void request.abort();
        }
      }
      if (url.pathname === '/api/catalog' || url.pathname === '/api/billing-customers') {
        url.searchParams.set('search', fixture.run_id);
        return void request.continue({ url: url.href });
      }
      if (url.pathname === '/api/catalog/categories') {
        return void request.respond({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ 'Synthetic Group Actions': [] }),
        });
      }
      return void request.continue();
    });
    await page.setCookie({
      name: 'access_token', value: fixture.owner_token, url: base.origin,
      httpOnly: true, sameSite: 'Lax', secure: base.protocol === 'https:',
    });

    async function get(path) {
      return page.evaluate(async endpoint => {
        const response = await fetch(`/api${endpoint}`, { redirect: 'error' });
        return { status: response.status, body: await response.json() };
      }, path);
    }
    async function customerRow(name) {
      const handle = await page.evaluateHandle(value =>
        [...document.querySelectorAll('app-customers tbody tr')].find(row =>
          row.querySelector('td')?.textContent?.trim() === value), name);
      const element = handle.asElement();
      assert(element, 'Expected fixture CRM row');
      return element;
    }
    async function card() {
      const handle = await page.evaluateHandle(name =>
        [...document.querySelectorAll('app-catalog .catalog-card')].find(row =>
          row.querySelector('h3')?.textContent?.trim() === name), fixture.catalog_name);
      const element = handle.asElement();
      assert(element, 'Expected fixture catalog card');
      return element;
    }
    async function waitCustomerName(name, present) {
      await page.waitForFunction(({ value, expected }) =>
        [...document.querySelectorAll('app-customers tbody tr')].some(row =>
          row.querySelector('td')?.textContent?.trim() === value) === expected,
      {}, { value: name, expected: present });
    }
    function waitResponse(path, method) {
      return page.waitForResponse(response => new URL(response.url()).pathname === `/api${path}`
        && response.request().method() === method).catch(() => null);
    }

    stage = 'fixture identity and shared CRM';
    await page.goto(`${base.origin}/customers`, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('app-customers tbody tr');
    const me = await get('/users/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.tenant_id, fixture.own.tenant_id);
    assert.equal(me.body.role, 'owner');
    const group = await get('/restaurant-group');
    assert.equal(group.status, 200);
    assert.equal(group.body.id, fixture.group_id);
    assert.equal(group.body.name, `Synthetic Group Actions ${fixture.run_id}`);
    assert(group.body.share_products && group.body.share_customers);
    assert.deepEqual(group.body.members.map(member => member.tenant_id).sort((a, b) => a - b),
      [...report.fixture.tenant_ids].sort((a, b) => a - b));
    const customers = await get('/billing-customers');
    assert.equal(customers.status, 200);
    assert.equal(customers.body.length, 2);
    const shared = customers.body.find(row => row.id === fixture.source.customer_id);
    const own = customers.body.find(row => row.id === fixture.own.customer_id);
    assert.equal(shared?.name, fixture.source.customer_name);
    assert.equal(shared?.is_shared, true);
    assert.equal(own?.name, fixture.own.customer_name);
    assert(!own.is_shared);
    assert.equal(await (await customerRow(shared.name)).$$eval('.actions button', buttons => buttons.length), 0);
    const ownRow = await customerRow(own.name);
    assert(await ownRow.$('.actions button:not(.icon-btn-danger)'));
    assert(await ownRow.$('.actions .icon-btn-danger'));
    report.passed.push('Shared CRM Edit/Delete absent; own actions present');

    stage = 'own CRM edit opens';
    await (await ownRow.$('.actions button:not(.icon-btn-danger)')).click();
    await page.waitForSelector('#cust-name', { visible: true });
    const editedName = `${fixture.own.customer_name} edited`;
    // Avoid racing the modal's focus/select directive with simulated keystrokes.
    await page.$eval('#cust-name', (input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, editedName);
    await page.waitForFunction(value => document.querySelector('#cust-name')?.value === value, {}, editedName);
    stage = 'own CRM edit saves';
    const editResponse = waitResponse(`/billing-customers/${own.id}`, 'PUT');
    await page.click('app-customers .modal-actions button[type=submit]');
    report.own_crm_edit_http_status = (await editResponse)?.status();
    assert.equal(report.own_crm_edit_http_status, 200);
    const edited = await get(`/billing-customers/${own.id}`);
    assert.equal(edited.status, 200);
    assert.equal(edited.body.name, editedName);
    stage = 'own CRM edit renders';
    await waitCustomerName(editedName, true);
    report.passed.push('Own CRM edit succeeds through UI');

    stage = 'own CRM delete';
    await (await (await customerRow(editedName)).$('.actions .icon-btn-danger')).click();
    await page.waitForSelector('app-customers .modal-sm .btn-danger', { visible: true });
    const deleteResponse = waitResponse(`/billing-customers/${own.id}`, 'DELETE');
    await page.click('app-customers .modal-sm .btn-danger');
    const deleted = await deleteResponse;
    assert(deleted?.ok());
    await waitCustomerName(editedName, false);
    await waitCustomerName(fixture.source.customer_name, true);
    const afterCustomers = await get('/billing-customers');
    assert.equal(afterCustomers.status, 200);
    assert(!afterCustomers.body.some(row => row.id === own.id));
    assert.equal(afterCustomers.body.find(row => row.id === shared.id)?.name, shared.name);
    report.passed.push('Own CRM delete succeeds and shared CRM survives');

    stage = 'shared-only catalog action';
    await page.goto(`${base.origin}/catalog`, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('app-catalog .catalog-card');
    const beforeProducts = await get('/tenant-products?active_only=true');
    assert.equal(beforeProducts.status, 200);
    const source = beforeProducts.body.find(product => product.id === fixture.source.product_id);
    assert(source && source.tenant_id === fixture.source.tenant_id && source.catalog_id === fixture.catalog_id);
    assert.equal(source.is_active, true);
    assert(!beforeProducts.body.some(product => product.tenant_id === fixture.own.tenant_id
      && product.catalog_id === fixture.catalog_id && product.is_active));
    const sharedCard = await card();
    assert.equal(await sharedCard.$('.btn-remove-menu'), null);
    assert(await sharedCard.$('.catalog-actions .btn-primary'));
    report.passed.push('Shared-only catalog offers Add local, not Remove');

    stage = 'add local catalog copy';
    await (await sharedCard.$('.catalog-actions .btn-primary')).click();
    await page.waitForSelector('app-catalog .modal-content input[type=number]', { visible: true });
    await page.type('app-catalog .modal-content input[type=number]', '6.00');
    const addResponse = waitResponse('/tenant-products', 'POST');
    await page.click('app-catalog .modal-content .modal-actions .btn-primary');
    const added = await addResponse;
    assert(added?.ok());
    report.catalog_add_http_status = added.status();
    // Like the component, reload the authoritative list after creation. The
    // create response need not expose the ownership fields used by this check.
    const reloadedProducts = await get('/tenant-products?active_only=true');
    assert.equal(reloadedProducts.status, 200);
    const ownCopies = reloadedProducts.body.filter(row => row.tenant_id === fixture.own.tenant_id
      && row.catalog_id === fixture.catalog_id && row.is_active);
    assert.equal(ownCopies.length, 1);
    const product = ownCopies[0];
    assert(Number.isSafeInteger(product.id) && product.id > 0);
    assert.equal(product.tenant_id, fixture.own.tenant_id);
    assert.equal(product.catalog_id, fixture.catalog_id);
    assert.notEqual(product.id, source.id);
    createdProductId = product.id;
    report.fixture.created_local_product_id = createdProductId;
    await page.waitForSelector('app-catalog .catalog-card .btn-remove-menu');
    report.passed.push('Local catalog copy created for current tenant');

    stage = 'remove only local catalog copy';
    const removalRequest = page.waitForRequest(request => request.method() === 'DELETE'
      && new URL(request.url()).pathname.startsWith('/api/tenant-products/'));
    const removalResponse = waitResponse(`/tenant-products/${createdProductId}`, 'DELETE');
    await (await (await card()).$('.btn-remove-menu')).click();
    assert.equal(new URL((await removalRequest).url()).pathname, `/api/tenant-products/${createdProductId}`);
    assert((await removalResponse)?.ok());
    await page.waitForFunction(() => !!document.querySelector('app-catalog .catalog-card .catalog-actions .btn-primary')
      && !document.querySelector('app-catalog .catalog-card .btn-remove-menu'));
    const afterProducts = await get('/tenant-products?active_only=true');
    assert.equal(afterProducts.status, 200);
    assert(!afterProducts.body.some(row => row.id === createdProductId && row.is_active));
    const preserved = afterProducts.body.find(row => row.id === source.id);
    assert(preserved?.is_active);
    assert.equal(preserved.tenant_id, source.tenant_id);
    assert.equal(preserved.price_cents, source.price_cents);
    report.passed.push('Remove targets own TenantProduct; sibling remains active; Add local returns');
    assert.equal(report.unexpected_mutations_blocked, 0);
    report.result = 'PASS';
    report.scope = 'Actual own/shared CRM and catalog UI actions; no providers, invoices or identity switching';
    report.category_options_stubbed = true;
  } catch (error) {
    report.stage = stage;
    report.error_type = error.name;
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    report.completed_utc = new Date().toISOString();
    console.log(JSON.stringify(report));
  }
}

await main();
