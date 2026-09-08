import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

// Read-only discovery, not registration/reservation or module acceptance.
const base = new URL(process.env.BASE_URL || 'http://haproxy:4202');
const browser = await puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 844 });
    let errors = 0;
    let mutations = 0;
    page.on('pageerror', () => { errors++; });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === base.origin && url.pathname.startsWith('/api/')
          && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        mutations++;
        void request.abort();
      } else void request.continue();
    });
    for (const [path, selector] of [
      ['/customer/login', '[data-testid="customer-login-form"]'],
      ['/customer/register', '[data-testid="customer-register-form"]'],
      ['/book/1', '.book-form'],
    ]) {
      const response = await page.goto(new URL(path, base).href, {
        waitUntil: 'networkidle2', timeout: 30000,
      });
      assert(response?.ok(), `HTTP failure: ${path}`);
      assert.equal(new URL(page.url()).pathname, path, 'Unexpected route redirect');
      await page.waitForSelector(selector, { visible: true, timeout: 15000 });
      assert.equal(errors, 0, 'Browser runtime errors');
      assert.equal(mutations, 0, 'Unexpected API mutation attempted; request blocked');
      console.log(`PASS entry form ${path} at ${width}px`);
    }
    await page.close();
  }
  console.log('PASS read-only entrypoints; no forms submitted. Full module acceptance remains open.');
} finally {
  await browser.close();
}
