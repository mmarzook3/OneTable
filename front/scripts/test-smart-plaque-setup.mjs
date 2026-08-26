#!/usr/bin/env node
/**
 * Real-browser smoke for permanent plaque inventory -> table assignment ->
 * mocked Android Web NFC write/read-back -> public plaque resolution.
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

async function login(page, path, email, password) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.type('input#email', email);
  await page.type('input#password', password);
  await page.click('button[type="submit"]');
}

async function api(page, path, options = {}) {
  return page.evaluate(
    async ({ baseUrl, apiPath, requestOptions }) => {
      const response = await fetch(`${baseUrl}/api${apiPath}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(requestOptions.headers || {}) },
        ...requestOptions,
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: response.status, body };
    },
    { baseUrl: BASE_URL, apiPath: path, requestOptions: options },
  );
}

async function main() {
  const stamp = Date.now();
  const restaurantName = `Smart Plaque Smoke ${stamp}`;
  const ownerEmail = `smart-plaque-smoke-${stamp}@amvara.de`;
  const permanentPassword = `Smart-plaque-owner-${stamp}`;
  let plaqueId = null;
  let tenantCreated = false;

  const browser = process.env.PUPPETEER_WS_ENDPOINT
    ? await puppeteer.connect({ browserWSEndpoint: process.env.PUPPETEER_WS_ENDPOINT })
    : process.env.PUPPETEER_CONNECT_URL
      ? await puppeteer.connect({ browserURL: process.env.PUPPETEER_CONNECT_URL })
      : await puppeteer.launch({
          headless: isHeadless(),
          executablePath: CHROME_PATH,
          defaultViewport: { width: 1280, height: 900 },
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('[pageerror]', error.message));
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en' });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('pos_language', 'en');
    class TestNDEFReader {
      onreading = null;
      onreadingerror = null;
      async write(message) {
        window.__smartPlaqueNfcUrl = message.records[0].data;
      }
      async scan() {
        const url = window.__smartPlaqueNfcUrl || '';
        setTimeout(() => {
          const bytes = new TextEncoder().encode(url);
          this.onreading?.({
            message: {
              records: [{
                recordType: 'url',
                encoding: 'utf-8',
                data: new DataView(bytes.buffer),
              }],
            },
          });
        }, 30);
      }
    }
    Object.defineProperty(window, 'NDEFReader', { configurable: true, value: TestNDEFReader });
  });

  try {
    console.log('1. Create a permanent plaque from the platform inventory');
    await login(page, '/platform/login', OPERATOR_EMAIL, OPERATOR_PASSWORD);
    await page.waitForFunction(() => window.location.pathname === '/platform', { timeout: 15000 });
    await page.click('[data-testid="platform-smart-plaques-link"]');
    await page.waitForSelector('[data-testid="smart-plaque-batch-form"]', { timeout: 15000 });
    await page.click('[data-testid="smart-plaque-batch-count"]', { clickCount: 3 });
    await page.type('[data-testid="smart-plaque-batch-count"]', '1');
    await page.type('[data-testid="smart-plaque-batch-label"]', `Smoke ${stamp}`);
    await page.click('[data-testid="smart-plaque-generate"]');
    await page.waitForFunction(
      (label) => Array.from(document.querySelectorAll('[data-testid="smart-plaque-row"]'))
        .some((row) => row.textContent?.includes(label)),
      { timeout: 15000 },
      `Smoke ${stamp}`,
    );
    const plaque = await api(page, `/platform/smart-plaques?batch_label=${encodeURIComponent(`Smoke ${stamp}`)}`);
    if (plaque.status !== 200 || plaque.body.length !== 1) throw new Error('Plaque inventory creation failed');
    plaqueId = plaque.body[0].id;
    const publicCode = plaque.body[0].public_code;
    const publicUrl = plaque.body[0].public_url;

    console.log('2. Provision a restaurant and complete minimum onboarding');
    const provisioned = await api(page, '/platform/tenants', {
      method: 'POST',
      body: JSON.stringify({
        restaurant_name: restaurantName,
        owner_name: 'Smart Plaque Owner',
        owner_email: ownerEmail,
      }),
    });
    if (provisioned.status !== 201) throw new Error(`Restaurant provision failed: ${JSON.stringify(provisioned.body)}`);
    tenantCreated = true;

    await api(page, '/logout', { method: 'POST', body: '{}' });
    await login(page, '/login', provisioned.body.username, provisioned.body.temporary_password);
    await page.waitForFunction(() => window.location.pathname === '/onboarding', { timeout: 20000 });

    const setupCalls = [
      ['/onboarding/password', 'PUT', { new_password: permanentPassword }],
      ['/onboarding/business', 'PUT', {
        restaurant_name: restaurantName,
        business_type: 'restaurant',
        owner_name: 'Smart Plaque Owner',
        business_email: ownerEmail,
        phone: '+442071838750',
        address: '1 High Street, London',
      }],
      ['/onboarding/operations', 'PUT', {
        days_open: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        opening_time: '11:00',
        closing_time: '22:00',
      }],
      ['/onboarding/tables', 'POST', {
        floor_name: 'Main', table_prefix: 'Table ', table_count: 1, seats_per_table: 4,
      }],
      ['/onboarding/starter-products', 'POST', {
        products: [{ name: 'Coffee', price_cents: 250, enabled: true }],
      }],
      ['/onboarding/progress', 'PUT', { current_step: 5 }],
      ['/onboarding/complete', 'POST', {}],
    ];
    for (const [path, method, body] of setupCalls) {
      const response = await api(page, path, { method, body: JSON.stringify(body) });
      if (response.status !== 200) throw new Error(`${path} failed: ${JSON.stringify(response.body)}`);
    }

    console.log('3. Scan-code fallback assigns the reusable plaque to Table 1');
    await page.goto(`${BASE_URL}/tables`, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForSelector('[data-testid="setup-smart-plaque"]', { timeout: 15000 });
    await page.click('[data-testid="setup-smart-plaque"]');
    await page.waitForSelector('[data-testid="smart-plaque-scan-step"]');
    await page.type('[data-testid="smart-plaque-code-input"]', publicCode);
    await page.click('[data-testid="check-smart-plaque-code"]');
    await page.waitForSelector('[data-testid="smart-plaque-confirm-step"]', { timeout: 15000 });
    await page.click('[data-testid="confirm-plaque-assignment"]');
    await page.waitForSelector('[data-testid="smart-plaque-nfc-step"]', { timeout: 15000 });

    console.log('4. Android Web NFC write and read-back verification');
    await page.click('[data-testid="write-smart-plaque-nfc"]');
    await page.waitForSelector('[data-testid="verify-smart-plaque-nfc"]', { timeout: 15000 });
    await page.click('[data-testid="verify-smart-plaque-nfc"]');
    await page.waitForSelector('[data-testid="finish-smart-plaque-nfc"]', { timeout: 15000 });
    await page.click('[data-testid="finish-smart-plaque-nfc"]');
    await page.waitForSelector('[data-testid="smart-plaque-done-step"]');

    const rawKeys = await page.evaluate(
      () => (document.body.textContent || '').match(/SMART_PLAQUES\.[A-Z0-9_]+/g) || [],
    );
    if (rawKeys.length) throw new Error(`Untranslated smart-plaque keys: ${rawKeys.join(', ')}`);

    console.log('5. Permanent /p URL resolves to the currently assigned menu');
    const publicPage = await browser.newPage();
    await publicPage.goto(publicUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    await publicPage.waitForFunction(() => window.location.pathname.startsWith('/menu/'), { timeout: 15000 });
    const resolvedPath = await publicPage.evaluate(() => window.location.pathname);
    if (!resolvedPath.startsWith('/menu/')) throw new Error('Permanent plaque did not resolve to a menu');
    await publicPage.close();

    console.log('OK: inventory, assignment, NFC verification, and permanent public resolution');
  } finally {
    if (tenantCreated) {
      const purge = await api(page, '/tenant/purge', {
        method: 'POST',
        body: JSON.stringify({ confirm_tenant_name: restaurantName }),
      });
      if (purge.status === 200) console.log('OK: exact smart-plaque smoke tenant removed');
      else console.error(`WARN: tenant cleanup failed (${purge.status}): ${JSON.stringify(purge.body)}`);
    }
    if (plaqueId != null) {
      let cleanupContext;
      try {
        cleanupContext = await browser.createBrowserContext();
        const cleanupPage = await cleanupContext.newPage();
        await login(cleanupPage, '/platform/login', OPERATOR_EMAIL, OPERATOR_PASSWORD);
        await cleanupPage.waitForFunction(() => window.location.pathname === '/platform', { timeout: 15000 });
        const removed = await api(cleanupPage, `/platform/smart-plaques/${plaqueId}`, { method: 'DELETE' });
        if (removed.status === 200) console.log('OK: temporary smart plaque removed');
        else console.error(`WARN: plaque cleanup failed (${removed.status}): ${JSON.stringify(removed.body)}`);
      } catch (error) {
        console.error(`WARN: plaque cleanup failed: ${error.message}`);
      } finally {
        await cleanupContext?.close();
      }
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error('FAIL:', error.message || error);
  process.exit(1);
});
