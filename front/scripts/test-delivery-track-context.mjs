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
  for (const [path, expected] of [
    ['/delivery/23/track', '/delivery/23'],
    ['/delivery/23/track?order_id=1', '/delivery/23'],
    ['/delivery/23/track?public_order_token=invalid', '/delivery/23'],
    ['/delivery/0/track', null],
  ]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    let errors = 0;
    page.on('pageerror', () => { errors++; });
    await page.goto(new URL(path, base).href, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('.delivery-track-page .error', { visible: true });
    const links = await page.$$eval('.delivery-track-page a', elements =>
      elements.map(element => new URL(element.href).pathname));
    assert.deepEqual(links, expected ? [expected] : [], `Incorrect fallback for ${path}`);
    assert.equal(await page.$('[data-testid="delivery-track-status"]'), null, 'Unexpected order data');
    assert.equal(errors, 0, 'Browser runtime error');
    console.log(`PASS tracking fallback ${path}`);
    await context.close();
  }
} finally {
  await browser.close();
}
