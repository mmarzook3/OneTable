import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

assert(process.env.BASE_URL, 'Explicit BASE_URL required');
const base = new URL(process.env.BASE_URL);
const browser = await puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
try {
  for (const width of [390, 1280]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width, height: 844 });
    const staffMutations = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (['/api/refresh', '/api/logout'].includes(path)) staffMutations.push(path);
    });
    await page.goto(new URL('/customer', base).href, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('[data-testid="customer-login-form"]', { visible: true });
    assert.equal(new URL(page.url()).pathname, '/customer/login');
    assert.deepEqual(staffMutations, [], 'Customer auth failure must not refresh/logout staff');
    console.log(`PASS unauthenticated customer portal at ${width}px; no staff session mutation`);
    await context.close();
  }
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(new URL('/staff/orders', base).href, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('input[type="email"]', { visible: true });
  assert.equal(new URL(page.url()).pathname, '/login', 'Staff guard must retain staff login');
  console.log('PASS unauthenticated staff portal retains staff login');
  await context.close();
} finally {
  await browser.close();
}
